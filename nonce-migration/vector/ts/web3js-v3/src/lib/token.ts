/**
 * Token helpers for the examples.
 *
 * The system PDA owns token accounts the way any wallet does. Its associated
 * token account is derived from its address, tokens arrive there by an
 * ordinary `MintTo` or `Transfer`, and they leave by a `TransferChecked` the
 * PDA signs inside a `Passthrough` instruction.
 *
 * No token client is written for `@solana/web3.js` 3, so the instructions
 * come from `@solana-program/token`, the `@solana/kit` client, and are
 * converted.
 */

import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { flattenInstructionPlan, type InstructionPlan, isSignerRole, isWritableRole } from '@solana/kit';
import { type Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

/** Decimals of the mint the examples create: USDC's. */
export const DECIMALS = 6;

/** `owner`'s associated token account for `mint`. */
export async function associatedTokenAddress(owner: PublicKey, mint: PublicKey): Promise<PublicKey> {
    const [address] = await findAssociatedTokenPda({
        mint: mint.address,
        owner: owner.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return new PublicKey(address);
}

/** The balance of a token account, in base units. */
export async function fetchBalance(connection: Connection, account: PublicKey): Promise<bigint> {
    return BigInt((await connection.getTokenAccountBalance(account)).value.amount);
}

/** `amount` in whole tokens, at {@link DECIMALS}. */
export function uiAmount(amount: bigint): string {
    const unit = 10n ** BigInt(DECIMALS);
    return `${amount / unit}.${(amount % unit).toString().padStart(DECIMALS, '0')}`;
}

/**
 * The instructions of a kit instruction plan, as web3.js
 * `TransactionInstruction`s, which is what the Vector SDK's builders take.
 *
 * Hand-written, and should ideally be provided upstream. web3.js 3 has this
 * conversion internally (`fromKitInstruction`) and its own message compiler
 * accepts kit instructions, but it does not export the function, and the
 * Vector SDK accepts only `TransactionInstruction`.
 */
export function toTransactionInstructions(plan: InstructionPlan): TransactionInstruction[] {
    return flattenInstructionPlan(plan).map(step => {
        if (step.kind !== 'single') {
            throw new Error('expected a plan of plain instructions');
        }
        const { accounts, data, programAddress } = step.instruction;
        return new TransactionInstruction({
            data: Uint8Array.from(data ?? []),
            keys: (accounts ?? []).map(account => ({
                isSigner: isSignerRole(account.role),
                isWritable: isWritableRole(account.role),
                pubkey: new PublicKey(account.address),
            })),
            programId: new PublicKey(programAddress),
        });
    });
}
