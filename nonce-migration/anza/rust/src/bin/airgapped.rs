//! Signs on a machine that has no network connection.
//!
//! The work is split into three steps, each its own function:
//!   1. `prepare` runs online. It reads the nonce and builds the
//!      authorization message, unsigned.
//!   2. `review_and_sign` runs on the cold machine. It is not given an RPC
//!      client, so it cannot make a network call. It receives the
//!      authorization message as bytes, shows what the message would do, and
//!      signs those bytes.
//!   3. `relay` runs online. It puts the signature next to the message and
//!      sends them.
//!
//! The cold machine signs exactly the bytes it decoded and displayed. So the
//! operator approves what is shown, and nothing else.
//!
//! Run with `just airgapped`.

use anyhow::{bail, Context, Result};
use psigner::cluster::{assert_programs_deployed, client, funded_keypair, send_transaction};
use psigner::signer::execution_message;
use psigner::spl_nonce::{create_nonce_account, fetch_nonce};
use solana_address::Address;
use solana_bincode::limited_deserialize;
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_rpc_client::rpc_client::RpcClient;
use solana_signature::Signature;
use solana_signer::Signer;
use solana_system_interface::instruction::{self as system_instruction, SystemInstruction};
use spl_ed25519_signer_client::instruction::submit;
use spl_ed25519_signer_client::message::authorization_message;
use spl_ed25519_signer_client::ProgrammaticSigner;
use spl_message_executor_client::instruction::execute;
use spl_message_executor_interface::instruction::Instruction as ExecutorInstruction;

const AMOUNT: u64 = 10_000_000;

fn main() -> Result<()> {
    let client = client();
    assert_programs_deployed(&client)?;

    // Setup, done online by the relayer. The cold key's PDA is funded, and a
    // nonce account is created with the PDA as its authority. Neither step
    // needs the cold key to sign; only its public key is used.
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
    println!("== setup ==");
    println!("  authority:     {} (cold)", authority.pubkey());
    println!("  pda:           {pda} (holds the funds)");
    println!("  nonce account: {nonce_account}");

    println!("\n== online: prepare the authorization message ==");
    let authorization = prepare(
        &client,
        &authority.pubkey(),
        &nonce_account,
        &recipient,
        AMOUNT,
    )?;
    let bytes = authorization.serialize();
    println!(
        "  to the cold machine: the authorization message, {} bytes",
        bytes.len()
    );

    println!("\n== offline: review and sign ==");
    let signature = review_and_sign(&authority, &bytes)?;
    println!("  to the online machine: the signature, 64 bytes");

    println!("\n== online: relay ==");
    let landed = relay(&client, &relayer, authorization, signature)?;
    println!("  landed: {landed}");

    println!("\n== read back ==");
    let balance = client.get_balance(&recipient)?;
    println!("  recipient balance: {balance} lamports");
    if balance != AMOUNT {
        bail!("expected the recipient to hold {AMOUNT} lamports");
    }
    Ok(())
}

/// Step 1, online. Reads the nonce and builds the authorization message for a
/// transfer of `amount` to `recipient`. Nothing is signed here; only the cold
/// key's address is needed.
fn prepare(
    client: &RpcClient,
    authority: &Address,
    nonce_account: &Address,
    recipient: &Address,
    amount: u64,
) -> Result<v1::Message> {
    let pda = ProgrammaticSigner::derive_address(&spl_ed25519_signer_client::ID, authority);
    let nonce = fetch_nonce(client, nonce_account)?.nonce;
    let transfer = system_instruction::transfer(&pda, recipient, amount);
    let execution = execution_message(&pda, &[transfer], nonce)?;
    Ok(authorization_message(
        &execute(nonce_account, &pda, &execution),
        &[*authority],
    )?)
}

/// Step 2, on the cold machine. It has no RPC client, so it cannot reach the
/// network.
///
/// It receives the authorization message as bytes. It decodes them, layer by
/// layer, down to the action, and prints what it finds. Then it signs the
/// same bytes with the cold key.
fn review_and_sign(authority: &Keypair, authorization_bytes: &[u8]) -> Result<Signature> {
    // The outer layer is the authorization message. It lists who has to sign
    // and holds one instruction, for the Executor program.
    let VersionedMessage::V1(authorization) =
        wincode::deserialize(authorization_bytes).context("not a message")?
    else {
        bail!("the authorization message must be v1");
    };
    let signers =
        &authorization.account_keys[..usize::from(authorization.header.num_required_signatures)];
    let [execute] = authorization.instructions.as_slice() else {
        bail!("an authorization message holds exactly one instruction");
    };
    println!("  signers:       {signers:?}");

    // The Execute instruction names the nonce account as its second account,
    // and carries the execution message as its data.
    let nonce_account = authorization.account_keys[usize::from(execute.accounts[1])];
    let ExecutorInstruction::Execute(VersionedMessage::V1(execution)) =
        ExecutorInstruction::try_from_bytes(&execute.data)?
    else {
        bail!("the Execute instruction does not hold a v1 execution message");
    };
    println!("  nonce account: {nonce_account}");
    println!("  nonce:         {}", execution.lifetime_specifier);

    // The execution message holds the action. This example expects one System
    // transfer and refuses to sign anything else.
    let [action] = execution.instructions.as_slice() else {
        bail!("expected exactly one instruction in the action");
    };
    let program = execution.account_keys[usize::from(action.program_id_index)];
    let Ok(SystemInstruction::Transfer { lamports }) =
        limited_deserialize::<SystemInstruction>(&action.data, 1_232)
    else {
        bail!("the action is not a System transfer");
    };
    if program != solana_system_interface::program::ID {
        bail!("the action is not for the System program");
    }
    let source = execution.account_keys[usize::from(action.accounts[0])];
    let recipient = execution.account_keys[usize::from(action.accounts[1])];
    println!("  action:        transfer {lamports} lamports from {source} to {recipient}");

    // Sign the bytes that were just decoded and shown.
    Ok(authority.sign_message(authorization_bytes))
}

/// Step 3, online. Puts the cold key's signature next to the authorization
/// message in a Submit instruction, and sends it. Any funded key can relay.
/// It cannot change the message, because the signature is over its bytes.
fn relay(
    client: &RpcClient,
    relayer: &Keypair,
    authorization: v1::Message,
    signature: Signature,
) -> Result<Signature> {
    let submit = submit(vec![Some(signature)], VersionedMessage::V1(authorization));
    send_transaction(client, relayer, &[submit], &[relayer])
}
