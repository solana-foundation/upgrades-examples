//! Signs a SOL transfer with a cold key that never goes online, then relays it
//! after the blockhash that was current at signing time has expired.
//!
//! The same transfer is sent twice. First as a System durable nonce
//! transaction, the flow being replaced. Then as a programmatic signer
//! authorization: the cold key signs an authorization message, a hot relayer
//! wraps it in a transaction with a fresh blockhash, and the PDA that acts for
//! the cold key pays. Afterwards the nonce has advanced to the value computed
//! at signing time, and relaying the same artifact again is rejected.
//!
//! Run with `just sign-relay`.

use anyhow::{bail, Result};
use psigner::cluster::{
    assert_programs_deployed, client, compute_units, funded_keypair, send_transaction,
    wait_for_blockhash_expiry,
};
use psigner::durable_nonce::{
    create_durable_nonce_account, fetch_durable_nonce, sign_durable_nonce_transfer,
};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce, next_nonce};
use solana_commitment_config::CommitmentConfig;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::VersionedMessage;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;
use spl_ed25519_signer_client::instruction::submit as submit_instruction;
use spl_ed25519_signer_client::message::authorization_message;
use spl_ed25519_signer_client::signing::sign_and_submit;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_ed25519_signer_interface::error::Error as SignerError;
use spl_message_executor_client::instruction::execute;
use spl_message_executor_interface::error::Error as ExecutorError;

const AMOUNT: u64 = 10_000_000;

fn main() -> Result<()> {
    let client = client();
    assert_programs_deployed(&client)?;

    let relayer = funded_keypair(&client, 2_000_000_000)?;
    let recipient = Keypair::new().pubkey();

    // The flow being replaced. The cold key holds the funds and pays the fee,
    // so it has to be funded, and it signs a whole transaction.
    println!("== before: a System durable nonce transaction ==");
    let cold = funded_keypair(&client, 1_000_000_000)?;
    let durable_nonce_account = create_durable_nonce_account(&client, &cold)?;
    let durable_nonce = fetch_durable_nonce(&client, &durable_nonce_account)?;
    let durable = sign_durable_nonce_transfer(
        &cold,
        &durable_nonce_account,
        durable_nonce,
        &recipient,
        AMOUNT,
    )?;
    println!("  nonce account: {durable_nonce_account}");
    println!("  nonce:         {durable_nonce}");
    println!(
        "  signed by:     {} (the cold key, which also pays)",
        cold.pubkey()
    );
    println!("  size:          {} bytes", versioned_size(&durable));
    let signature = client.send_and_confirm_transaction(&durable)?;
    println!("  landed:        {signature}");
    let advanced = fetch_durable_nonce(&client, &durable_nonce_account)?;
    println!("  nonce after:   {advanced} (a future blockhash; not knowable at signing time)");

    // The replacement. The cold key is never funded and never signs a
    // transaction. A PDA derived from it holds the funds instead.
    println!("\n== after: a programmatic signer authorization ==");
    let authority = Keypair::new();
    let pda =
        ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, &authority.pubkey());
    println!(
        "  authority: {} (cold; holds nothing, signs one message)",
        authority.pubkey()
    );
    println!("  pda:       {pda} (holds the funds; nothing to create)");

    // Fund the PDA. It is a plain System-owned address, so this is an ordinary
    // transfer; in a migration it is where the cold key's SOL moves to.
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

    // One SPL nonce account per action in flight. The relayer pays the rent;
    // the PDA is the authority, so only an authorization can consume it.
    let nonce_account = create_nonce_account(&client, &relayer, &pda)?;
    let nonce = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce account: {nonce_account}");
    println!("  nonce:         {nonce}");

    // The cold side. Nothing below needs an RPC once the nonce value is known:
    // the action is compiled into an execution message, wrapped in an Execute
    // instruction, and `sign_and_submit` builds the authorization message,
    // signs it with the cold key, and returns the Submit instruction to relay.
    println!("\n== signing on the cold side ==");
    let transfer = system_instruction::transfer(&pda, &recipient, AMOUNT);
    let execution = execution_message(&pda, &[transfer], nonce)?;
    let wrapped = execute(&nonce_account, &pda, &execution);
    let submit = [sign_and_submit(&wrapped, &[&authority])?];
    let next_nonce_value = next_nonce(&nonce_account, &execution);
    println!(
        "  execution message:  {} bytes, 1 instruction (the transfer)",
        execution.serialize().len()
    );
    println!(
        "  Submit instruction: {} bytes of data, holding the authorization message and the signature",
        submit[0].data.len()
    );
    println!("  next nonce:         {next_nonce_value} (known before anything is sent)");

    // A transaction signed now would expire with this blockhash. The artifact
    // does not use a blockhash as its lifetime, so it does not.
    let blockhash_at_signing = client.get_latest_blockhash()?;
    if std::env::var_os("PSIGNER_SKIP_EXPIRY").is_some() {
        println!("\n== skipping the wait for blockhash {blockhash_at_signing} to expire ==");
    } else {
        println!("\n== waiting for blockhash {blockhash_at_signing} to expire (150 slots) ==");
        wait_for_blockhash_expiry(&client, &blockhash_at_signing)?;
        if client.is_blockhash_valid(&blockhash_at_signing, CommitmentConfig::confirmed())? {
            bail!("the blockhash is still valid");
        }
        println!("  expired; a transaction signed alongside the artifact would now be dropped");
    }

    // An edited payment. A relayer that swaps in a larger amount still holds
    // only the signature over the original, so the Signer program refuses it.
    println!("\n== relayed with the amount edited ==");
    let signature = authority
        .sign_message(&authorization_message(&wrapped, &[authority.pubkey()])?.serialize());
    let edited = execution_message(
        &pda,
        &[system_instruction::transfer(&pda, &recipient, 2 * AMOUNT)],
        nonce,
    )?;
    let edited = authorization_message(
        &execute(&nonce_account, &pda, &edited),
        &[authority.pubkey()],
    )?;
    let tampered = [submit_instruction(
        vec![Some(signature)],
        VersionedMessage::V1(edited),
    )];
    expect_rejected(
        send_transaction(&client, &relayer, &tampered, &[&relayer]),
        SignerError::InvalidSignature as u32,
        "the Signer's InvalidSignature",
    )?;

    // The hot side. Any funded key can relay. It cannot modify the
    // authorization message, because the cold key has signed it.
    println!("\n== relayed ==");
    let relay_signature = send_transaction(&client, &relayer, &submit, &[&relayer])?;
    println!("  landed:            {relay_signature}");
    if let Some(units) = compute_units(&client, &relay_signature)? {
        println!("  compute units:     {units}");
    }

    println!("\n== read back ==");
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports (both transfers)");
    if balance != 2 * AMOUNT {
        bail!("expected the recipient to hold {} lamports", 2 * AMOUNT);
    }
    let advanced = fetch_nonce(&client, &nonce_account)?.nonce;
    println!("  nonce after:       {advanced}");
    println!("  expected:          {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }

    // The nonce value the artifact names is gone, so the Executor refuses it.
    println!("\n== relayed again ==");
    expect_rejected(
        send_transaction(&client, &relayer, &submit, &[&relayer]),
        ExecutorError::NonceMismatch as u32,
        "the Executor's NonceMismatch",
    )
}

/// Fails unless a relay was rejected with the custom program error `code`.
/// Both errors here are number 3, in different programs.
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

/// The wire size of a v1 transaction: the message, then one signature per
/// required signer, with no count in front.
fn versioned_size(transaction: &VersionedTransaction) -> usize {
    let VersionedMessage::V1(message) = &transaction.message else {
        unreachable!("every transaction here is v1");
    };
    message.serialize().len() + transaction.signatures.len() * 64
}
