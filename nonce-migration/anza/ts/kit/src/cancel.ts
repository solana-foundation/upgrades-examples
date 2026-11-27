/**
 * Cancels an action that the cold key has already signed.
 *
 * A signature cannot be taken back. But every action uses one nonce value,
 * and a nonce value can be used only once. So an action is cancelled by
 * getting something else to use its nonce value first.
 *
 * Here the cold key signs a transfer. In the same session it also signs a
 * cancellation: a second authorization for the same nonce value, with no
 * instructions inside. The cancellation is relayed first. It does nothing
 * except advance the nonce. When the transfer is relayed afterwards it is
 * rejected, and no funds move.
 *
 * Run with `just ts-cancel`.
 */

import {
    findProgrammaticSignerPda,
    MESSAGE_EXECUTOR_ERROR__NONCE_MISMATCH,
} from '@solana-program/ed25519-programmatic-signer';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    createNoopSigner,
    generateKeyPairSigner,
    isSolanaError,
    lamports,
    sequentialInstructionPlan,
    signBytes,
    singleInstructionPlan,
    SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    unwrapSimulationError,
} from '@solana/kit';

import { assertProgramsDeployed, createFundedClient } from './lib/cluster';
import { authorizationMessage, executionMessage } from './lib/signer';
import { createNonceAccount, nextNonce } from './lib/spl-nonce';

const AMOUNT = 10_000_000n;

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
const nonce = await fetchNonce();

console.log('== setup ==');
console.log(`  authority:     ${authority.address} (cold)`);
console.log(`  pda:           ${pda} (holds the funds)`);
console.log(`  nonce account: ${nonceAccount}`);
console.log(`  nonce:         ${nonce}`);

// The cold key signs two authorizations in one session. Both use the same
// nonce value. Only one of them can ever land: whichever lands first advances
// the nonce, and the other then names a value that is gone.
console.log('\n== signing on the cold side ==');
// The action is an ordinary transfer out of the PDA.
const transfer = getTransferSolInstruction({ amount: AMOUNT, destination: recipient, source: createNoopSigner(pda) });
const action = authorizationMessage(executionMessage(pda, singleInstructionPlan(transfer), nonce), nonceAccount, pda, [
    authority.address,
]);
const actionSignature = await signBytes(authority.keyPair.privateKey, action);
// The cancellation. It is built the same way as the action, but its execution
// message has no instructions. The Executor still advances the nonce when it
// runs it, and that is all it does.
const emptyExecution = executionMessage(pda, sequentialInstructionPlan([]), nonce);
const cancellation = authorizationMessage(emptyExecution, nonceAccount, pda, [authority.address]);
const cancellationSignature = await signBytes(authority.keyPair.privateKey, cancellation);
const nextNonceValue = await nextNonce(nonceAccount, nonce, emptyExecution);
console.log(`  action:       transfer ${AMOUNT} lamports from the PDA`);
console.log('  cancellation: no instructions; only advances the nonce');
console.log(`  nonce after the cancellation: ${nextNonceValue}`);

// From here on the cold key is not needed. The online side now holds both
// signed authorizations, the action and the cancellation. Suppose it
// decides the transfer should not go ahead. It relays the cancellation,
// which needs no new signature.
console.log('\n== relayed the cancellation ==');
const { context: relay } = await relayer.ed25519Signer.instructions
    .submit({ message: cancellation, signatures: [cancellationSignature] })
    .sendTransaction();
console.log(`  landed:      ${relay.signature}`);
const advanced = await fetchNonce();
console.log(`  nonce after: ${advanced}`);
console.log(`  expected:    ${nextNonceValue}`);
if (advanced !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}

// Now relay the action. It is still a valid signed transaction. But it names
// the old nonce value, and the nonce account now holds a different one, so the
// Executor rejects it. The RPC node sees this when it simulates the
// transaction, and does not send it.
console.log('\n== relayed the action afterwards ==');
try {
    await relayer.ed25519Signer.instructions
        .submit({ message: action, signatures: [actionSignature] })
        .sendTransaction();
    throw new Error('expected the relay to be rejected, but it landed');
} catch (error) {
    // The client simulates before sending, so the rejection arrives wrapped
    // in a simulation error.
    const cause = isSolanaError(error, SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION)
        ? unwrapSimulationError(error.cause)
        : error;
    if (
        !isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) ||
        cause.context.code !== MESSAGE_EXECUTOR_ERROR__NONCE_MISMATCH
    ) {
        throw new Error("expected the Executor's NonceMismatch", { cause: error });
    }
    console.log(`  rejected: ${cause.message} (the Executor's NonceMismatch)`);
}
const { value: balance } = await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send();
console.log(`  recipient balance: ${balance} lamports`);
if (balance !== 0n) {
    throw new Error('the cancelled action moved funds');
}
