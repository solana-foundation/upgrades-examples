//! Moves everything a cold key controls to its programmatic signer PDA, then
//! uses the PDA to act on each of them.
//!
//! Before: the cold key holds SOL and tokens, is the mint and freeze authority
//! of a mint, and is the staker, withdrawer, and lockup custodian of a stake
//! account.
//!
//! The migration is one transaction. It is the last durable nonce transaction
//! the cold key signs.
//!
//! The migration is "checked": the old owner and the new owner both have to
//! sign it. The old owner is the cold key. The new owner is the PDA, and the
//! cold key approves on its behalf with an authorization inside the same
//! transaction. So if the PDA could not act, the migration would fail and
//! nothing would move. This is how the upstream docs say to migrate.
//!
//! After: the cold key signs one authorization, and the PDA spends SOL, sends
//! tokens, mints, freezes an account, and withdraws from the locked stake.
//!
//! Run with `just migrate`.

use anyhow::{bail, Context, Result};
use psigner::cluster::{
    assert_programs_deployed, client, compute_units, funded_keypair, send_transaction,
};
use psigner::durable_nonce::{create_durable_nonce_account, fetch_durable_nonce};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use psigner::token::{
    create_mint, fetch_balance, mint_to_ata, transfer_to_ata, ui_amount, DECIMALS,
};
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_program_pack::Pack;
use solana_signer::Signer;
use solana_stake_interface::instruction::{self as stake_instruction, LockupArgs};
use solana_stake_interface::state::{Authorized, Lockup, StakeAuthorize, StakeStateV2};
use solana_system_interface::instruction as system_instruction;
use solana_transaction::versioned::VersionedTransaction;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_ed25519_signer_client::signing::sign_and_submit;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;
use spl_token_interface::instruction::{
    freeze_account, mint_to_checked, set_authority, transfer_checked, AuthorityType,
};
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};
use spl_token_interface::ID as TOKEN_PROGRAM;

/// What the cold key holds before the migration.
const COLD_SOL: u64 = 5_000_000_000;
const COLD_TOKENS: u64 = 1_000_000_000;
const STAKED: u64 = 1_000_000_000;
/// What the migration moves to the PDA.
const MIGRATED_SOL: u64 = 2_000_000_000;
/// What the PDA does afterwards.
const SENT_SOL: u64 = 10_000_000;
const SENT_TOKENS: u64 = 250_000_000;
const MINTED_TOKENS: u64 = 100_000_000;
const WITHDRAWN_STAKE: u64 = 500_000_000;
/// When the stake account's lockup ends: the year 2100.
const LOCKED_UNTIL: i64 = 4_102_444_800;

/// The budget of the migration transaction. It runs eight instructions in
/// four programs under the Signer and the Executor.
const MIGRATION_CONFIG: v1::TransactionConfig = v1::TransactionConfig::empty()
    .with_compute_unit_limit(400_000)
    .with_loaded_accounts_data_size_limit(8 * 1024 * 1024);

fn main() -> Result<()> {
    let client = client();
    assert_programs_deployed(&client)?;

    let relayer = funded_keypair(&client, 5_000_000_000)?;
    let recipient = Keypair::new().pubkey();

    // The starting point: a cold key that controls everything directly.
    println!("== before: the cold key controls everything ==");
    let cold = funded_keypair(&client, COLD_SOL)?;
    let pda = ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &cold.pubkey());

    // A mint whose mint authority and freeze authority are both the cold key,
    // and 1,000 of its tokens in the cold key's token account.
    let mint = create_mint(&client, &cold)?;
    let cold_tokens = mint_to_ata(&client, &cold, &mint, &cold.pubkey(), COLD_TOKENS)?;

    // A stake account holding 1 SOL. The cold key is its staker and its
    // withdrawer. The account is locked until the year 2100. The cold key is
    // also the lockup's custodian: the one party that can still act while the
    // account is locked.
    let stake = Keypair::new();
    let stake_rent = client.get_minimum_balance_for_rent_exemption(StakeStateV2::size_of())?;
    send_transaction(
        &client,
        &cold,
        &stake_instruction::create_account(
            &cold.pubkey(),
            &stake.pubkey(),
            &Authorized {
                staker: cold.pubkey(),
                withdrawer: cold.pubkey(),
            },
            &Lockup {
                unix_timestamp: LOCKED_UNTIL,
                epoch: 0,
                custodian: cold.pubkey(),
            },
            stake_rent + STAKED,
        ),
        &[&cold, &stake],
    )
    .context("failed to create the stake account")?;
    let stake = stake.pubkey();

    println!("  cold key:      {}", cold.pubkey());
    println!(
        "  SOL:           {} lamports",
        client.get_balance(&cold.pubkey())?
    );
    println!(
        "  tokens:        {} in {cold_tokens}",
        ui_amount(fetch_balance(&client, &cold_tokens)?)
    );
    println!("  mint:          {mint} (mint and freeze authority)");
    println!("  stake account: {stake} (staker, withdrawer, lockup custodian)");

    // The migration needs two nonce accounts.
    //
    // The first is a System nonce account, the kind the cold key already uses
    // for durable nonce transactions. The migration transaction uses it.
    //
    // The second is an SPL nonce account that belongs to the PDA. The
    // authorization inside the migration uses it. Everything the PDA does
    // afterwards uses it too.
    let durable_nonce_account = create_durable_nonce_account(&client, &cold)?;
    let nonce_account = create_nonce_account(&client, &relayer, &pda)?;
    println!("  pda:           {pda} (the new owner; holds nothing yet)");

    // Build the migration. Every instruction hands one thing from the cold
    // key to the PDA. They all go into one execution message, so they all
    // happen or none do.
    println!("\n== signing the migration on the cold side ==");
    let pda_tokens = get_associated_token_address(&pda, &mint);
    let handover = [
        // Move SOL from the cold key to the PDA.
        system_instruction::transfer(&cold.pubkey(), &pda, MIGRATED_SOL),
        // Tokens: create the PDA's token account, then move the balance.
        create_associated_token_account_idempotent(&cold.pubkey(), &pda, &mint, &TOKEN_PROGRAM),
        transfer_checked(
            &TOKEN_PROGRAM,
            &cold_tokens,
            &mint,
            &pda_tokens,
            &cold.pubkey(),
            &[],
            COLD_TOKENS,
            DECIMALS,
        )?,
        // The mint: its mint authority and its freeze authority.
        set_authority(
            &TOKEN_PROGRAM,
            &mint,
            Some(&pda),
            AuthorityType::MintTokens,
            &cold.pubkey(),
            &[],
        )?,
        set_authority(
            &TOKEN_PROGRAM,
            &mint,
            Some(&pda),
            AuthorityType::FreezeAccount,
            &cold.pubkey(),
            &[],
        )?,
        // The stake account. First the staker, then the withdrawer. While a
        // lockup is in force, changing the withdrawer also needs the custodian
        // to sign. The custodian is still the cold key at this point. These
        // are the "checked" instructions, which need the new authority to sign
        // as well.
        stake_instruction::authorize_checked(
            &stake,
            &cold.pubkey(),
            &pda,
            StakeAuthorize::Staker,
            None,
        ),
        stake_instruction::authorize_checked(
            &stake,
            &cold.pubkey(),
            &pda,
            StakeAuthorize::Withdrawer,
            Some(&cold.pubkey()),
        ),
        // Last, the lockup's custodian. It has to come last, because the
        // instruction above needed the cold key to still be the custodian.
        stake_instruction::set_lockup_checked(
            &stake,
            &LockupArgs {
                unix_timestamp: None,
                epoch: None,
                custodian: Some(pda),
            },
            &cold.pubkey(),
        ),
    ];

    // The cold key signs twice, both offline.
    //
    // First, as the new owner. It signs an authorization for the execution
    // message, which is what lets the PDA sign the instructions that need the
    // new authority.
    let nonce = fetch_nonce(&client, &nonce_account)?.nonce;
    let migration = execution_message(&pda, &handover, nonce)?;
    let mut submit = sign_and_submit(&execute(&nonce_account, &pda, &migration), &[&cold])?;
    // The instructions inside also need the cold key to sign, as the old
    // owner. It does that by signing the transaction below. For that signature
    // to reach the instructions inside, the cold key has to be marked as a
    // signer of the Submit instruction.
    for account in &mut submit.accounts {
        if account.pubkey == cold.pubkey() {
            account.is_signer = true;
        }
    }
    // Second, as the old owner. It signs a durable nonce transaction that
    // carries the Submit instruction. This is the old flow, used one last
    // time. `AdvanceNonceAccount` comes first, the nonce goes where the
    // blockhash would be, and the cold key pays the fee.
    let durable_nonce = fetch_durable_nonce(&client, &durable_nonce_account)?;
    let message = v1::Message::try_compile_with_config(
        &cold.pubkey(),
        &[
            system_instruction::advance_nonce_account(&durable_nonce_account, &cold.pubkey()),
            submit,
        ],
        durable_nonce,
        MIGRATION_CONFIG,
    )
    .context("failed to compile the migration transaction")?;
    let transaction = VersionedTransaction::try_new(VersionedMessage::V1(message), &[&cold])?;
    println!(
        "  execution message: {} instructions, {} bytes",
        handover.len(),
        migration.serialize().len()
    );
    println!("  signed by:         {} (the cold key)", cold.pubkey());

    // Send the migration transaction. The cold key has already signed it and
    // pays its fee, so no other signature is needed. Anyone can send it.
    println!("\n== relayed ==");
    let landed = client.send_and_confirm_transaction(&transaction)?;
    println!("  landed:        {landed}");
    if let Some(units) = compute_units(&client, &landed)? {
        println!("  compute units: {units}");
    }

    // Read each thing back and check that it now belongs to the PDA.
    println!("\n== after: the PDA controls everything ==");
    let pda_sol = client.get_balance(&pda)?;
    println!("  SOL:           {pda_sol} lamports");
    if pda_sol != MIGRATED_SOL {
        bail!("expected the PDA to hold {MIGRATED_SOL} lamports");
    }
    let moved = fetch_balance(&client, &pda_tokens)?;
    println!("  tokens:        {} in {pda_tokens}", ui_amount(moved));
    if moved != COLD_TOKENS || fetch_balance(&client, &cold_tokens)? != 0 {
        bail!("expected the PDA to hold all {COLD_TOKENS} tokens");
    }
    let mint_state = Mint::unpack(&client.get_account_data(&mint)?)?;
    println!("  mint:          mint and freeze authority are the PDA");
    if mint_state.mint_authority != Some(pda).into()
        || mint_state.freeze_authority != Some(pda).into()
    {
        bail!("expected the PDA to be the mint and freeze authority");
    }
    let stake_meta = client
        .get_account(&stake)?
        .deserialize_data::<StakeStateV2>()?
        .meta()
        .context("the stake account is not initialized")?;
    println!("  stake account: staker, withdrawer, and lockup custodian are the PDA");
    if stake_meta.authorized.staker != pda
        || stake_meta.authorized.withdrawer != pda
        || stake_meta.lockup.custodian != pda
    {
        bail!("expected the PDA to be the staker, withdrawer, and custodian");
    }

    // From here on the cold key signs authorizations, never transactions.
    // This one uses each thing that was migrated, to show the PDA really
    // controls it.
    println!("\n== using it: one authorization, relayed by a hot key ==");
    let recipient_tokens = get_associated_token_address(&recipient, &mint);
    let [create_recipient_tokens, send_tokens] =
        transfer_to_ata(&mint, &pda, &recipient, SENT_TOKENS)?;
    let actions = [
        // Spend SOL.
        system_instruction::transfer(&pda, &recipient, SENT_SOL),
        // Send tokens, creating the recipient's token account.
        create_recipient_tokens,
        send_tokens,
        // Mint new tokens, as the mint authority.
        mint_to_checked(
            &TOKEN_PROGRAM,
            &mint,
            &pda_tokens,
            &pda,
            &[],
            MINTED_TOKENS,
            DECIMALS,
        )?,
        // Freeze the recipient's token account, as the freeze authority.
        freeze_account(&TOKEN_PROGRAM, &recipient_tokens, &mint, &pda, &[])?,
        // Withdraw from the stake account, as the withdrawer. The lockup is
        // still in force, so the custodian has to sign too. The PDA is now the
        // custodian as well.
        stake_instruction::withdraw(&stake, &pda, &recipient, WITHDRAWN_STAKE, Some(&pda)),
    ];
    let nonce = fetch_nonce(&client, &nonce_account)?.nonce;
    let execution = execution_message(&pda, &actions, nonce)?;
    let submit = sign_and_submit(&execute(&nonce_account, &pda, &execution), &[&cold])?;
    let next_nonce_value = next_nonce(&nonce_account, &execution);
    let landed = send_transaction(&client, &relayer, &[submit], &[&relayer])?;
    println!("  landed:        {landed}");
    if let Some(units) = compute_units(&client, &landed)? {
        println!("  compute units: {units}");
    }

    println!("\n== read back ==");
    let received = client.get_balance(&recipient)?;
    println!("  recipient SOL:     {received} lamports (a transfer and a stake withdrawal)");
    if received != SENT_SOL + WITHDRAWN_STAKE {
        bail!(
            "expected the recipient to hold {} lamports",
            SENT_SOL + WITHDRAWN_STAKE
        );
    }
    let recipient_state = TokenAccount::unpack(&client.get_account_data(&recipient_tokens)?)?;
    println!(
        "  recipient tokens:  {}, frozen",
        ui_amount(recipient_state.amount)
    );
    if recipient_state.amount != SENT_TOKENS || recipient_state.state != AccountState::Frozen {
        bail!("expected the recipient to hold {SENT_TOKENS} frozen tokens");
    }
    let left = fetch_balance(&client, &pda_tokens)?;
    println!(
        "  PDA tokens:        {} (sent 250, minted 100)",
        ui_amount(left)
    );
    if left != COLD_TOKENS - SENT_TOKENS + MINTED_TOKENS {
        bail!("unexpected PDA token balance");
    }
    let staked = client.get_balance(&stake)?;
    println!("  stake account:     {staked} lamports");
    if staked != stake_rent + STAKED - WITHDRAWN_STAKE {
        bail!("unexpected stake account balance");
    }
    let advanced = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after:       {advanced}");
    println!("  expected:          {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }
    Ok(())
}
