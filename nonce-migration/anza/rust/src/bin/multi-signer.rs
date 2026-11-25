//! Two cold approvers sign one token withdrawal on separate machines, and a
//! hot key relays it once it holds both signatures.
//!
//! Each cold key has its own PDA. The tokens belong to a Token program
//! multisig whose two signers are those PDAs, so neither approver can move
//! them alone. Both keys sign the same authorization message; relaying with one
//! signature is rejected, and relaying with both lands.
//!
//! Run with `just multi-signer`.

use anyhow::{bail, Context, Result};
use psigner::cluster::{
    assert_programs_deployed, client, compute_units, funded_keypair, send_transaction,
};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use psigner::token::{create_mint, fetch_balance, mint_to_ata, ui_amount, DECIMALS};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_program_pack::Pack;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction_error::TransactionError;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_ed25519_signer_client::instruction::submit;
use spl_ed25519_signer_client::message::authorization_message;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_ed25519_signer_interface::error::Error as SignerError;
use spl_message_executor_client::instruction::execute;
use spl_token_interface::instruction::{initialize_multisig2, transfer_checked};
use spl_token_interface::state::Multisig;
use spl_token_interface::ID as TOKEN_PROGRAM;

/// 1,000 tokens at six decimals: what the multisig holds.
const SUPPLY: u64 = 1_000_000_000;
/// 250 tokens: what the withdrawal moves.
const AMOUNT: u64 = 250_000_000;

fn main() -> Result<()> {
    let client = client();
    assert_programs_deployed(&client)?;

    let relayer = funded_keypair(&client, 5_000_000_000)?;
    let first = Keypair::new();
    let second = Keypair::new();
    let first_pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &first.pubkey());
    let second_pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &second.pubkey());
    let recipient = Keypair::new().pubkey();

    println!("== setup: a 2-of-2 multisig holds 1,000 tokens ==");
    println!("  first approver:  {} (cold)", first.pubkey());
    println!("  its pda:         {first_pda}");
    println!("  second approver: {} (cold)", second.pubkey());
    println!("  its pda:         {second_pda}");

    // Create the 2-of-2 multisig: a Token program account that lists both PDAs
    // as signers with a threshold of 2. The relayer pays its rent. Creating it
    // needs no cold signature, because the PDAs are only recorded as signers
    // here; they sign later, when tokens are withdrawn.
    let multisig = Keypair::new();
    let rent = client.get_minimum_balance_for_rent_exemption(Multisig::LEN)?;
    send_transaction(
        &client,
        &relayer,
        &[
            system_instruction::create_account(
                &relayer.pubkey(),
                &multisig.pubkey(),
                rent,
                Multisig::LEN as u64,
                &TOKEN_PROGRAM,
            ),
            initialize_multisig2(
                &TOKEN_PROGRAM,
                &multisig.pubkey(),
                &[&first_pda, &second_pda],
                2,
            )?,
        ],
        &[&relayer, &multisig],
    )
    .context("failed to create the multisig")?;
    let multisig = multisig.pubkey();
    let mint = create_mint(&client, &relayer)?;
    let multisig_account = mint_to_ata(&client, &relayer, &mint, &multisig, SUPPLY)?;
    let recipient_account = get_associated_token_address(&recipient, &mint);
    send_transaction(
        &client,
        &relayer,
        &[create_associated_token_account_idempotent(
            &relayer.pubkey(),
            &recipient,
            &mint,
            &TOKEN_PROGRAM,
        )],
        &[&relayer],
    )?;
    println!("  multisig:        {multisig} (needs both PDAs)");
    println!(
        "  its account:     {multisig_account} holds {}",
        ui_amount(fetch_balance(&client, &multisig_account)?)
    );

    // The withdrawal needs one nonce account, as every action does. A nonce
    // account has a single authority, so one of the two PDAs has to be chosen;
    // this uses the first.
    let nonce_account = create_nonce_account(&client, &relayer, &first_pda)?;
    let nonce = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce account:   {nonce_account}");
    println!("  nonce:           {nonce}");

    // Build the message the approvers will sign. This happens once, on any
    // machine, and needs no key:
    //   1. the action: a TransferChecked out of the multisig's token account,
    //      with both PDAs as its signers;
    //   2. the execution message that holds the action;
    //   3. the Execute instruction that holds the execution message;
    //   4. the authorization message that holds the Execute instruction and
    //      lists both cold keys as required signers.
    println!("\n== the authorization message both approvers sign ==");
    let transfer = transfer_checked(
        &TOKEN_PROGRAM,
        &multisig_account,
        &mint,
        &recipient_account,
        &multisig,
        &[&first_pda, &second_pda],
        AMOUNT,
        DECIMALS,
    )?;
    let execution = execution_message(&first_pda, &[transfer], nonce)?;
    let wrapped = execute(&nonce_account, &first_pda, &execution);
    let authorization = authorization_message(&wrapped, &[first.pubkey(), second.pubkey()])?;
    let next_nonce_value = next_nonce(&nonce_account, &execution);
    let bytes = authorization.serialize();
    println!(
        "  authorization message: {} bytes, {} required signers",
        bytes.len(),
        authorization.header.num_required_signatures
    );

    // Each approver signs the authorization message's bytes on its own
    // machine. The two signatures are independent of each other, so the
    // approvers can sign in any order. Here the second one signs first.
    println!("\n== signing on each cold side ==");
    let second_signature = second.sign_message(&bytes);
    println!("  second approver: {second_signature}");
    let first_signature = first.sign_message(&bytes);
    println!("  first approver:  {first_signature}");

    // The hot side. First relay with only the first approver's signature. The
    // Signer program rejects it, because the authorization message lists two
    // required signers and one of them has not signed.
    println!("\n== relayed with one signature ==");
    let partial = signatures(&authorization, &[(&first, first_signature)])?;
    expect_missing_signature(send_transaction(
        &client,
        &relayer,
        &[submit(partial, VersionedMessage::V1(authorization.clone()))],
        &[&relayer],
    ))?;

    println!("\n== relayed with both ==");
    let both = signatures(
        &authorization,
        &[(&second, second_signature), (&first, first_signature)],
    )?;
    let landed = send_transaction(
        &client,
        &relayer,
        &[submit(both, VersionedMessage::V1(authorization.clone()))],
        &[&relayer],
    )?;
    println!("  landed:        {landed}");
    if let Some(units) = compute_units(&client, &landed)? {
        println!("  compute units: {units}");
    }

    println!("\n== read back ==");
    let received = fetch_balance(&client, &recipient_account)?;
    println!(
        "  recipient account: {recipient_account} holds {}",
        ui_amount(received)
    );
    if received != AMOUNT {
        bail!("expected the recipient to hold {AMOUNT}");
    }
    let left = fetch_balance(&client, &multisig_account)?;
    println!("  multisig account:  holds {}", ui_amount(left));
    if left != SUPPLY - AMOUNT {
        bail!("expected the multisig to hold {}", SUPPLY - AMOUNT);
    }
    let advanced = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after:       {advanced}");
    println!("  expected:          {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }
    Ok(())
}

/// Arranges the collected signatures the way `Submit` expects them.
///
/// `Submit` takes a list with one entry per required signer of the
/// authorization message, in the order the message lists those signers. This
/// looks up each approver's position in the message and puts its signature
/// there. A signer with no collected signature gets `None`.
///
/// Hand-written, and should ideally be provided by the upstream client. The
/// crate's `sign_and_submit` does this ordering, but only when all the keys
/// sign together in one process.
fn signatures(
    authorization: &v1::Message,
    collected: &[(&Keypair, Signature)],
) -> Result<Vec<Option<Signature>>> {
    let required = usize::from(authorization.header.num_required_signatures);
    let mut slots = vec![None; required];
    for (approver, signature) in collected {
        let slot = authorization.account_keys[..required]
            .iter()
            .position(|key| *key == approver.pubkey())
            .context("the approver is not a signer of the authorization message")?;
        slots[slot] = Some(*signature);
    }
    Ok(slots)
}

/// Fails unless a relay was rejected with the Signer's `MissingSignature`.
fn expect_missing_signature(relay: Result<Signature>) -> Result<()> {
    let error = match relay {
        Ok(signature) => bail!("expected MissingSignature, but the relay landed as {signature}"),
        Err(error) => error,
    };
    let rejection = error
        .downcast_ref::<ClientError>()
        .and_then(ClientError::get_transaction_error);
    match rejection {
        Some(TransactionError::InstructionError(_, InstructionError::Custom(code)))
            if code == SignerError::MissingSignature as u32 =>
        {
            println!("  rejected: custom program error {code} (the Signer's MissingSignature)");
            Ok(())
        }
        _ => Err(error.context("expected the Signer's MissingSignature")),
    }
}
