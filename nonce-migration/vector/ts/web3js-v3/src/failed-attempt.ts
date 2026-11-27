/**
 * A cold-signed action that fails can be relayed again later.
 *
 * The cold key signs a transfer the system PDA cannot afford. The relay lands
 * on chain and fails. A failed transaction is rolled back completely, and
 * here that includes the nonce. So the signature is still valid: once the PDA
 * is funded, the same two instructions land, with nothing signed again.
 *
 * A durable nonce transaction that landed and failed would have used up its
 * nonce. To stop an action from staying valid, sign it with a deadline; see
 * the `deadline` example.
 *
 * Run with `just ts-failed-attempt`.
 */

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import {
    advanceVectorDigest,
    createInitializeEd25519,
    createSystemPassthroughInstruction,
    ED25519,
    fetchVectorAccount,
    findSystemPda,
    findVectorPda,
    signAdvanceInstructionEd25519,
} from './client';
import {
    assertProgramDeployed,
    connect,
    fundedKeypair,
    sendTransaction,
    sendTransactionWithoutPreflight,
} from './lib/cluster';

const AMOUNT = 10_000_000n;
/** The System program's error for a transfer the source cannot afford. */
const SYSTEM_ERROR_INSUFFICIENT_FUNDS = 1;

/** A 32-byte nonce as base58, the way a blockhash is written. */
const base58 = (nonce: Uint8Array) => new PublicKey(nonce).toBase58();

const connection = connect();
await assertProgramDeployed(connection);

const relayer = await fundedKeypair(connection, 2_000_000_000);
const recipient = (await Keypair.generate()).publicKey;
const signer = await Keypair.generate();
// The SDK signs with the 32-byte seed, the first half of the secret key, and
// names the account by the public key.
const signingKey = signer.secretKey.slice(0, 32);
const identity = signer.publicKey.toBytes();
const [vector] = findVectorPda(ED25519, identity);
const [systemPda] = findSystemPda(vector);
await sendTransaction(connection, relayer, [createInitializeEd25519(relayer.publicKey, identity)], [relayer]);
const fetchNonce = async () => (await fetchVectorAccount(connection, ED25519, identity)).nonce;
const nonce = await fetchNonce();

console.log('== setup: the system PDA holds nothing ==');
console.log(`  cold key:       ${signer.publicKey.toBase58()}`);
console.log(`  vector account: ${vector.toBase58()} (holds the nonce)`);
console.log(`  system PDA:     ${systemPda.toBase58()} (unfunded)`);
console.log(`  nonce:          ${base58(nonce)}`);

// The cold key signs a transfer out of the system PDA. Signing needs no funds
// and no RPC, so nothing stops it from signing an action that cannot succeed
// yet. This signature has no expiry, which is the default.
console.log('\n== signing on the cold side ==');
const transfer = SystemProgram.transfer({ fromPubkey: systemPda, lamports: AMOUNT, toPubkey: recipient });
const passthrough = createSystemPassthroughInstruction(ED25519, identity, [transfer]);
const advance = signAdvanceInstructionEd25519(signingKey, nonce, [], [passthrough]);
const nextNonceValue = base58(advanceVectorDigest(ED25519, nonce, identity, [], [passthrough]));
const relay = [advance, passthrough];
console.log(`  action:     transfer ${AMOUNT} lamports from the system PDA`);
console.log(`  next nonce: ${nextNonceValue}`);

// The system PDA holds no funds, so this transfer cannot succeed yet. Relay it
// anyway, to see what a failed attempt leaves behind.
//
// Normally the RPC node would simulate the transaction first, see that it
// fails, and refuse to send it. Here it is told not to simulate, so the
// transaction really lands. On chain, the transfer fails inside the System
// program, and the whole transaction is rolled back with it.
console.log('\n== relayed while the system PDA is unfunded ==');
const failed = await sendTransactionWithoutPreflight(connection, relayer, relay, [relayer]);
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
    Number(instructionError.Custom) !== SYSTEM_ERROR_INSUFFICIENT_FUNDS
) {
    throw new Error('expected the transfer to fail for lack of funds');
}
console.log(`  failed:        custom program error ${SYSTEM_ERROR_INSUFFICIENT_FUNDS} (insufficient funds)`);
const failedTransaction = await connection.getTransaction(failed.signature, { maxSupportedTransactionVersion: 1 });
console.log(
    `  compute units: ${failedTransaction?.meta?.computeUnitsConsumed} (the relayer paid the fee for this attempt)`,
);
// This is the difference from a durable nonce. A durable nonce transaction
// that lands and fails still uses up its nonce. Here the nonce advance was
// rolled back with everything else, so the nonce has not moved.
const unchanged = base58(await fetchNonce());
console.log(`  nonce after:   ${unchanged} (unchanged)`);
if (unchanged !== base58(nonce)) {
    throw new Error('the nonce moved although the relay failed');
}

// Now fund the system PDA and relay again. Nothing is signed again: these are
// the exact same two signed instructions that failed a moment ago.
//
// This time it lands. A failed attempt does not use up a signed action. The
// action stays valid until the nonce moves. So it can be retried without the
// cold key coming back online, and anyone who has a copy can relay it, at any
// later time.
console.log('\n== relayed again after the system PDA is funded ==');
await sendTransaction(
    connection,
    relayer,
    [SystemProgram.transfer({ fromPubkey: relayer.publicKey, lamports: 1_000_000_000n, toPubkey: systemPda })],
    [relayer],
);
const landed = await sendTransaction(connection, relayer, relay, [relayer]);
console.log(`  landed:            ${landed}`);
const balance = await connection.getBalance(recipient);
console.log(`  recipient balance: ${balance} lamports`);
if (BigInt(balance) !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT} lamports`);
}
const advancedNonce = await fetchNonce();
console.log(`  nonce after:       ${base58(advancedNonce)}`);
console.log(`  expected:          ${nextNonceValue}`);
if (base58(advancedNonce) !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}
