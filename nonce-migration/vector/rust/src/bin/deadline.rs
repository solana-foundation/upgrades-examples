//! Signs an action with a deadline. After the deadline, it cannot be relayed.
//!
//! A signed action stays valid until its nonce moves. A deadline ends that
//! earlier. Vector has one built in: the `Advance` instruction carries a last
//! valid slot, and the program rejects the instruction after that slot.
//!
//! Here the cold key signs a transfer with a deadline. The example waits
//! until the deadline has passed and then relays. The relay is rejected, no
//! funds move, and the nonce is unchanged.
//!
//! Run with `just deadline`.

use anyhow::{bail, Result};
use ed25519_dalek::{Signer as Ed25519Signer, SigningKey};
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction_error::TransactionError;
use std::thread::sleep;
use std::time::Duration;
use vector_core::{
    advance_message, create_initialize_ed25519, create_multi_advance_instruction,
    create_system_passthrough_instruction, ed25519_pubkey, find_system_pda, find_vector_pda,
    signed, signer_digest, AdvanceSigner, VectorError, ED25519,
};
use vector_examples::cluster::{assert_program_deployed, client, funded_keypair, send_transaction};
use vector_examples::vector::fetch_nonce;

const AMOUNT: u64 = 10_000_000;
/// How many slots after signing the action stays valid. It is short so the
/// example finishes quickly; a real deadline would be much further out.
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

    // The cold key signs a transfer with a deadline. The deadline is a slot
    // number, and it goes into the Advance instruction. The cold key's
    // signature covers it, so a relayer cannot remove or extend it.
    //
    // The one-call signing function, `sign_advance_instruction_ed25519`,
    // cannot set a deadline; it always signs "never expires". So its three
    // steps are written out here:
    //   1. build the message, with the deadline in it;
    //   2. compute this account's digest of the message, and sign it;
    //   3. put the signature and the deadline into an Advance instruction.
    println!("\n== signing on the cold side ==");
    let deadline = client.get_slot()? + DEADLINE_SLOTS;
    let transfer = system_instruction::transfer(&system_pda, &recipient, AMOUNT);
    let passthrough = create_system_passthrough_instruction(&ED25519, &identity, &[transfer]);
    let advance_signer = AdvanceSigner::new(&ED25519, &identity);
    let message = advance_message(
        deadline,
        &[advance_signer],
        &[],
        std::slice::from_ref(&passthrough),
        None,
    );
    let digest = signer_digest(&message, nonce.as_bytes(), &vector, &[]);
    let signature = signing_key.sign(&signed(&digest)).to_bytes();
    let advance = create_multi_advance_instruction(deadline, &[(advance_signer, &signature)]);
    println!("  action:   transfer {AMOUNT} lamports from the system PDA");
    println!("  deadline: slot {deadline} ({DEADLINE_SLOTS} slots from now)");

    // Wait until the deadline has passed, then relay. The system PDA has the
    // funds, so the only thing in the way is the deadline. The RPC node
    // simulates the transaction, sees the Advance instruction fail, and
    // rejects it.
    println!("\n== relayed after the deadline ==");
    while client.get_slot()? <= deadline {
        sleep(Duration::from_millis(400));
    }
    println!("  slot:     {}", client.get_slot()?);
    let Err(error) = send_transaction(&client, &relayer, &[advance, passthrough], &[&relayer])
    else {
        bail!("expected the relay to be rejected, but it landed");
    };
    let rejection = error
        .downcast_ref::<ClientError>()
        .and_then(ClientError::get_transaction_error);
    match rejection {
        Some(TransactionError::InstructionError(_, InstructionError::Custom(code)))
            if code == VectorError::Expired as u32 =>
        {
            println!("  rejected: custom program error {code} (Vector's Expired)");
        }
        _ => return Err(error.context("expected Vector's Expired")),
    }

    println!("\n== read back ==");
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports");
    if balance != 0 {
        bail!("the expired action moved funds");
    }
    // The expired action did not run, so the nonce did not move. The cold key
    // can sign a new action over the same nonce.
    let unchanged = fetch_nonce(&client, &vector)?;
    println!("  nonce:             {unchanged} (unchanged)");
    if unchanged != nonce {
        bail!("the nonce moved although the relay was rejected");
    }
    Ok(())
}
