/**
 * A cold-signed action that fails can be relayed again later, and a deadline
 * is what stops that.
 *
 * First the hazard. The cold key signs a transfer the PDA cannot afford. The
 * relay lands on chain and fails. A failed transaction is rolled back
 * completely, and here that includes the nonce. So the signed authorization is
 * still valid: once the PDA is funded, the same bytes land. A durable nonce
 * transaction that landed and failed would have used up its nonce.
 *
 * Then the fix. The cold key signs a second transfer with a deadline, an
 * instruction that fails after a given slot. Relayed after that slot, it is
 * rejected, and it always will be.
 *
 * Run with `just ts-failed-attempt`.
 */

import { findProgrammaticSignerPda, getSubmitInstruction } from '@solana-program/ed25519-programmatic-signer';
import { getTransferSolInstruction, SYSTEM_ERROR__RESULT_WITH_NEGATIVE_LAMPORTS } from '@solana-program/system';
import {
    createNoopSigner,
    generateKeyPairSigner,
    isSolanaError,
    lamports,
    type ReadonlyUint8Array,
    sequentialInstructionPlan,
    signBytes,
    type SignatureBytes,
    singleInstructionPlan,
    SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    unwrapSimulationError,
} from '@solana/kit';
import {
    getAssertSysvarClockInstruction,
    IntegerOperator,
    LIGHTHOUSE_ERROR__ASSERTION_FAILED,
    LogLevel,
    sysvarClockAssertion,
} from 'lighthouse-sdk';

import { assertProgramsDeployed, createFundedClient, sendTransactionWithoutPreflight } from './lib/cluster';
import { authorizationMessage, executionMessage } from './lib/signer';
import { createNonceAccount, nextNonce } from './lib/spl-nonce';

const AMOUNT = 10_000_000n;
/**
 * How many slots after signing the second action stays valid. It is short so
 * the example finishes quickly; a real deadline would be much further out.
 */
const DEADLINE_SLOTS = 20n;

const relayer = await createFundedClient(2_000_000_000n);
await assertProgramsDeployed(relayer.rpc);
const recipient = (await generateKeyPairSigner()).address;
const authority = await generateKeyPairSigner();
const [pda] = await findProgrammaticSignerPda({ authority: authority.address });
const nonceAccount = await createNonceAccount(relayer, pda);
const fetchNonce = async () => (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data.nonce;
const fetchBalance = async () => (await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send()).value;
const fetchSlot = () => relayer.rpc.getSlot({ commitment: 'confirmed' }).send();
const nonce = await fetchNonce();

console.log('== setup: the PDA holds nothing ==');
console.log(`  authority:     ${authority.address} (cold)`);
console.log(`  pda:           ${pda} (unfunded)`);
console.log(`  nonce account: ${nonceAccount}`);
console.log(`  nonce:         ${nonce}`);

// The cold key signs a transfer out of the PDA. Signing needs no funds and no
// RPC, so nothing stops it from signing an action that cannot succeed yet.
console.log('\n== signing on the cold side ==');
const transfer = getTransferSolInstruction({ amount: AMOUNT, destination: recipient, source: createNoopSigner(pda) });
const execution = executionMessage(pda, singleInstructionPlan(transfer), nonce);
const authorization = authorizationMessage(execution, nonceAccount, pda, [authority.address]);
const signature = await signBytes(authority.keyPair.privateKey, authorization);
const nextNonceValue = await nextNonce(nonceAccount, nonce, execution);
console.log(`  action:     transfer ${AMOUNT} lamports from the PDA`);
console.log(`  next nonce: ${nextNonceValue}`);

// The PDA holds no funds, so this transfer cannot succeed yet. Relay it
// anyway, to see what a failed attempt leaves behind.
//
// Normally the RPC node would simulate the transaction first, see that it
// fails, and refuse to send it. Here it is told not to simulate, so the
// transaction really lands. On chain, the transfer fails inside the System
// program, and the whole transaction is rolled back with it.
console.log('\n== relayed while the PDA is unfunded ==');
const failed = await sendTransactionWithoutPreflight(
    relayer,
    getSubmitInstruction({ message: authorization, signatures: [signature] }),
);
console.log(`  landed:        ${failed.signature}`);
// The outcome names the instruction that failed and its error. Here that is
// custom error 1 from the System program.
const [, instructionError] =
    failed.err !== null && typeof failed.err === 'object' && 'InstructionError' in failed.err
        ? failed.err.InstructionError
        : [];
if (
    typeof instructionError !== 'object' ||
    !('Custom' in instructionError) ||
    Number(instructionError.Custom) !== SYSTEM_ERROR__RESULT_WITH_NEGATIVE_LAMPORTS
) {
    throw new Error('expected the transfer to fail for lack of funds');
}
console.log(
    `  failed:        custom program error ${SYSTEM_ERROR__RESULT_WITH_NEGATIVE_LAMPORTS} (insufficient funds)`,
);
const failedTransaction = await relayer.rpc
    .getTransaction(failed.signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
console.log(
    `  compute units: ${failedTransaction?.meta?.computeUnitsConsumed} (the relayer paid the fee for this attempt)`,
);
// This is the difference from a durable nonce. A durable nonce transaction
// that lands and fails still uses up its nonce. Here the nonce advance was
// rolled back with everything else, so the nonce has not moved.
const unchanged = await fetchNonce();
console.log(`  nonce after:   ${unchanged} (unchanged)`);
if (unchanged !== nonce) {
    throw new Error('the nonce moved although the relay failed');
}

// Now fund the PDA and relay again. This is the hazard. Nothing is signed
// again: these are the exact same bytes as before. Anyone who kept them could
// send them at any later time, and they would land once the funds are there.
console.log('\n== relayed again after the PDA is funded ==');
await relayer.system.instructions
    .transferSol({ amount: lamports(1_000_000_000n), destination: pda, source: relayer.payer })
    .sendTransaction();
const { context: relay } = await relayer.ed25519Signer.instructions
    .submit({ message: authorization, signatures: [signature] })
    .sendTransaction();
console.log(`  landed:            ${relay.signature}`);
const balance = await fetchBalance();
console.log(`  recipient balance: ${balance} lamports`);
if (balance !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT} lamports`);
}
const advanced = await fetchNonce();
console.log(`  nonce after:       ${advanced}`);
console.log(`  expected:          ${nextNonceValue}`);
if (advanced !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}

// The fix. The programmatic signer has no deadline of its own. The upstream
// docs say to add one with an instruction that fails after the deadline, and
// name Lighthouse, a separate assertion program, for it. So the second action
// starts with a Lighthouse instruction that checks "the current slot is at
// most the deadline". It is inside the execution message, so the cold key's
// signature covers it and a relayer cannot remove or change it.
console.log('\n== signing a second action with a deadline ==');
const deadline = (await fetchSlot()) + DEADLINE_SLOTS;
const timedExecution = executionMessage(
    pda,
    sequentialInstructionPlan([
        getAssertSysvarClockInstruction({
            assertion: sysvarClockAssertion('Slot', { operator: IntegerOperator.LessThanOrEqual, value: deadline }),
            logLevel: LogLevel.Silent,
        }),
        transfer,
    ]),
    advanced,
);
const timedAuthorization = authorizationMessage(timedExecution, nonceAccount, pda, [authority.address]);
const timedSignature = await signBytes(authority.keyPair.privateKey, timedAuthorization);
console.log(`  action:   transfer ${AMOUNT} lamports from the PDA`);
console.log(`  deadline: slot ${deadline} (${DEADLINE_SLOTS} slots from now)`);

// Wait until the deadline has passed, then relay, to show that a late relay is
// refused. The PDA has the funds this time, so the only thing in the way is
// the deadline. The RPC node rejects it when it simulates the transaction.
console.log('\n== relayed after the deadline ==');
while ((await fetchSlot()) <= deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
}
console.log(`  slot:        ${await fetchSlot()}`);
await expectRejected(
    timedAuthorization,
    timedSignature,
    LIGHTHOUSE_ERROR__ASSERTION_FAILED,
    "Lighthouse's AssertionFailed",
);
if ((await fetchBalance()) !== AMOUNT) {
    throw new Error('the expired action moved funds');
}
// The expired action never ran, so the nonce did not move. The cold key can
// sign a new action over the same nonce.
const stillUnchanged = await fetchNonce();
console.log(`  nonce after: ${stillUnchanged} (unchanged; a new action can use it)`);
if (stillUnchanged !== advanced) {
    throw new Error('the nonce moved although the relay failed');
}

/**
 * Relays `message` with `cold`, the cold key's signature, and throws unless
 * it is rejected with the custom program error `code`. The client simulates
 * before sending, so the rejection arrives wrapped in a simulation error.
 */
async function expectRejected(message: ReadonlyUint8Array, cold: SignatureBytes, code: number, name: string) {
    try {
        await relayer.ed25519Signer.instructions.submit({ message, signatures: [cold] }).sendTransaction();
    } catch (error) {
        const cause = isSolanaError(error, SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION)
            ? unwrapSimulationError(error.cause)
            : error;
        if (!isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) || cause.context.code !== code) {
            throw new Error(`expected ${name}`, { cause: error });
        }
        console.log(`  rejected: ${cause.message} (${name})`);
        return;
    }
    throw new Error(`expected ${name}, but the relay landed`);
}
