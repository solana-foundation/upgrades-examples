//! Shared helpers for the Vector examples.
//!
//! Vector replaces a durable nonce transaction with two instructions in an
//! ordinary transaction. `Advance` carries the cold key's signature over a
//! digest of every instruction in the transaction, and `Passthrough` runs the
//! action as the account that key controls. The Vector SDK builds and signs
//! both; the modules here hold what it lacks, plus setup for the examples.

pub mod cluster;
pub mod durable_nonce;
pub mod vector;

/// Default JSON-RPC endpoint of a local `solana-test-validator`.
pub const DEFAULT_RPC_URL: &str = "http://127.0.0.1:8899";
