//! Signs several actions at once, and relays them in any order.
//!
//! A nonce account holds one nonce value, and an action uses that value up.
//! So two actions signed over the same nonce account can only land one after
//! the other, in the order they were signed.
//!
//! To have actions that land independently, give each one its own nonce
//! account. One PDA can be the authority of any number of them. Here the cold
//! key signs three transfers in one session, each over its own nonce account,
//! and the hot key relays them in a different order.
//!
//! Run with `just parallel`.

use anyhow::{bail, Result};
use psigner::cluster::{assert_programs_deployed, client, funded_keypair, send_transaction};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use spl_ed25519_signer_client::signing::sign_and_submit;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;

/// What each of the three actions transfers.
const AMOUNTS: [u64; 3] = [10_000_000, 20_000_000, 30_000_000];
/// The order the actions are relayed in: the third, then the first, then the
/// second.
const RELAY_ORDER: [usize; 3] = [2, 0, 1];

fn main() -> Result<()> {
    let client = client();
    assert_programs_deployed(&client)?;

    let relayer = funded_keypair(&client, 2_000_000_000)?;
    let recipient = Keypair::new().pubkey();
    let authority = Keypair::new();
    let pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &authority.pubkey());
    send_transaction(
        &client,
        &relayer,
        &[system_instruction::transfer(
            &relayer.pubkey(),
            &pda,
            1_000_000_000,
        )],
        &[&relayer],
    )?;

    println!("== setup: one PDA, three nonce accounts ==");
    println!("  authority: {} (cold)", authority.pubkey());
    println!("  pda:       {pda} (holds the funds)");
    // Create one nonce account per action. The relayer pays their rent. The
    // PDA is the authority of all three, so only the cold key can use them.
    let mut nonce_accounts = Vec::new();
    for _ in AMOUNTS {
        let nonce_account = create_nonce_account(&client, &relayer, &pda)?;
        println!("  nonce account: {nonce_account}");
        nonce_accounts.push(nonce_account);
    }

    // The cold key signs all three transfers in one session. Each transfer
    // names a different nonce account, so none of them depends on another.
    println!("\n== signing on the cold side ==");
    let mut actions = Vec::new();
    for (nonce_account, amount) in nonce_accounts.iter().zip(AMOUNTS) {
        let nonce = fetch_nonce(&client, nonce_account)?.nonce;
        let transfer = system_instruction::transfer(&pda, &recipient, amount);
        let execution = execution_message(&pda, &[transfer], nonce)?;
        let submit = sign_and_submit(&execute(nonce_account, &pda, &execution), &[&authority])?;
        let next_nonce_value = next_nonce(nonce_account, &execution);
        println!("  action: transfer {amount} lamports, over {nonce_account}");
        actions.push((submit, next_nonce_value));
    }

    // The hot side relays them in a different order from the one they were
    // signed in. Each one lands, because each uses its own nonce account.
    println!("\n== relayed out of order ==");
    for index in RELAY_ORDER {
        let (submit, _) = &actions[index];
        let landed =
            send_transaction(&client, &relayer, std::slice::from_ref(submit), &[&relayer])?;
        println!("  transfer of {} lamports landed: {landed}", AMOUNTS[index]);
    }

    println!("\n== read back ==");
    let balance = client.get_balance(&recipient)?;
    let total: u64 = AMOUNTS.iter().sum();
    println!("  recipient balance: {balance} lamports (all three transfers)");
    if balance != total {
        bail!("expected the recipient to hold {total} lamports");
    }
    // Each nonce account advanced once, to the value computed when its action
    // was signed.
    for (nonce_account, (_, next_nonce_value)) in nonce_accounts.iter().zip(&actions) {
        let advanced = fetch_nonce(&client, nonce_account)?.nonce;
        println!("  {nonce_account} nonce: {advanced}");
        if advanced != *next_nonce_value {
            bail!("the nonce did not advance to the value computed at signing time");
        }
    }
    Ok(())
}
