/**
 * Signs an action with a deadline. After the deadline, it cannot be relayed.
 *
 * A signed action stays valid until its nonce moves. A deadline ends that
 * earlier. The programmatic signer has no deadline of its own. The upstream
 * docs say to add one with an instruction that fails after the deadline, and
 * name Lighthouse, a separate assertion program, for it.
 *
 * Here the cold key signs a transfer that starts with such an instruction.
 * The example waits until the deadline has passed and then relays. The relay
 * is rejected, no funds move, and the nonce is unchanged.
 *
 * Run with `just ts-deadline`.
 */

import { findProgrammaticSignerPda } from '@solana-program/ed25519-programmatic-signer';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    createNoopSigner,
    generateKeyPairSigner,
    isSolanaError,
    lamports,
    sequentialInstructionPlan,
    signBytes,
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
import { createNonceAccount } from './lib/spl-nonce';

const AMOUNT = 10_000_000n;
/**
 * How many slots after signing the action stays valid. It is short so the
 * example finishes quickly; a real deadline would be much further out.
 */
const DEADLINE_SLOTS = 20n;

const relayer = await createFundedClient(2_000_000_000n);
await assertProgramsDeployed(relayer.rpc);
const recipient = (await generateKeyPairSigner()).address;
const authority = await generateKeyPairSigner();
const [pda] = await findProgrammaticSignerPda({ authority: authority.address });
await relayer.system.instructions
    .transferSol({ amount: lamports(1_000_000_000n), destination: pda, source: relayer.payer })
    .sendTransaction();
const nonceAccount = await createNonceAccount(relayer, pda);
const fetchNonce = async () => (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data.nonce;
const fetchSlot = () => relayer.rpc.getSlot({ commitment: 'confirmed' }).send();
const nonce = await fetchNonce();

console.log('== setup ==');
console.log(`  authority:     ${authority.address} (cold)`);
console.log(`  pda:           ${pda} (holds the funds)`);
console.log(`  nonce account: ${nonceAccount}`);
console.log(`  nonce:         ${nonce}`);

// The cold key signs a transfer with a deadline. The deadline is a slot
// number. The action starts with a Lighthouse instruction that checks "the
// current slot is at most the deadline", and fails if it is not. An action
// runs all of its instructions or none, so when that check fails the transfer
// does not happen.
//
// The check is inside the execution message. The cold key's signature covers
// it, so a relayer cannot remove or change it.
console.log('\n== signing on the cold side ==');
const deadline = (await fetchSlot()) + DEADLINE_SLOTS;
const execution = executionMessage(
    pda,
    sequentialInstructionPlan([
        getAssertSysvarClockInstruction({
            assertion: sysvarClockAssertion('Slot', { operator: IntegerOperator.LessThanOrEqual, value: deadline }),
            logLevel: LogLevel.Silent,
        }),
        getTransferSolInstruction({ amount: AMOUNT, destination: recipient, source: createNoopSigner(pda) }),
    ]),
    nonce,
);
const authorization = authorizationMessage(execution, nonceAccount, pda, [authority.address]);
const signature = await signBytes(authority.keyPair.privateKey, authorization);
console.log(`  action:   transfer ${AMOUNT} lamports from the PDA`);
console.log(`  deadline: slot ${deadline} (${DEADLINE_SLOTS} slots from now)`);

// Wait until the deadline has passed, then relay. The PDA has the funds, so
// the only thing in the way is the deadline. The client simulates the
// transaction before sending it, sees the Lighthouse check fail, and throws.
// The rejection arrives wrapped in a simulation error.
console.log('\n== relayed after the deadline ==');
while ((await fetchSlot()) <= deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
}
console.log(`  slot:     ${await fetchSlot()}`);
try {
    await relayer.ed25519Signer.instructions
        .submit({ message: authorization, signatures: [signature] })
        .sendTransaction();
    throw new Error('expected the relay to be rejected, but it landed');
} catch (error) {
    const cause = isSolanaError(error, SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION)
        ? unwrapSimulationError(error.cause)
        : error;
    if (
        !isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) ||
        cause.context.code !== LIGHTHOUSE_ERROR__ASSERTION_FAILED
    ) {
        throw new Error("expected Lighthouse's AssertionFailed", { cause: error });
    }
    console.log(`  rejected: ${cause.message} (Lighthouse's AssertionFailed)`);
}

console.log('\n== read back ==');
const { value: balance } = await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send();
console.log(`  recipient balance: ${balance} lamports`);
if (balance !== 0n) {
    throw new Error('the expired action moved funds');
}
// The expired action did not run, so the nonce did not move. The cold key can
// sign a new action over the same nonce.
const unchanged = await fetchNonce();
console.log(`  nonce:             ${unchanged} (unchanged)`);
if (unchanged !== nonce) {
    throw new Error('the nonce moved although the relay was rejected');
}
