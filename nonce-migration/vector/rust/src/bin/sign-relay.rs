//! Signs a SOL transfer with a cold key that never goes online, then relays it
//! after the blockhash that was current at signing time has expired.
//!
//! The same transfer is sent twice. First as a System durable nonce
//! transaction, the flow being replaced. Then through Vector: the cold key
//! signs a digest of two instructions, a hot relayer puts them in a
//! transaction with a fresh blockhash, and the system PDA that acts for the
//! cold key pays. Afterwards the nonce has advanced to the value computed at
//! signing time, and relaying the same instructions again is rejected.
//!
//! Run with `just sign-relay`.

use anyhow::{bail, Result};
use ed25519_dalek::SigningKey;
use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::VersionedMessage;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::versioned::VersionedTransaction;
use solana_transaction_error::TransactionError;
use vector_core::{
    advance_vector_digest, create_initialize_ed25519, create_system_passthrough_instruction,
    ed25519_pubkey, find_system_pda, find_vector_pda, sign_advance_instruction_ed25519, ED25519,
};
use vector_examples::cluster::{
    assert_program_deployed, client, compute_units, funded_keypair, send_transaction,
    wait_for_blockhash_expiry,
};
use vector_examples::durable_nonce::{
    create_durable_nonce_account, fetch_durable_nonce, sign_durable_nonce_transfer,
};
use vector_examples::vector::fetch_nonce;

const AMOUNT: u64 = 10_000_000;

fn main() -> Result<()> {
    let client = client();
    assert_program_deployed(&client)?;

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
    // transaction. Two addresses derived from it act for it: a vector account
    // that holds the nonce, and its system PDA that holds the funds.
    println!("\n== after: a Vector advance ==");
    let signer = Keypair::new();
    let signing_key = SigningKey::from_bytes(signer.secret_bytes());
    let identity = ed25519_pubkey(&signing_key);
    let (vector, _) = find_vector_pda(&ED25519, &identity);
    let (system_pda, _) = find_system_pda(&vector);
    println!(
        "  cold key:       {} (holds nothing, signs one digest)",
        signer.pubkey()
    );
    println!("  vector account: {vector} (holds the nonce; the relayer creates it)");
    println!("  system PDA:     {system_pda} (holds the funds; nothing to create)");

    // Create the vector account. The relayer pays the rent and the cold key
    // does not sign; only its public key is stored.
    send_transaction(
        &client,
        &relayer,
        &[create_initialize_ed25519(&relayer.pubkey(), &identity)],
        &[&relayer],
    )?;

    // Fund the system PDA. It is a plain System-owned address, so this is an
    // ordinary transfer; in a migration it is where the cold key's SOL moves to.
    send_transaction(
        &client,
        &relayer,
        &[system_instruction::transfer(
            &relayer.pubkey(),
            &system_pda,
            1_000_000_000,
        )],
        &[&relayer],
    )?;
    let nonce = fetch_nonce(&client, &vector)?;
    println!("  nonce:          {nonce}");

    // The cold side. Nothing below needs an RPC once the nonce value is known:
    // the action is wrapped in a Passthrough instruction to run as the system
    // PDA, and `sign_advance_instruction_ed25519` signs a digest of it with the
    // cold key and returns the Advance instruction that carries the signature.
    // The digest names no fee payer, so any funded key can relay, and it is
    // also the nonce the account moves to.
    println!("\n== signing on the cold side ==");
    let transfer = system_instruction::transfer(&system_pda, &recipient, AMOUNT);
    let passthrough = create_system_passthrough_instruction(&ED25519, &identity, &[transfer]);
    let advance = sign_advance_instruction_ed25519(
        &signing_key,
        nonce.as_bytes(),
        &[],
        std::slice::from_ref(&passthrough),
        None,
    );
    let next_nonce_value = Hash::new_from_array(advance_vector_digest(
        &ED25519,
        nonce.as_bytes(),
        &identity,
        &[],
        std::slice::from_ref(&passthrough),
        None,
    ));
    println!(
        "  Advance instruction:     {} bytes of data: the signature, and an expiry slot of never",
        advance.data.len()
    );
    println!(
        "  Passthrough instruction: {} bytes of data, holding the transfer",
        passthrough.data.len()
    );
    println!("  next nonce:              {next_nonce_value} (known before anything is sent)");

    // A transaction signed now would expire with this blockhash. The two
    // instructions do not use a blockhash as their lifetime, so they do not.
    let blockhash_at_signing = client.get_latest_blockhash()?;
    if std::env::var_os("VECTOR_SKIP_EXPIRY").is_some() {
        println!("\n== skipping the wait for blockhash {blockhash_at_signing} to expire ==");
    } else {
        println!("\n== waiting for blockhash {blockhash_at_signing} to expire (150 slots) ==");
        wait_for_blockhash_expiry(&client, &blockhash_at_signing)?;
        if client.is_blockhash_valid(&blockhash_at_signing, CommitmentConfig::confirmed())? {
            bail!("the blockhash is still valid");
        }
        println!("  expired; a transaction signed alongside the instructions would now be dropped");
    }

    // An edited payment. A relayer that swaps in a larger amount still holds
    // only the signature over the original, so the digest the program rebuilds
    // is not the one that was signed.
    println!("\n== relayed with the amount edited ==");
    let edited = create_system_passthrough_instruction(
        &ED25519,
        &identity,
        &[system_instruction::transfer(
            &system_pda,
            &recipient,
            2 * AMOUNT,
        )],
    );
    expect_rejected(send_transaction(
        &client,
        &relayer,
        &[advance.clone(), edited],
        &[&relayer],
    ))?;

    // The hot side. Any funded key can relay. It cannot modify the two
    // instructions, because the cold key has signed a digest of them; it adds
    // only the blockhash, the fee, and the compute budget.
    println!("\n== relayed ==");
    let relay = [advance, passthrough];
    let relay_signature = send_transaction(&client, &relayer, &relay, &[&relayer])?;
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
    let advanced = fetch_nonce(&client, &vector)?;
    println!("  nonce after:       {advanced}");
    println!("  expected:          {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }

    // The nonce the signature covers is gone, so the signature no longer
    // verifies.
    println!("\n== relayed again ==");
    expect_rejected(send_transaction(&client, &relayer, &relay, &[&relayer]))
}

/// Fails unless a relay was rejected with `MissingRequiredSignature`, which is
/// how Vector reports a signature that does not match the transaction.
fn expect_rejected(relay: Result<Signature>) -> Result<()> {
    let error = match relay {
        Ok(signature) => bail!("expected a rejection, but the relay landed as {signature}"),
        Err(error) => error,
    };
    let rejection = error
        .downcast_ref::<ClientError>()
        .and_then(ClientError::get_transaction_error);
    match rejection {
        Some(TransactionError::InstructionError(_, InstructionError::MissingRequiredSignature)) => {
            println!("  rejected: missing required signature (Vector's bad signature error)");
            Ok(())
        }
        _ => Err(error.context("expected MissingRequiredSignature")),
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
