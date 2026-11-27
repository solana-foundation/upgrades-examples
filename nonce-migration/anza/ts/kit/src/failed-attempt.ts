/**
 * A cold-signed action that fails can be relayed again later, and a deadline
 * is what stops that.
 *
 * First the hazard. The cold key signs a transfer the PDA cannot afford. The
 * relay fails and rolls back completely, the nonce included, so the signed
 * authorization is still valid: once the PDA is funded, the same bytes land.
 * A durable nonce transaction would have burned its nonce on the first try.
 *
 * Then the fix. The cold key signs a second transfer with a deadline, an
 * instruction that fails after a given slot. Relayed after that slot, it is
 * rejected, and it always will be.
 *
 * Run with `just ts-failed-attempt`.
 */

import { findProgrammaticSignerPda } from '@solana-program/ed25519-programmatic-signer';
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

import { assertProgramsDeployed, createFundedClient } from './lib/cluster';
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

// The transfer fails inside the System program, and the whole relay rolls back
// with it. The nonce is part of that: it has not moved.
//
// Here the RPC node catches the failure when it simulates the transaction,
// before sending it. A transaction that failed on chain would end the same
// way, with the nonce unchanged.
console.log('\n== relayed while the PDA is unfunded ==');
await expectRejected(
    authorization,
    signature,
    SYSTEM_ERROR__RESULT_WITH_NEGATIVE_LAMPORTS,
    "the System program's insufficient funds error",
);
const unchanged = await fetchNonce();
console.log(`  nonce after: ${unchanged} (unchanged)`);
if (unchanged !== nonce) {
    throw new Error('the nonce moved although the relay failed');
}

// The hazard. Nothing was signed again: these are the same bytes, sent after
// the PDA was funded. Anyone who kept them could do this, at any later time.
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

// Hold the authorization back until the deadline has passed. The PDA has the
// funds this time; only the deadline is in the way.
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
// The nonce did not move, so the cold key can sign a replacement over it.
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
