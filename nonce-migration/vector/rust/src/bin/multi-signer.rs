//! Two cold approvers sign one token withdrawal on separate machines, and a
//! hot key relays it once it holds both signatures.
//!
//! Each cold key has its own vector account and system PDA. The tokens belong
//! to a Token program multisig whose two signers are those system PDAs, so
//! neither approver can move them alone. Both keys sign over the same
//! instructions; relaying with one signature is rejected, and relaying with
//! both lands.
//!
//! Run with `just multi-signer`.

use anyhow::{bail, Context, Result};
use ed25519_dalek::{Signer as Ed25519Signer, SigningKey};
use solana_address::Address;
use solana_hash::Hash;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_program_pack::Pack;
use solana_rpc_client_api::client_error::Error as ClientError;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction_error::TransactionError;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_token_interface::instruction::{initialize_multisig2, transfer_checked};
use spl_token_interface::state::Multisig;
use spl_token_interface::ID as TOKEN_PROGRAM;
use vector_core::{
    advance_message, create_initialize_ed25519, create_multi_advance_instruction,
    create_multi_passthrough_instruction, ed25519_pubkey, find_system_pda, find_vector_pda, signed,
    signer_digest, AdvanceSigner, PassthroughSigner, ED25519, NEVER_EXPIRES,
};
use vector_examples::cluster::{
    assert_program_deployed, client, compute_units, funded_keypair, send_transaction,
};
use vector_examples::token::{create_mint, fetch_balance, mint_to_ata, ui_amount, DECIMALS};
use vector_examples::vector::fetch_nonce;

/// 1,000 tokens at six decimals: what the multisig holds.
const SUPPLY: u64 = 1_000_000_000;
/// 250 tokens: what the withdrawal moves.
const AMOUNT: u64 = 250_000_000;

fn main() -> Result<()> {
    let client = client();
    assert_program_deployed(&client)?;

    let relayer = funded_keypair(&client, 5_000_000_000)?;
    let first = SigningKey::from_bytes(Keypair::new().secret_bytes());
    let second = SigningKey::from_bytes(Keypair::new().secret_bytes());
    let first_identity = ed25519_pubkey(&first);
    let second_identity = ed25519_pubkey(&second);
    let (first_vector, _) = find_vector_pda(&ED25519, &first_identity);
    let (second_vector, _) = find_vector_pda(&ED25519, &second_identity);
    let (first_pda, _) = find_system_pda(&first_vector);
    let (second_pda, _) = find_system_pda(&second_vector);
    let recipient = Keypair::new().pubkey();

    println!("== setup: a 2-of-2 multisig holds 1,000 tokens ==");
    println!(
        "  first approver:  {} (cold)",
        Address::new_from_array(first_identity)
    );
    println!("  its vector account: {first_vector}");
    println!("  its system PDA:     {first_pda}");
    println!(
        "  second approver: {} (cold)",
        Address::new_from_array(second_identity)
    );
    println!("  its vector account: {second_vector}");
    println!("  its system PDA:     {second_pda}");

    // Each approver needs its own vector account, which holds its nonce. The
    // relayer creates both and pays their rent.
    send_transaction(
        &client,
        &relayer,
        &[
            create_initialize_ed25519(&relayer.pubkey(), &first_identity),
            create_initialize_ed25519(&relayer.pubkey(), &second_identity),
        ],
        &[&relayer],
    )?;

    // Create the 2-of-2 multisig: a Token program account that lists both
    // system PDAs as signers with a threshold of 2. The relayer pays its rent.
    // Creating it needs no cold signature, because the PDAs are only recorded
    // as signers here; they sign later, when tokens are withdrawn.
    let multisig = Keypair::new();
    let rent = client.get_minimum_balance_for_rent_exemption(Multisig::LEN)?;
    send_transaction(
        &client,
        &relayer,
        &[
            system_instruction::create_account(
                &relayer.pubkey(),
                &multisig.pubkey(),
                rent,
                Multisig::LEN as u64,
                &TOKEN_PROGRAM,
            ),
            initialize_multisig2(
                &TOKEN_PROGRAM,
                &multisig.pubkey(),
                &[&first_pda, &second_pda],
                2,
            )?,
        ],
        &[&relayer, &multisig],
    )
    .context("failed to create the multisig")?;
    let multisig = multisig.pubkey();
    let mint = create_mint(&client, &relayer)?;
    let multisig_account = mint_to_ata(&client, &relayer, &mint, &multisig, SUPPLY)?;
    let recipient_account = get_associated_token_address(&recipient, &mint);
    send_transaction(
        &client,
        &relayer,
        &[create_associated_token_account_idempotent(
            &relayer.pubkey(),
            &recipient,
            &mint,
            &TOKEN_PROGRAM,
        )],
        &[&relayer],
    )?;
    println!("  multisig:        {multisig} (needs both system PDAs)");
    println!(
        "  its account:     {multisig_account} holds {}",
        ui_amount(fetch_balance(&client, &multisig_account)?)
    );

    // Each approver signs over its own account's nonce.
    let first_nonce = fetch_nonce(&client, &first_vector)?;
    let second_nonce = fetch_nonce(&client, &second_vector)?;
    println!("  first nonce:     {first_nonce}");
    println!("  second nonce:    {second_nonce}");

    // Build what the approvers will sign. This happens once, on any machine,
    // and needs no key:
    //   1. the action: a TransferChecked out of the multisig's token account,
    //      with both system PDAs as its signers;
    //   2. the Passthrough instruction that holds the action and signs as
    //      both system PDAs;
    //   3. the message: a hash of the transaction's instructions, with both
    //      approvers listed as signers of the Advance instruction. The list
    //      is fixed here; an approver cannot be added or swapped later.
    println!("\n== the message both approvers sign over ==");
    let transfer = transfer_checked(
        &TOKEN_PROGRAM,
        &multisig_account,
        &mint,
        &recipient_account,
        &multisig,
        &[&first_pda, &second_pda],
        AMOUNT,
        DECIMALS,
    )?;
    let passthrough = create_multi_passthrough_instruction(
        &[
            PassthroughSigner::system(&ED25519, &first_identity),
            PassthroughSigner::system(&ED25519, &second_identity),
        ],
        &[transfer],
    );
    let first_signer = AdvanceSigner::new(&ED25519, &first_identity);
    let second_signer = AdvanceSigner::new(&ED25519, &second_identity);
    let message = advance_message(
        NEVER_EXPIRES,
        &[first_signer, second_signer],
        &[],
        std::slice::from_ref(&passthrough),
        None,
    );
    println!("  message: {}", Hash::new_from_array(message));

    // Each approver signs on its own machine. What it signs is its own
    // digest: the shared message combined with its account's nonce and
    // address. That digest is also the nonce its account moves to. The two
    // signatures are independent of each other, so the approvers can sign in
    // any order. Here the second one signs first.
    println!("\n== signing on each cold side ==");
    let second_digest = signer_digest(&message, second_nonce.as_bytes(), &second_vector, &[]);
    let second_signature = second.sign(&signed(&second_digest)).to_bytes();
    println!("  second approver: {}", Signature::from(second_signature));
    let first_digest = signer_digest(&message, first_nonce.as_bytes(), &first_vector, &[]);
    let first_signature = first.sign(&signed(&first_digest)).to_bytes();
    println!("  first approver:  {}", Signature::from(first_signature));

    // The hot side. First relay with only the first approver's signature,
    // leaving the second one's place empty. The program rejects it, because
    // the Advance instruction lists two signers and verifies a signature for
    // each.
    println!("\n== relayed with one signature ==");
    let partial = create_multi_advance_instruction(
        NEVER_EXPIRES,
        &[(first_signer, &first_signature), (second_signer, &[0; 64])],
    );
    expect_rejected(send_transaction(
        &client,
        &relayer,
        &[partial, passthrough.clone()],
        &[&relayer],
    ))?;

    // Both signatures go into one Advance instruction, in the order the
    // signers were listed when the message was built.
    println!("\n== relayed with both ==");
    let advance = create_multi_advance_instruction(
        NEVER_EXPIRES,
        &[
            (first_signer, &first_signature),
            (second_signer, &second_signature),
        ],
    );
    let landed = send_transaction(&client, &relayer, &[advance, passthrough], &[&relayer])?;
    println!("  landed:        {landed}");
    if let Some(units) = compute_units(&client, &landed)? {
        println!("  compute units: {units}");
    }

    println!("\n== read back ==");
    let received = fetch_balance(&client, &recipient_account)?;
    println!(
        "  recipient account: {recipient_account} holds {}",
        ui_amount(received)
    );
    if received != AMOUNT {
        bail!("expected the recipient to hold {AMOUNT}");
    }
    let left = fetch_balance(&client, &multisig_account)?;
    println!("  multisig account:  holds {}", ui_amount(left));
    if left != SUPPLY - AMOUNT {
        bail!("expected the multisig to hold {}", SUPPLY - AMOUNT);
    }
    // Each account's nonce moved to the digest its own approver signed.
    for (name, vector, digest) in [
        ("first", first_vector, first_digest),
        ("second", second_vector, second_digest),
    ] {
        let advanced = fetch_nonce(&client, &vector)?;
        let expected = Hash::new_from_array(digest);
        println!("  {name} nonce after: {advanced}");
        println!("  expected:          {expected}");
        if advanced != expected {
            bail!("the {name} nonce did not advance to the value computed at signing time");
        }
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
