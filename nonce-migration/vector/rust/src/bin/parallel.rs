//! Signs several actions at once, and relays them in any order.
//!
//! A vector account holds one nonce value, and an action uses that value up.
//! So two actions signed over the vector account's own nonce can only land
//! one after the other, in the order they were signed.
//!
//! To have actions that land independently, Vector has nonce accounts. A
//! nonce account is a separate small account that holds a nonce of its own.
//! The same cold key signs over it, and the funds stay where they are. Here
//! the cold key signs three transfers in one session, each over its own nonce
//! account, and the hot key relays them in a different order.
//!
//! Run with `just parallel`.

use anyhow::{bail, Result};
use ed25519_dalek::{Signer as Ed25519Signer, SigningKey};
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use std::thread::sleep;
use std::time::Duration;
use vector_core::{
    advance_message, create_initialize_ed25519, create_initialize_nonce_instruction,
    create_multi_advance_instruction, create_system_passthrough_instruction, ed25519_pubkey,
    find_system_pda, find_vector_pda, signed, signed_nonce, signer_digest, AdvanceSigner,
    NonceAccount, ED25519, NEVER_EXPIRES, PROGRAM_ID,
};
use vector_examples::cluster::{assert_program_deployed, client, funded_keypair, send_transaction};
use vector_examples::vector::{fetch_nonce, fetch_nonce_account};

/// What each of the three actions transfers.
const AMOUNTS: [u64; 3] = [10_000_000, 20_000_000, 30_000_000];
/// The order the actions are relayed in: the third, then the first, then the
/// second.
const RELAY_ORDER: [usize; 3] = [2, 0, 1];

fn main() -> Result<()> {
    let client = client();
    assert_program_deployed(&client)?;

    let relayer = funded_keypair(&client, 2_000_000_000)?;
    let recipient = Keypair::new().pubkey();
    let signer = Keypair::new();
    let signing_key = SigningKey::from_bytes(signer.secret_bytes());
    let identity = ed25519_pubkey(&signing_key);
    let (vector, _) = find_vector_pda(&ED25519, &identity);
    let (system_pda, _) = find_system_pda(&vector);
    send_transaction(
        &client,
        &relayer,
        &[
            create_initialize_ed25519(&relayer.pubkey(), &identity),
            system_instruction::transfer(&relayer.pubkey(), &system_pda, 1_000_000_000),
        ],
        &[&relayer],
    )?;

    println!("== setup: one vector account, three nonce accounts ==");
    println!("  cold key:       {}", signer.pubkey());
    println!("  vector account: {vector}");
    println!("  system PDA:     {system_pda} (holds the funds)");
    // Create one nonce account per action. A nonce account is an ordinary
    // account with its own keypair. It is created with the System program,
    // handed to the Vector program, and then initialized for one vector
    // account. The new account's key signs both steps. The relayer pays the
    // rent. Only the vector account's cold key can sign over the nonce
    // account afterwards.
    let rent = client.get_minimum_balance_for_rent_exemption(NonceAccount::LEN)?;
    let mut nonce_accounts = Vec::new();
    for _ in AMOUNTS {
        let nonce_account = Keypair::new();
        send_transaction(
            &client,
            &relayer,
            &[
                system_instruction::create_account(
                    &relayer.pubkey(),
                    &nonce_account.pubkey(),
                    rent,
                    NonceAccount::LEN as u64,
                    &PROGRAM_ID,
                ),
                create_initialize_nonce_instruction(&nonce_account.pubkey(), &vector),
            ],
            &[&relayer, &nonce_account],
        )?;
        println!("  nonce account:  {}", nonce_account.pubkey());
        nonce_accounts.push(nonce_account.pubkey());
    }
    // A nonce account cannot be used in the slot it was created in. Wait for
    // the next slot before going on.
    let created = client.get_slot()?;
    while client.get_slot()? <= created {
        sleep(Duration::from_millis(400));
    }

    // The cold key signs all three transfers in one session. Each transfer
    // names a different nonce account, so none of them depends on another.
    //
    // Signing over a nonce account takes the same three steps as any Advance:
    //   1. build the message, with the nonce account listed after the vector
    //      account;
    //   2. compute this account's digest of the message, and sign it. The
    //      nonce that goes into the digest is a hash of the nonce account's
    //      nonce and the vector account's own nonce;
    //   3. put the signature into an Advance instruction.
    println!("\n== signing on the cold side ==");
    let vector_nonce = fetch_nonce(&client, &vector)?;
    let mut actions = Vec::new();
    for (nonce_account, amount) in nonce_accounts.iter().zip(AMOUNTS) {
        let nonce = fetch_nonce_account(&client, nonce_account)?;
        let transfer = system_instruction::transfer(&system_pda, &recipient, amount);
        let passthrough = create_system_passthrough_instruction(&ED25519, &identity, &[transfer]);
        let advance_signer = AdvanceSigner {
            nonce_account: Some(*nonce_account),
            ..AdvanceSigner::new(&ED25519, &identity)
        };
        let message = advance_message(
            NEVER_EXPIRES,
            &[advance_signer],
            &[],
            std::slice::from_ref(&passthrough),
            None,
        );
        let digest = signer_digest(
            &message,
            &signed_nonce(nonce.as_bytes(), vector_nonce.as_bytes()),
            &vector,
            &[],
        );
        let signature = signing_key.sign(&signed(&digest)).to_bytes();
        let advance =
            create_multi_advance_instruction(NEVER_EXPIRES, &[(advance_signer, &signature)]);
        println!("  action: transfer {amount} lamports, over {nonce_account}");
        // The digest is also the value the nonce account moves to.
        actions.push(([advance, passthrough], Hash::new_from_array(digest)));
    }

    // The hot side relays them in a different order from the one they were
    // signed in. Each one lands, because each uses its own nonce account.
    println!("\n== relayed out of order ==");
    for index in RELAY_ORDER {
        let (instructions, _) = &actions[index];
        let landed = send_transaction(&client, &relayer, instructions, &[&relayer])?;
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
        let advanced = fetch_nonce_account(&client, nonce_account)?;
        println!("  {nonce_account} nonce: {advanced}");
        if advanced != *next_nonce_value {
            bail!("the nonce did not advance to the value computed at signing time");
        }
    }
    // The vector account's own nonce was not used, so it has not moved.
    let unchanged = fetch_nonce(&client, &vector)?;
    println!("  vector account nonce: {unchanged} (unchanged)");
    if unchanged != vector_nonce {
        bail!("the vector account's own nonce moved");
    }
    Ok(())
}
