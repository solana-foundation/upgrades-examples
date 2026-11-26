//! Cancels an action that the cold key has already signed.
//!
//! A signature cannot be taken back. But every action uses one nonce value,
//! and a nonce value can be used only once. So an action is cancelled by
//! getting something else to use its nonce value first.
//!
//! Here the cold key signs a transfer. In the same session it also signs a
//! revocation: an `Advance` instruction for the same nonce value, with no
//! other instruction beside it. The revocation is relayed first. It does
//! nothing except advance the nonce. When the transfer is relayed afterwards
//! it is rejected, and no funds move.
//!
//! Run with `just cancel`.

use anyhow::{bail, Result};
use ed25519_dalek::SigningKey;
use solana_hash::Hash;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction_error::TransactionError;
use vector_core::{
    create_initialize_ed25519, create_system_passthrough_instruction, ed25519_pubkey,
    find_system_pda, find_vector_pda, revocation_digest, sign_advance_instruction_ed25519,
    sign_revocation_instruction_ed25519, ED25519,
};
use vector_examples::cluster::{assert_program_deployed, client, funded_keypair, send_transaction};
use vector_examples::vector::fetch_nonce;

const AMOUNT: u64 = 10_000_000;

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
    let nonce = fetch_nonce(&client, &vector)?;

    println!("== setup ==");
    println!("  cold key:       {}", signer.pubkey());
    println!("  vector account: {vector} (holds the nonce)");
    println!("  system PDA:     {system_pda} (holds the funds)");
    println!("  nonce:          {nonce}");

    // The cold key signs two things in one session. Both use the same nonce
    // value. Only one of them can ever land: whichever lands first advances
    // the nonce, and the other's signature then no longer verifies.
    println!("\n== signing on the cold side ==");
    // The action: an ordinary transfer out of the system PDA.
    let transfer = system_instruction::transfer(&system_pda, &recipient, AMOUNT);
    let passthrough = create_system_passthrough_instruction(&ED25519, &identity, &[transfer]);
    let advance = sign_advance_instruction_ed25519(
        &signing_key,
        nonce.as_bytes(),
        &[],
        std::slice::from_ref(&passthrough),
        None,
    );
    // The revocation. It is an Advance instruction with nothing else in the
    // transaction: no Passthrough, so no action runs. The program still
    // advances the nonce, and that is all it does.
    let revocation = sign_revocation_instruction_ed25519(&signing_key, nonce.as_bytes());
    let next_nonce_value =
        Hash::new_from_array(revocation_digest(&ED25519, nonce.as_bytes(), &identity));
    println!("  action:     transfer {AMOUNT} lamports from the system PDA");
    println!("  revocation: an Advance on its own; only advances the nonce");
    println!("  nonce after the revocation: {next_nonce_value}");

    // From here on the cold key is not needed. The online side now holds both
    // things it signed, the action and the revocation. Suppose it decides the
    // transfer should not go ahead. It relays the revocation, which needs no
    // new signature. The revocation has to be the only instruction in its
    // transaction, because that is what was signed.
    println!("\n== relayed the revocation ==");
    let landed = send_transaction(&client, &relayer, &[revocation], &[&relayer])?;
    println!("  landed:      {landed}");
    let advanced = fetch_nonce(&client, &vector)?;
    println!("  nonce after: {advanced}");
    println!("  expected:    {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }

    // The action is still a valid signed transaction. But its signature was
    // made over the old nonce value, and the account now holds a different
    // one, so the signature no longer verifies and the program rejects it.
    println!("\n== relayed the action afterwards ==");
    expect_rejected(send_transaction(
        &client,
        &relayer,
        &[advance, passthrough],
        &[&relayer],
    ))?;
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports");
    if balance != 0 {
        bail!("the cancelled action moved funds");
    }
    Ok(())
}

/// Fails unless a relay was rejected with `MissingRequiredSignature`, which is
/// how Vector reports a signature that does not verify.
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
