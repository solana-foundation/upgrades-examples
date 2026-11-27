//! Reading the nonce of a vector account, and of a Vector nonce account.
//!
//! ```text
//! relay transaction            signed by the hot relayer, fresh blockhash, pays the fee
//! ├─ Advance instruction       carries the cold key's signature; moves the nonce
//! └─ Passthrough instruction   runs the action as the account's system PDA
//!    └─ the action             an ordinary System transfer from that PDA
//! ```
//!
//! The Vector SDK builds every part of that: `create_initialize_ed25519`
//! creates the account, `create_system_passthrough_instruction` wraps the
//! action, `sign_advance_instruction_ed25519` signs both instructions with
//! the cold key, and `advance_vector_digest` is the nonce they leave behind.
//! The Rust SDK makes no RPC calls, so reading the current nonce is
//! hand-written here; it should ideally be provided by the upstream client, as
//! `fetchVectorAccount` is in the TypeScript SDK.

use anyhow::{anyhow, Context, Result};
use solana_address::Address;
use solana_hash::Hash;
use solana_rpc_client::rpc_client::RpcClient;
use vector_core::{NonceAccount, VectorAccount};

/// Reads the nonce a vector account currently holds.
///
/// It is the first 32 bytes of the account header, a hash like any blockhash.
/// Hand-written because `vector-core` has no fetch helper.
pub fn fetch_nonce(client: &RpcClient, vector: &Address) -> Result<Hash> {
    let data = client
        .get_account_data(vector)
        .with_context(|| format!("vector account {vector} not found"))?;
    let header = VectorAccount::header(&data)
        .map_err(|error| anyhow!("{vector} is not a vector account: {error:?}"))?;
    Ok(Hash::new_from_array(header.nonce))
}

/// Reads the nonce a Vector nonce account currently holds.
///
/// A nonce account is separate from the vector account. It is 72 bytes, and
/// its nonce is the first 32. Hand-written because `vector-core` has no fetch
/// helper; it should ideally be provided by the upstream client, as
/// `fetchNonceAccount` is in the TypeScript SDK.
pub fn fetch_nonce_account(client: &RpcClient, nonce_account: &Address) -> Result<Hash> {
    let data = client
        .get_account_data(nonce_account)
        .with_context(|| format!("nonce account {nonce_account} not found"))?;
    if data.len() != NonceAccount::LEN {
        return Err(anyhow!("{nonce_account} is not a Vector nonce account"));
    }
    let mut nonce = [0; 32];
    nonce.copy_from_slice(&data[..32]);
    Ok(Hash::new_from_array(nonce))
}
