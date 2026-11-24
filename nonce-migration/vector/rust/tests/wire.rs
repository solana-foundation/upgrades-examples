//! Offline test: what the cold key signs, and the next nonce, for one fixed
//! set of inputs.
//!
//! The expected values are shared with `ts/web3js-v3/test/wire.test.ts`, so
//! the vendored TypeScript SDK is checked byte for byte against the Rust one,
//! which runs the program's own code.

use ed25519_dalek::SigningKey;
use solana_address::Address;
use solana_hash::Hash;
use solana_system_interface::instruction as system_instruction;
use vector_core::{
    advance_vector_digest, create_system_passthrough_instruction, ed25519_pubkey, find_system_pda,
    find_vector_pda, sign_advance_instruction_ed25519, ED25519,
};

/// Fixed inputs. The cold key's secret key is 32 bytes of 1.
const COLD_SEED: [u8; 32] = [1; 32];
const RECIPIENT: Address = Address::new_from_array([2; 32]);
const NONCE: [u8; 32] = [3; 32];
const AMOUNT: u64 = 10_000_000;

/// Expected outputs for the inputs above. The Advance data is its
/// discriminator, an expiry slot of `u64::MAX` (never), then the signature.
const EXPECTED_SYSTEM_PDA: &str = "5YbEe7Qjhm4sGD89qX5LrczzS6h1E3kdJPWPAARffPAj";
const EXPECTED_ADVANCE_DATA: &str = "00ffffffffffffffffcc12e2d2224349b9519c1d8b260d682aef1d0e50e7d045b300f69402b257d06c37ad4e851131837d0048affd56c23b5c28afe760e4f1d594c714d739807d2c00";
const EXPECTED_NEXT_NONCE: &str = "Bcj9zkLSXMK8WEQV7YvPQsULuwaFwk8Zt95LhgVBuTNw";

#[test]
fn the_signed_instructions_match_the_shared_fixture() {
    let signing_key = SigningKey::from_bytes(&COLD_SEED);
    let identity = ed25519_pubkey(&signing_key);
    let (system_pda, _) = find_system_pda(&find_vector_pda(&ED25519, &identity).0);
    assert_eq!(system_pda.to_string(), EXPECTED_SYSTEM_PDA);

    let transfer = system_instruction::transfer(&system_pda, &RECIPIENT, AMOUNT);
    let passthrough = [create_system_passthrough_instruction(
        &ED25519,
        &identity,
        &[transfer],
    )];
    let advance = sign_advance_instruction_ed25519(&signing_key, &NONCE, &[], &passthrough, None);
    let hex: String = advance.data.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, EXPECTED_ADVANCE_DATA);

    let next = advance_vector_digest(&ED25519, &NONCE, &identity, &[], &passthrough, None);
    assert_eq!(Hash::new_from_array(next).to_string(), EXPECTED_NEXT_NONCE);
}
