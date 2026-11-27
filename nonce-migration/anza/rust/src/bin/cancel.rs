//! Cancels an action that the cold key has already signed.
//!
//! A signature cannot be taken back. But every action uses one nonce value,
//! and a nonce value can be used only once. So an action is cancelled by
//! getting something else to use its nonce value first.
//!
//! Here the cold key signs a transfer. In the same session it also signs a
//! cancellation: a second authorization for the same nonce value, with no
//! instructions inside. The cancellation is relayed first. It does nothing
//! except advance the nonce. When the transfer is relayed afterwards it is
//! rejected, and no funds move.
//!
//! Run with `just cancel`.

use anyhow::{bail, Result};
use psigner::cluster::{assert_programs_deployed, client, funded_keypair, send_transaction};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction_error::TransactionError;
use spl_ed25519_signer_client::signing::sign_and_submit;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;
use spl_message_executor_interface::error::Error as ExecutorError;

const AMOUNT: u64 = 10_000_000;

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

    // The cold key signs two authorizations in one session. Both use the same
    // nonce value. Only one of them can ever land: whichever lands first
    // advances the nonce, and the other then names a value that is gone.
    println!("\n== signing on the cold side ==");
    // The action is an ordinary transfer out of the PDA.
    let transfer = system_instruction::transfer(&pda, &recipient, AMOUNT);
    let action = execution_message(&pda, &[transfer], nonce)?;
    let submit_action = [sign_and_submit(
        &execute(&nonce_account, &pda, &action),
        &[&authority],
    )?];
    // The cancellation. It is built the same way as the action, but its
    // execution message has no instructions. The Executor still advances the
    // nonce when it runs it, and that is all it does.
    let cancellation = execution_message(&pda, &[], nonce)?;
    let submit_cancellation = [sign_and_submit(
        &execute(&nonce_account, &pda, &cancellation),
        &[&authority],
    )?];
    let next_nonce_value = next_nonce(&nonce_account, &cancellation);
    println!("  action:       transfer {AMOUNT} lamports from the PDA");
    println!("  cancellation: no instructions; only advances the nonce");
    println!("  nonce after the cancellation: {next_nonce_value}");

    // From here on the cold key is not needed. The online side now holds both
    // signed authorizations, the action and the cancellation. Suppose it
    // decides the transfer should not go ahead. It relays the cancellation,
    // which needs no new signature.
    println!("\n== relayed the cancellation ==");
    let landed = send_transaction(&client, &relayer, &submit_cancellation, &[&relayer])?;
    println!("  landed:      {landed}");
    let advanced = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after: {advanced}");
    println!("  expected:    {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }

    // Now relay the action. It is still a valid signed transaction. But it
    // names the old nonce value, and the nonce account now holds a different
    // one, so the Executor rejects it. The RPC node sees this when it
    // simulates the transaction, and does not send it.
    println!("\n== relayed the action afterwards ==");
    let Err(error) = send_transaction(&client, &relayer, &submit_action, &[&relayer]) else {
        bail!("expected the relay to be rejected, but it landed");
    };
    let rejection = error
        .downcast_ref::<ClientError>()
        .and_then(ClientError::get_transaction_error);
    match rejection {
        Some(TransactionError::InstructionError(_, InstructionError::Custom(code)))
            if code == ExecutorError::NonceMismatch as u32 =>
        {
            println!("  rejected: custom program error {code} (the Executor's NonceMismatch)");
        }
        _ => return Err(error.context("expected the Executor's NonceMismatch")),
    }
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports");
    if balance != 0 {
        bail!("the cancelled action moved funds");
    }
    Ok(())
}
