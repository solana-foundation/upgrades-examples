//! Signs an action with a deadline. After the deadline, it cannot be relayed.
//!
//! A signed action stays valid until its nonce moves. A deadline ends that
//! earlier. The programmatic signer has no deadline of its own. The upstream
//! docs say to add one with an instruction that fails after the deadline,
//! and name Lighthouse, a separate assertion program, for it.
//!
//! Here the cold key signs a transfer that starts with such an instruction.
//! The example waits until the deadline has passed and then relays. The relay
//! is rejected, no funds move, and the nonce is unchanged.
//!
//! Run with `just deadline`.

use anyhow::{bail, Result};
use lighthouse_sdk::errors::LighthouseError;
use lighthouse_sdk::instructions::AssertSysvarClockBuilder;
use lighthouse_sdk::types::{IntegerOperator, LogLevel, SysvarClockAssertion};
use psigner::cluster::{assert_programs_deployed, client, funded_keypair, send_transaction};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction_error::TransactionError;
use spl_ed25519_signer_client::signing::sign_and_submit;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;
use std::thread::sleep;
use std::time::Duration;

const AMOUNT: u64 = 10_000_000;
/// How many slots after signing the action stays valid. It is short so the
/// example finishes quickly; a real deadline would be much further out.
const DEADLINE_SLOTS: u64 = 20;

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
    let nonce_account = create_nonce_account(&client, &relayer, &pda)?;
    let nonce = fetch_nonce(&client, &nonce_account)?.nonce;

    println!("== setup ==");
    println!("  authority:     {} (cold)", authority.pubkey());
    println!("  pda:           {pda} (holds the funds)");
    println!("  nonce account: {nonce_account}");
    println!("  nonce:         {nonce}");

    // The cold key signs a transfer with a deadline. The deadline is a slot
    // number. The action starts with a Lighthouse instruction that checks
    // "the current slot is at most the deadline", and fails if it is not. An
    // action runs all of its instructions or none, so when that check fails
    // the transfer does not happen.
    //
    // The check is inside the execution message. The cold key's signature
    // covers it, so a relayer cannot remove or change it.
    println!("\n== signing on the cold side ==");
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
        nonce,
    )?;
    let submit = [sign_and_submit(
        &execute(&nonce_account, &pda, &execution),
        &[&authority],
    )?];
    println!("  action:   transfer {AMOUNT} lamports from the PDA");
    println!("  deadline: slot {deadline} ({DEADLINE_SLOTS} slots from now)");

    // Wait until the deadline has passed, then relay. The PDA has the funds,
    // so the only thing in the way is the deadline. The RPC node simulates
    // the transaction, sees the Lighthouse check fail, and rejects it.
    println!("\n== relayed after the deadline ==");
    while client.get_slot()? <= deadline {
        sleep(Duration::from_millis(400));
    }
    println!("  slot:     {}", client.get_slot()?);
    let Err(error) = send_transaction(&client, &relayer, &submit, &[&relayer]) else {
        bail!("expected the relay to be rejected, but it landed");
    };
    let rejection = error
        .downcast_ref::<ClientError>()
        .and_then(ClientError::get_transaction_error);
    match rejection {
        Some(TransactionError::InstructionError(_, InstructionError::Custom(code)))
            if code == LighthouseError::AssertionFailed as u32 =>
        {
            println!("  rejected: custom program error {code} (Lighthouse's AssertionFailed)");
        }
        _ => return Err(error.context("expected Lighthouse's AssertionFailed")),
    }

    println!("\n== read back ==");
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports");
    if balance != 0 {
        bail!("the expired action moved funds");
    }
    // The expired action did not run, so the nonce did not move. The cold key
    // can sign a new action over the same nonce.
    let unchanged = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce:             {unchanged} (unchanged)");
    if unchanged != nonce {
        bail!("the nonce moved although the relay was rejected");
    }
    Ok(())
}
