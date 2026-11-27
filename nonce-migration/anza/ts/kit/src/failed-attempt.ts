/**
 * A cold-signed action that fails can be relayed again later.
 *
 * The cold key signs a transfer the PDA cannot afford. The relay lands on
 * chain and fails. A failed transaction is rolled back completely, and here
 * that includes the nonce. So the signed authorization is still valid: once
 * the PDA is funded, the same bytes land, with nothing signed again.
 *
 * A durable nonce transaction that landed and failed would have used up its
 * nonce. To stop an action from staying valid, sign it with a deadline; see
 * the `deadline` example.
 *
 * Run with `just ts-failed-attempt`.
 */

import { findProgrammaticSignerPda, getSubmitInstruction } from '@solana-program/ed25519-programmatic-signer';
import { getTransferSolInstruction, SYSTEM_ERROR__RESULT_WITH_NEGATIVE_LAMPORTS } from '@solana-program/system';
import { createNoopSigner, generateKeyPairSigner, lamports, signBytes, singleInstructionPlan } from '@solana/kit';

import { assertProgramsDeployed, createFundedClient, sendTransactionWithoutPreflight } from './lib/cluster';
import { authorizationMessage, executionMessage } from './lib/signer';
import { createNonceAccount, nextNonce } from './lib/spl-nonce';

const AMOUNT = 10_000_000n;

const relayer = await createFundedClient(2_000_000_000n);
await assertProgramsDeployed(relayer.rpc);
const recipient = (await generateKeyPairSigner()).address;
const authority = await generateKeyPairSigner();
const [pda] = await findProgrammaticSignerPda({ authority: authority.address });
const nonceAccount = await createNonceAccount(relayer, pda);
const fetchNonce = async () => (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data.nonce;
const fetchBalance = async () => (await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send()).value;
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

// Now fund the PDA and relay again. Nothing is signed again: these are the
// exact same signed bytes that failed a moment ago.
//
// This time it lands. A failed attempt does not use up a signed action. The
// action stays valid until the nonce moves. So it can be retried without the
// cold key coming back online, and anyone who has a copy can relay it, at any
// later time.
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
