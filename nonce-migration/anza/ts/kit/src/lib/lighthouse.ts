/**
 * A deadline for an authorization, enforced by the Lighthouse program.
 *
 * The programmatic signer programs have no expiry: an authorization stays
 * valid until its nonce advances. The upstream docs say to add a deadline by
 * putting an instruction that fails after it into the execution message, and
 * name Lighthouse's `AssertSysvarClock` for that. Lighthouse is a third-party
 * assertion program, deployed immutably on mainnet.
 *
 * Hand-written, and should ideally be provided by an upstream client. The
 * published Lighthouse SDK targets an older `@solana/kit`, so this builds the
 * one instruction from its wire format, as the programmatic signer's own CLI
 * tests do.
 */

import { type Address, getU64Encoder, type Instruction } from '@solana/kit';

/** The Lighthouse program, at its mainnet address. */
export const LIGHTHOUSE_PROGRAM_ADDRESS = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95' as Address;

/** The custom program error Lighthouse returns when an assertion fails. */
export const LIGHTHOUSE_ERROR__ASSERTION_FAILED = 6001;

/** `LighthouseInstruction::AssertSysvarClock`. */
const ASSERT_SYSVAR_CLOCK = 15;
/** `LogLevel::Silent`. */
const LOG_LEVEL_SILENT = 0;
/** `SysvarClockAssertion::Slot`. */
const CLOCK_SLOT = 0;
/** `IntegerOperator::LessThanOrEqual`. */
const LESS_THAN_OR_EQUAL = 5;

/**
 * An instruction that succeeds while the current slot is at most
 * `lastValidSlot` and fails with {@link LIGHTHOUSE_ERROR__ASSERTION_FAILED}
 * afterwards. It takes no accounts; Lighthouse reads the clock itself.
 */
export function assertSlotAtMost(lastValidSlot: bigint): Instruction {
    return {
        data: new Uint8Array([
            ASSERT_SYSVAR_CLOCK,
            LOG_LEVEL_SILENT,
            CLOCK_SLOT,
            ...getU64Encoder().encode(lastValidSlot),
            LESS_THAN_OR_EQUAL,
        ]),
        programAddress: LIGHTHOUSE_PROGRAM_ADDRESS,
    };
}
