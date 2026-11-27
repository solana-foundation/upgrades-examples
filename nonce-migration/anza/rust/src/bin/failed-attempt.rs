//! A cold-signed action that fails can be relayed again later. A deadline
//! limits how long that stays possible.
//!
//! First the retry. The cold key signs a transfer the PDA cannot afford. The
//! relay lands on chain and fails. A failed transaction is rolled back
//! completely, and here that includes the nonce. So the signed authorization
//! is still valid: once the PDA is funded, the same bytes land. A durable
//! nonce transaction that landed and failed would have used up its nonce.
//!
//! The action can be retried without signing again. It stays valid until its
//! nonce moves.
//!
//! Then the deadline. The cold key signs a second transfer with a deadline, an
//! instruction that fails after a given slot. Relayed after that slot, it is
//! rejected.
//!
//! Run with `just failed-attempt`.

use anyhow::{bail, Result};
use lighthouse_sdk::errors::LighthouseError;
use lighthouse_sdk::instructions::AssertSysvarClockBuilder;
use lighthouse_sdk::types::{IntegerOperator, LogLevel, SysvarClockAssertion};
use psigner::cluster::{
    assert_programs_deployed, client, compute_units, funded_keypair, send_transaction,
    send_transaction_without_preflight,
};
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
/// How many slots after signing the second action stays valid. It is short so
/// the example finishes quickly; a real deadline would be much further out.
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

    // The PDA holds no funds, so this transfer cannot succeed yet. Relay it
    // anyway, to see what a failed attempt leaves behind.
    //
    // Normally the RPC node would simulate the transaction first, see that it
    // fails, and refuse to send it. Here it is told not to simulate, so the
    // transaction really lands. On chain, the transfer fails inside the System
    // program, and the whole transaction is rolled back with it.
    println!("\n== relayed while the PDA is unfunded ==");
    let (failed, outcome) =
        send_transaction_without_preflight(&client, &relayer, &submit, &[&relayer])?;
    println!("  landed:        {failed}");
    match outcome {
        Err(TransactionError::InstructionError(_, InstructionError::Custom(code)))
            if code == SystemError::ResultWithNegativeLamports as u32 =>
        {
            println!("  failed:        custom program error {code} (insufficient funds)");
        }
        other => bail!("expected the transfer to fail for lack of funds, got {other:?}"),
    }
    if let Some(units) = compute_units(&client, &failed)? {
        println!("  compute units: {units} (the relayer paid the fee for this attempt)");
    }
    // This is the difference from a durable nonce. A durable nonce transaction
    // that lands and fails still uses up its nonce. Here the nonce advance was
    // rolled back with everything else, so the nonce has not moved.
    let unchanged = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after:   {unchanged} (unchanged)");
    if unchanged != nonce {
        bail!("the nonce moved although the relay failed");
    }

    // Now fund the PDA and relay again. Nothing is signed again: these are the
    // exact same signed bytes that failed a moment ago.
    //
    // This time it lands. A failed attempt does not use up a signed action.
    // The action stays valid until the nonce moves. So it can be retried
    // without the cold key coming back online, and anyone who has a copy can
    // relay it, at any later time.
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

    // The deadline. The programmatic signer has no deadline of its own. The
    // upstream docs say to add one with an instruction that fails after the
    // deadline, and name Lighthouse, a separate assertion program, for it.
    // So the second action starts with a Lighthouse instruction that checks
    // "the current slot is at most the deadline". It is inside the execution
    // message, so the cold key's signature covers it and a relayer cannot
    // remove or change it.
    println!("\n== signing a second action with a deadline ==");
    let deadline = client.get_slot()? + DEADLINE_SLOTS;
    let execution = execution_message(
        &pda,
        &[
            AssertSysvarClockBuilder::new()
                .log_level(LogLevel::Silent)
                .assertion(SysvarClockAssertion::Slot {
                    value: deadline,
                    operator: IntegerOperator::LessThanOrEqual,
                })
                .instruction(),
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

    // Wait until the deadline has passed, then relay, to show that a late
    // relay is refused. The PDA has the funds this time, so the only thing in
    // the way is the deadline. The RPC node rejects it when it simulates the
    // transaction.
    println!("\n== relayed after the deadline ==");
    while client.get_slot()? <= deadline {
        sleep(Duration::from_millis(400));
    }
    println!("  slot:        {}", client.get_slot()?);
    expect_rejected(
        send_transaction(&client, &relayer, &submit, &[&relayer]),
        LighthouseError::AssertionFailed as u32,
        "Lighthouse's AssertionFailed",
    )?;
    let balance = client.get_balance(&recipient)?;
    if balance != AMOUNT {
        bail!("the expired action moved funds");
    }
    // The expired action never ran, so the nonce did not move. The cold key
    // can sign a new action over the same nonce.
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
