//! A cold-signed action that fails can be relayed again later, and a deadline
//! is what stops that.
//!
//! First the hazard. The cold key signs a transfer the PDA cannot afford. The
//! relay fails and rolls back completely, the nonce included, so the signed
//! authorization is still valid: once the PDA is funded, the same bytes land.
//! A durable nonce transaction would have burned its nonce on the first try.
//!
//! Then the fix. The cold key signs a second transfer with a deadline, an
//! instruction that fails after a given slot. Relayed after that slot, it is
//! rejected, and it always will be.
//!
//! Run with `just failed-attempt`.

use anyhow::{bail, Result};
use psigner::cluster::{assert_programs_deployed, client, funded_keypair, send_transaction};
use psigner::lighthouse;
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::error::SystemError;
use solana_system_interface::instruction as system_instruction;
use solana_transaction_error::TransactionError;
use spl_ed25519_signer_client::signing::sign_and_submit;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;
use std::thread::sleep;
use std::time::Duration;

const AMOUNT: u64 = 10_000_000;
/// How many slots after signing the second action stays valid.
const DEADLINE_SLOTS: u64 = 20;

fn main() -> Result<()> {
    let client = client();
    assert_programs_deployed(&client)?;

    let relayer = funded_keypair(&client, 2_000_000_000)?;
    let recipient = Keypair::new().pubkey();
    let authority = Keypair::new();
    let pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &authority.pubkey());
    let nonce_account = create_nonce_account(&client, &relayer, &pda)?;
    let nonce = fetch_nonce(&client, &nonce_account)?.nonce;

    println!("== setup: the PDA holds nothing ==");
    println!("  authority:     {} (cold)", authority.pubkey());
    println!("  pda:           {pda} (unfunded)");
    println!("  nonce account: {nonce_account}");
    println!("  nonce:         {nonce}");

    // The cold key signs a transfer out of the PDA. Signing needs no funds and
    // no RPC, so nothing stops it from signing an action that cannot succeed
    // yet.
    println!("\n== signing on the cold side ==");
    let transfer = system_instruction::transfer(&pda, &recipient, AMOUNT);
    let execution = execution_message(&pda, &[transfer], nonce)?;
    let submit = [sign_and_submit(
        &execute(&nonce_account, &pda, &execution),
        &[&authority],
    )?];
    let next_nonce_value = next_nonce(&nonce_account, &execution);
    println!("  action:     transfer {AMOUNT} lamports from the PDA");
    println!("  next nonce: {next_nonce_value}");

    // The transfer fails inside the System program, and the whole relay rolls
    // back with it. The nonce is part of that: it has not moved.
    println!("\n== relayed while the PDA is unfunded ==");
    expect_rejected(
        send_transaction(&client, &relayer, &submit, &[&relayer]),
        SystemError::ResultWithNegativeLamports as u32,
        "the System program's insufficient funds error",
    )?;
    let unchanged = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after: {unchanged} (unchanged)");
    if unchanged != nonce {
        bail!("the nonce moved although the relay failed");
    }

    // The hazard. Nothing was signed again: these are the same bytes, sent
    // after the PDA was funded. Anyone who kept them could do this, at any
    // later time.
    println!("\n== relayed again after the PDA is funded ==");
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
    let landed = send_transaction(&client, &relayer, &submit, &[&relayer])?;
    println!("  landed:            {landed}");
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports");
    if balance != AMOUNT {
        bail!("expected the recipient to hold {AMOUNT} lamports");
    }
    let advanced = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after:       {advanced}");
    println!("  expected:          {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }

    // The fix. The second action starts with a Lighthouse instruction that
    // fails once the slot is past the deadline. It is inside the execution
    // message, so the cold key's signature covers it and a relayer cannot
    // remove or change it.
    println!("\n== signing a second action with a deadline ==");
    let deadline = client.get_slot()? + DEADLINE_SLOTS;
    let execution = execution_message(
        &pda,
        &[
            lighthouse::assert_slot_at_most(deadline),
            system_instruction::transfer(&pda, &recipient, AMOUNT),
        ],
        advanced,
    )?;
    let submit = [sign_and_submit(
        &execute(&nonce_account, &pda, &execution),
        &[&authority],
    )?];
    println!("  action:   transfer {AMOUNT} lamports from the PDA");
    println!("  deadline: slot {deadline} ({DEADLINE_SLOTS} slots from now)");

    // Hold the authorization back until the deadline has passed. The PDA has
    // the funds this time; only the deadline is in the way.
    println!("\n== relayed after the deadline ==");
    while client.get_slot()? <= deadline {
        sleep(Duration::from_millis(400));
    }
    println!("  slot:        {}", client.get_slot()?);
    expect_rejected(
        send_transaction(&client, &relayer, &submit, &[&relayer]),
        lighthouse::ASSERTION_FAILED,
        "Lighthouse's AssertionFailed",
    )?;
    let balance = client.get_balance(&recipient)?;
    if balance != AMOUNT {
        bail!("the expired action moved funds");
    }
    // The nonce did not move, so the cold key can sign a replacement over it.
    let unchanged = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after: {unchanged} (unchanged; a new action can use it)");
    if unchanged != advanced {
        bail!("the nonce moved although the relay failed");
    }
    Ok(())
}

/// Fails unless a relay was rejected with the custom program error `code`.
fn expect_rejected(relay: Result<Signature>, code: u32, name: &str) -> Result<()> {
    let error = match relay {
        Ok(signature) => bail!("expected {name}, but the relay landed as {signature}"),
        Err(error) => error,
    };
    let rejection = error
        .downcast_ref::<ClientError>()
        .and_then(ClientError::get_transaction_error);
    match rejection {
        Some(TransactionError::InstructionError(_, InstructionError::Custom(found)))
            if found == code =>
        {
            println!("  rejected: custom program error {found} ({name})");
            Ok(())
        }
        _ => Err(error.context(format!("expected {name}"))),
    }
}
