//! Signs a token withdrawal with a cold key that never goes online, then
//! relays it from a hot key: the system PDA moves 250 of a Token program mint,
//! the kind USDC is, to a recipient whose token account does not exist yet and
//! creates that account on the way.
//!
//! Run with `just token-transfer`.

use anyhow::{bail, Result};
use ed25519_dalek::SigningKey;
use solana_hash::Hash;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use spl_associated_token_account_interface::address::get_associated_token_address;
use vector_core::{
    advance_vector_digest, create_initialize_ed25519, create_system_passthrough_instruction,
    ed25519_pubkey, find_system_pda, find_vector_pda, sign_advance_instruction_ed25519, ED25519,
};
use vector_examples::cluster::{
    assert_program_deployed, client, compute_units, funded_keypair, send_transaction,
};
use vector_examples::token::{create_mint, fetch_balance, mint_to_ata, transfer_to_ata, ui_amount};
use vector_examples::vector::fetch_nonce;

/// 1,000 tokens at six decimals: what the system PDA holds.
const SUPPLY: u64 = 1_000_000_000;
/// 250 tokens: what the withdrawal moves.
const AMOUNT: u64 = 250_000_000;

fn main() -> Result<()> {
    let client = client();
    assert_program_deployed(&client)?;

    let relayer = funded_keypair(&client, 5_000_000_000)?;
    let signer = Keypair::new();
    let signing_key = SigningKey::from_bytes(signer.secret_bytes());
    let identity = ed25519_pubkey(&signing_key);
    let (vector, _) = find_vector_pda(&ED25519, &identity);
    let (system_pda, _) = find_system_pda(&vector);
    let recipient = Keypair::new().pubkey();

    println!("== setup: the system PDA holds 1,000 tokens ==");
    println!("  cold key:       {}", signer.pubkey());
    println!("  vector account: {vector} (holds the nonce)");
    println!("  system PDA:     {system_pda} (owns the token account)");
    // The system PDA pays the rent of the token account it creates for the
    // recipient, so it needs some SOL as well as tokens.
    send_transaction(
        &client,
        &relayer,
        &[
            create_initialize_ed25519(&relayer.pubkey(), &identity),
            system_instruction::transfer(&relayer.pubkey(), &system_pda, 100_000_000),
        ],
        &[&relayer],
    )?;
    let mint = create_mint(&client, &relayer)?;
    let pda_account = mint_to_ata(&client, &relayer, &mint, &system_pda, SUPPLY)?;
    println!("  mint:        {mint}");
    println!(
        "  PDA account: {pda_account} holds {}",
        ui_amount(fetch_balance(&client, &pda_account)?)
    );
    println!("  recipient:   {recipient} (no token account yet; the PDA creates it)");
    let nonce = fetch_nonce(&client, &vector)?;
    println!("  nonce:       {nonce}");

    // The cold side: two ordinary token instructions with the system PDA as
    // payer and owner, wrapped in one Passthrough instruction, and a digest of
    // it signed into the Advance instruction. Nothing here needs an RPC.
    println!("\n== signing on the cold side ==");
    let passthrough = create_system_passthrough_instruction(
        &ED25519,
        &identity,
        &transfer_to_ata(&mint, &system_pda, &recipient, AMOUNT)?,
    );
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
        "  Advance instruction:     {} bytes of data",
        advance.data.len()
    );
    println!(
        "  Passthrough instruction: {} bytes of data, 2 instructions (CreateAssociatedTokenAccountIdempotent, TransferChecked)",
        passthrough.data.len()
    );

    println!("\n== relayed ==");
    let landed = send_transaction(&client, &relayer, &[advance, passthrough], &[&relayer])?;
    println!("  landed:        {landed}");
    if let Some(units) = compute_units(&client, &landed)? {
        println!("  compute units: {units}");
    }

    println!("\n== read back ==");
    let recipient_account = get_associated_token_address(&recipient, &mint);
    let received = fetch_balance(&client, &recipient_account)?;
    println!(
        "  recipient account: {recipient_account} holds {} (created by the PDA, which paid its rent)",
        ui_amount(received)
    );
    if received != AMOUNT {
        bail!("expected the recipient to hold {AMOUNT}");
    }
    let left = fetch_balance(&client, &pda_account)?;
    println!("  PDA account:       holds {}", ui_amount(left));
    if left != SUPPLY - AMOUNT {
        bail!("expected the PDA to hold {}", SUPPLY - AMOUNT);
    }
    let advanced = fetch_nonce(&client, &vector)?;
    println!("  nonce after:       {advanced}");
    println!("  expected:          {next_nonce_value}");
    if advanced != next_nonce_value {
        bail!("the nonce did not advance to the value computed at signing time");
    }
    Ok(())
}
