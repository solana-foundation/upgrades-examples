//! Signs on a machine that has no network connection.
//!
//! The work is split into three steps, each its own function:
//!   1. `prepare` runs online. It reads the nonce, builds the action, and
//!      computes the digest the cold key has to sign.
//!   2. `review_and_sign` runs on the cold machine. It is not given an RPC
//!      client, so it cannot make a network call. It receives the digest,
//!      shows what it is about to sign, and signs it.
//!   3. `relay` runs online. It puts the signature into an Advance
//!      instruction and sends it with the action.
//!
//! On Vector the cold key signs a digest, which is a hash. The action cannot
//! be read back out of a hash. So the cold machine shows the same thing a
//! hardware wallet shows: the text `vector:` followed by the digest. The
//! operator has to trust that the online side computed the digest from the
//! action they intend.
//!
//! Run with `just airgapped`.

use anyhow::{bail, Result};
use ed25519_dalek::{Signer as Ed25519Signer, SigningKey};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_rpc_client::rpc_client::RpcClient;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use vector_core::{
    advance_vector_digest, create_advance_instruction, create_initialize_ed25519,
    create_system_passthrough_instruction, ed25519_pubkey, find_system_pda, find_vector_pda,
    signed, ED25519, SIGNED_PREFIX,
};
use vector_examples::cluster::{assert_program_deployed, client, funded_keypair, send_transaction};
use vector_examples::vector::fetch_nonce;

const AMOUNT: u64 = 10_000_000;

fn main() -> Result<()> {
    let client = client();
    assert_program_deployed(&client)?;

    // Setup, done online by the relayer. The vector account is created and
    // its system PDA is funded. Neither step needs the cold key to sign; only
    // its public key is used.
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
    println!("== setup ==");
    println!("  cold key:       {}", signer.pubkey());
    println!("  vector account: {vector} (holds the nonce)");
    println!("  system PDA:     {system_pda} (holds the funds)");

    println!("\n== online: prepare the digest ==");
    let (passthrough, digest) = prepare(&client, &identity, &recipient, AMOUNT)?;
    println!("  action: transfer {AMOUNT} lamports to {recipient}");
    println!("  to the cold machine: the digest, 32 bytes");

    println!("\n== offline: review and sign ==");
    let signature = review_and_sign(&signing_key, &digest);
    println!("  to the online machine: the signature, 64 bytes");

    println!("\n== online: relay ==");
    let landed = relay(&client, &relayer, &identity, &signature, passthrough)?;
    println!("  landed: {landed}");

    println!("\n== read back ==");
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports");
    if balance != AMOUNT {
        bail!("expected the recipient to hold {AMOUNT} lamports");
    }
    // The digest the cold key signed is also the value the nonce moves to.
    let advanced = fetch_nonce(&client, &vector)?;
    println!("  nonce after:       {advanced}");
    if advanced != Hash::new_from_array(digest) {
        bail!("the nonce did not advance to the digest that was signed");
    }
    Ok(())
}

/// Step 1, online. Reads the nonce, builds the Passthrough instruction that
/// holds the transfer, and computes the digest of it. Nothing is signed here;
/// only the cold key's public key is needed.
fn prepare(
    client: &RpcClient,
    identity: &[u8; 32],
    recipient: &Address,
    amount: u64,
) -> Result<(Instruction, [u8; 32])> {
    let (vector, _) = find_vector_pda(&ED25519, identity);
    let (system_pda, _) = find_system_pda(&vector);
    let nonce = fetch_nonce(client, &vector)?;
    let transfer = system_instruction::transfer(&system_pda, recipient, amount);
    let passthrough = create_system_passthrough_instruction(&ED25519, identity, &[transfer]);
    let digest = advance_vector_digest(
        &ED25519,
        nonce.as_bytes(),
        identity,
        &[],
        std::slice::from_ref(&passthrough),
        None,
    );
    Ok((passthrough, digest))
}

/// Step 2, on the cold machine. It has no RPC client, so it cannot reach the
/// network.
///
/// It receives the digest. What the key signs is 39 bytes: the text `vector:`
/// and then the digest. It prints those bytes the way a hardware wallet
/// would, and signs them.
fn review_and_sign(signing_key: &SigningKey, digest: &[u8; 32]) -> [u8; 64] {
    let message = signed(digest);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    println!("  signing: {}{hex}", String::from_utf8_lossy(SIGNED_PREFIX));
    println!(
        "  ({} bytes; the action cannot be read from them)",
        message.len()
    );
    signing_key.sign(&message).to_bytes()
}

/// Step 3, online. Puts the cold key's signature into an Advance instruction
/// and sends it together with the Passthrough instruction. Any funded key can
/// relay. It cannot change the action, because the signature is over a digest
/// of it.
fn relay(
    client: &RpcClient,
    relayer: &Keypair,
    identity: &[u8; 32],
    signature: &[u8; 64],
    passthrough: Instruction,
) -> Result<Signature> {
    let advance = create_advance_instruction(&ED25519, identity, signature);
    send_transaction(client, relayer, &[advance, passthrough], &[relayer])
}
