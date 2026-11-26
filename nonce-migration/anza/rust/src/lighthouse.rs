//! A deadline for an authorization, enforced by the Lighthouse program.
//!
//! The programmatic signer programs have no expiry: an authorization stays
//! valid until its nonce advances. The upstream docs say to add a deadline by
//! putting an instruction that fails after it into the execution message, and
//! name Lighthouse's `AssertSysvarClock` for that. Lighthouse is a third-party
//! assertion program, deployed immutably on mainnet.
//!
//! Hand-written, and should ideally be provided by an upstream client. The
//! published Lighthouse SDKs predate the Solana crates used here, so this
//! builds the one instruction from its wire format, as the programmatic
//! signer's own CLI tests do.

use solana_address::Address;
use solana_instruction::Instruction;

/// The Lighthouse program, at its mainnet address.
pub const ID: Address = Address::from_str_const("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");

/// The custom program error Lighthouse returns when an assertion fails.
pub const ASSERTION_FAILED: u32 = 6001;

/// `LighthouseInstruction::AssertSysvarClock`.
const ASSERT_SYSVAR_CLOCK: u8 = 15;
/// `LogLevel::Silent`.
const LOG_LEVEL_SILENT: u8 = 0;
/// `SysvarClockAssertion::Slot`.
const CLOCK_SLOT: u8 = 0;
/// `IntegerOperator::LessThanOrEqual`.
const LESS_THAN_OR_EQUAL: u8 = 5;

/// An instruction that succeeds while the current slot is at most
/// `last_valid_slot` and fails with [`ASSERTION_FAILED`] afterwards. It takes
/// no accounts; Lighthouse reads the clock itself.
pub fn assert_slot_at_most(last_valid_slot: u64) -> Instruction {
    let mut data = vec![ASSERT_SYSVAR_CLOCK, LOG_LEVEL_SILENT, CLOCK_SLOT];
    data.extend_from_slice(&last_valid_slot.to_le_bytes());
    data.push(LESS_THAN_OR_EQUAL);
    Instruction::new_with_bytes(ID, &data, vec![])
}
