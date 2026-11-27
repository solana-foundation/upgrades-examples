//! A cold-signed action that fails can be relayed again later, and a deadline
//! is what stops that.
//!
//! First the hazard. The cold key signs a transfer the system PDA cannot
//! afford. The relay lands on chain and fails. A failed transaction is rolled
//! back completely, and here that includes the nonce. So the signature is
//! still valid: once the PDA is funded, the same two instructions land. A
//! durable nonce transaction that landed and failed would have used up its
//! nonce.
//!
//! Then the fix. The cold key signs a second transfer with a deadline, the
//! last slot the `Advance` instruction accepts. Relayed after that slot, it is
//! rejected, and it always will be.
//!
//! Run with `just failed-attempt`.

use anyhow::{bail, Result};
use ed25519_dalek::{Signer as Ed25519Signer, SigningKey};
use solana_hash::Hash;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::error::SystemError;
use solana_system_interface::instruction as system_instruction;
use solana_transaction_error::TransactionError;
use std::thread::sleep;
use std::time::Duration;
use vector_core::{
    advance_message, advance_vector_digest, create_initialize_ed25519,
    create_multi_advance_instruction, create_system_passthrough_instruction, ed25519_pubkey,
    find_system_pda, find_vector_pda, sign_advance_instruction_ed25519, signed, signer_digest,
    AdvanceSigner, VectorError, ED25519,
};
use vector_examples::cluster::{
    assert_program_deployed, client, compute_units, funded_keypair, send_transaction,
    send_transaction_without_preflight,
};
use vector_examples::vector::fetch_nonce;

const AMOUNT: u64 = 10_000_000;
/// How many slots after signing the second action stays valid. It is short so
/// the example finishes quickly; a real deadline would be much further out.
const DEADLINE_SLOTS: u64 = 20;

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
        &[create_initialize_ed25519(&relayer.pubkey(), &identity)],
        &[&relayer],
    )?;
    let nonce = fetch_nonce(&client, &vector)?;

    println!("== setup: the system PDA holds nothing ==");
    println!("  cold key:       {}", signer.pubkey());
    println!("  vector account: {vector} (holds the nonce)");
    println!("  system PDA:     {system_pda} (unfunded)");
    println!("  nonce:          {nonce}");

    // The cold key signs a transfer out of the system PDA. Signing needs no
    // funds and no RPC, so nothing stops it from signing an action that cannot
    // succeed yet. This signature has no expiry, which is the default.
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
    let relay = [advance, passthrough.clone()];
    println!("  action:     transfer {AMOUNT} lamports from the system PDA");
    println!("  next nonce: {next_nonce_value}");

    // Relay it anyway. The RPC node is told not to simulate first, so the
    // transaction really lands. The transfer fails inside the System program,
    // and the whole transaction is rolled back with it.
    println!("\n== relayed while the system PDA is unfunded ==");
    let (failed, outcome) =
        send_transaction_without_preflight(&client, &relayer, &relay, &[&relayer])?;
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
    let unchanged = fetch_nonce(&client, &vector)?;
    println!("  nonce after:   {unchanged} (unchanged)");
    if unchanged != nonce {
        bail!("the nonce moved although the relay failed");
    }

    // The hazard. Nothing was signed again: these are the same instructions,
    // sent after the system PDA was funded. Anyone who kept them could do
    // this, at any later time.
    println!("\n== relayed again after the system PDA is funded ==");
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
    let landed = send_transaction(&client, &relayer, &relay, &[&relayer])?;
    println!("  landed:            {landed}");
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports");
    if balance != AMOUNT {
        bail!("expected the recipient to hold {AMOUNT} lamports");
    }
    let advanced = fetch_nonce(&client, &vector)?;
    println!("  nonce after:       {advanced}");
    println!("  expected:          {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }

    // The fix. The Advance instruction carries a last valid slot, and the
    // cold key's signature covers it, so a relayer cannot remove or extend it.
    // `sign_advance_instruction_ed25519` always signs "never expires", so a
    // deadline takes the three calls it wraps: build the message with the
    // slot, sign this account's digest of it, and assemble the instruction.
    println!("\n== signing a second action with a deadline ==");
    let deadline = client.get_slot()? + DEADLINE_SLOTS;
    let advance_signer = AdvanceSigner::new(&ED25519, &identity);
    let message = advance_message(
        deadline,
        &[advance_signer],
        &[],
        std::slice::from_ref(&passthrough),
        None,
    );
    let digest = signer_digest(&message, advanced.as_bytes(), &vector, &[]);
    let signature = signing_key.sign(&signed(&digest)).to_bytes();
    let advance = create_multi_advance_instruction(deadline, &[(advance_signer, &signature)]);
    println!("  action:   transfer {AMOUNT} lamports from the system PDA");
    println!("  deadline: slot {deadline} ({DEADLINE_SLOTS} slots from now)");

    // Hold the two instructions back until the deadline has passed. The
    // system PDA has the funds this time; only the deadline is in the way.
    println!("\n== relayed after the deadline ==");
    while client.get_slot()? <= deadline {
        sleep(Duration::from_millis(400));
    }
    println!("  slot:        {}", client.get_slot()?);
    expect_rejected(
        send_transaction(&client, &relayer, &[advance, passthrough], &[&relayer]),
        VectorError::Expired as u32,
        "Vector's Expired",
    )?;
    let balance = client.get_balance(&recipient)?;
    if balance != AMOUNT {
        bail!("the expired action moved funds");
    }
    // The nonce did not move, so the cold key can sign a replacement over it.
    let unchanged = fetch_nonce(&client, &vector)?;
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
