/**
 * Building the two inner messages of a programmatic signer action. The cold
 * key signs the authorization message's bytes with `signBytes`, and the relayer
 * sends the outermost layer with the client's `ed25519Signer` plugin.
 *
 * ```text
 * relay transaction        signed by the hot relayer, fresh blockhash, pays the fee
 * └─ Submit instruction    to the Signer program
 *    └─ authorization message   signed by the cold authority, no blockhash, no expiry
 *       └─ Execute instruction  to the Executor program
 *          └─ execution message     fee payer and signer are the PDA, "blockhash" is the nonce
 *             └─ the action          an ordinary System transfer from the PDA
 * ```
 */

import { getExecuteInstruction } from '@solana-program/ed25519-programmatic-signer';
import {
    AccountRole,
    type Address,
    appendTransactionMessageInstruction,
    appendTransactionMessageInstructionPlan,
    type Blockhash,
    compileTransactionMessage,
    createNoopSigner,
    createTransactionMessage,
    getCompiledTransactionMessageEncoder,
    type Instruction,
    type InstructionPlan,
    isWritableRole,
    pipe,
    type ReadonlyUint8Array,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

/**
 * A lifetime slot holding `value` instead of a blockhash. The execution
 * message carries the nonce there and the authorization message carries
 * zeros; neither is ever sent as a transaction, so the height is never read.
 */
const lifetime = (value: string) => ({ blockhash: value as Blockhash, lastValidBlockHeight: 0n });

/**
 * Builds the execution message: the action, as the PDA would send it.
 *
 * The action is an instruction plan, which is what `@solana-program/token`
 * and the other program clients hand back, so their helpers drop straight in.
 * Wherever a key would sign, name the PDA with `createNoopSigner`: it carries
 * the address and the signer role without producing a signature, and the
 * Signer program makes the role true when the action runs.
 *
 * The PDA is the fee payer and signer, which it could never be in a real
 * transaction; the executor fills those roles by CPI. The blockhash slot holds
 * the nonce value, and no transaction config is set because the message
 * never runs as a transaction of its own.
 */
export function executionMessage(pda: Address, action: InstructionPlan, nonce: Address): ReadonlyUint8Array {
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayer(pda, m),
        m => setTransactionMessageLifetimeUsingBlockhash(lifetime(nonce), m),
        m => appendTransactionMessageInstructionPlan(action, m),
    );
    return getCompiledTransactionMessageEncoder().encode(compileTransactionMessage(message));
}

/**
 * Builds the authorization message that the `authorities` sign. It is a v1
 * message holding one `Execute` instruction, with no blockhash and no
 * transaction config. Every authority signs the same bytes.
 *
 * Only the authorities are marked as signers in this message. The accounts of
 * the `Execute` instruction are all marked as non-signers, including the
 * PDAs, even though the PDAs do sign when the action runs. A PDA has no key,
 * so if the message required its signature, nobody could provide one. The
 * Signer program makes the PDAs signers itself, after it has checked the
 * authorities' signatures.
 *
 * Hand-written, and should ideally be provided by the upstream client. The
 * Rust client crate has this function, `authorization_message`; the
 * JavaScript client does not yet.
 *
 * One step here works around a kit limitation. Kit only puts an account into
 * a compiled message if it is the fee payer or appears in an instruction. The
 * first authority is the fee payer, but any further authorities are neither,
 * so they are inserted into the compiled message afterwards as readonly
 * signers.
 */
export function authorizationMessage(
    executionMessage: ReadonlyUint8Array,
    nonceAccount: Address,
    nonceAuthority: Address,
    authorities: readonly Address[],
): ReadonlyUint8Array {
    const [first, ...rest] = authorities;
    if (first === undefined) {
        throw new Error('an authorization message needs at least one authority');
    }
    const execute = getExecuteInstruction({
        message: executionMessage,
        nonceAccount,
        nonceAuthority: createNoopSigner(nonceAuthority),
    });
    const demoted: Instruction = {
        ...execute,
        accounts: execute.accounts.map(({ address, role }) => ({
            address,
            role: isWritableRole(role) ? AccountRole.WRITABLE : AccountRole.READONLY,
        })),
    };
    const message = pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayer(first, m),
        m => setTransactionMessageLifetimeUsingBlockhash(lifetime('11111111111111111111111111111111'), m),
        m => appendTransactionMessageInstruction(demoted, m),
    );
    const compiled = compileTransactionMessage(message);
    // Insert the other authorities directly after the first, which is at
    // index 0. Every account that came after index 0 moves up by the number
    // inserted, so the instruction's account indexes are shifted to match.
    const shifted = (index: number) => (index === 0 ? 0 : index + rest.length);
    return getCompiledTransactionMessageEncoder().encode({
        ...compiled,
        header: {
            ...compiled.header,
            numReadonlySignerAccounts: compiled.header.numReadonlySignerAccounts + rest.length,
            numSignerAccounts: compiled.header.numSignerAccounts + rest.length,
        },
        instructionHeaders: compiled.instructionHeaders.map(header => ({
            ...header,
            programAccountIndex: shifted(header.programAccountIndex),
        })),
        instructionPayloads: compiled.instructionPayloads.map(payload => ({
            ...payload,
            instructionAccountIndices: payload.instructionAccountIndices.map(shifted),
        })),
        numStaticAccounts: compiled.numStaticAccounts + rest.length,
        staticAccounts: [first, ...rest, ...compiled.staticAccounts.slice(1)],
    });
}
