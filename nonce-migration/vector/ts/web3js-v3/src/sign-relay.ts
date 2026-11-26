/**
 * Signs a SOL transfer with a cold key that never goes online, then relays it
 * after the blockhash that was current at signing time has expired.
 *
 * The same transfer is sent twice. First as a System durable nonce
 * transaction, the flow being replaced. Then through Vector: the cold key
 * signs a digest of two instructions, a hot relayer puts them in a
 * transaction with a fresh blockhash, and the system PDA that acts for the
 * cold key pays. Afterwards the nonce has advanced to the value computed at
 * signing time, and relaying the same instructions again is rejected.
 *
 * Run with `just ts-sign-relay`.
 */

import { Keypair, PublicKey, SendTransactionError, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

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
import { assertProgramDeployed, connect, fundedKeypair, sendTransaction, waitForBlockhashExpiry } from './lib/cluster';
import { createDurableNonceAccount, fetchDurableNonce, signDurableNonceTransfer } from './lib/durable-nonce';

const AMOUNT = 10_000_000n;

/** A 32-byte nonce as base58, the way a blockhash is written. */
const base58 = (nonce: Uint8Array) => new PublicKey(nonce).toBase58();

const connection = connect();
await assertProgramDeployed(connection);

const relayer = await fundedKeypair(connection, 2_000_000_000);
const recipient = (await Keypair.generate()).publicKey;

// The flow being replaced. The cold key holds the funds and pays the fee, so
// it has to be funded, and it signs a whole transaction.
console.log('== before: a System durable nonce transaction ==');
const cold = await fundedKeypair(connection, 1_000_000_000);
const durableNonceAccount = await createDurableNonceAccount(connection, cold);
const durableNonce = await fetchDurableNonce(connection, durableNonceAccount);
const durable = await signDurableNonceTransfer(cold, durableNonceAccount, durableNonce, recipient, AMOUNT);
console.log(`  nonce account: ${durableNonceAccount.toBase58()}`);
console.log(`  nonce:         ${durableNonce}`);
console.log(`  signed by:     ${cold.publicKey.toBase58()} (the cold key, which also pays)`);
console.log(`  size:          ${durable.serialize().length} bytes`);
const durableSignature = await connection.sendTransaction(durable);
await connection.confirmTransaction({
    nonceAccountPubkey: durableNonceAccount,
    nonceValue: durableNonce,
    signature: durableSignature,
});
console.log(`  landed:        ${durableSignature}`);
console.log(
    `  nonce after:   ${await fetchDurableNonce(connection, durableNonceAccount)} (a future blockhash; not knowable at signing time)`,
);

// The replacement. The cold key is never funded and never signs a
// transaction. Two addresses derived from it act for it: a vector account
// that holds the nonce, and its system PDA that holds the funds.
console.log('\n== after: a Vector advance ==');
const signer = await Keypair.generate();
// The SDK signs with the 32-byte seed, the first half of the secret key, and
// names the account by the public key.
const signingKey = signer.secretKey.slice(0, 32);
const identity = signer.publicKey.toBytes();
const [vector] = findVectorPda(ED25519, identity);
const [systemPda] = findSystemPda(vector);
console.log(`  cold key:       ${signer.publicKey.toBase58()} (holds nothing, signs one digest)`);
console.log(`  vector account: ${vector.toBase58()} (holds the nonce; the relayer creates it)`);
console.log(`  system PDA:     ${systemPda.toBase58()} (holds the funds; nothing to create)`);

// Create the vector account. The relayer pays the rent and the cold key does
// not sign; only its public key is stored.
await sendTransaction(connection, relayer, [createInitializeEd25519(relayer.publicKey, identity)], [relayer]);

// Fund the system PDA. It is a plain System-owned address, so this is an
// ordinary transfer; in a migration it is where the cold key's SOL moves to.
await sendTransaction(
    connection,
    relayer,
    [SystemProgram.transfer({ fromPubkey: relayer.publicKey, lamports: 1_000_000_000n, toPubkey: systemPda })],
    [relayer],
);
const { nonce } = await fetchVectorAccount(connection, ED25519, identity);
console.log(`  nonce:          ${base58(nonce)}`);

// The cold side. Nothing below needs an RPC once the nonce value is known:
// the action is wrapped in a Passthrough instruction to run as the system
// PDA, and `signAdvanceInstructionEd25519` signs a digest of it with the cold
// key and returns the Advance instruction that carries the signature. The
// digest names no fee payer, so any funded key can relay, and it is also the
// nonce the account moves to.
console.log('\n== signing on the cold side ==');
const transfer = SystemProgram.transfer({ fromPubkey: systemPda, lamports: AMOUNT, toPubkey: recipient });
const passthrough = createSystemPassthroughInstruction(ED25519, identity, [transfer]);
const advance = signAdvanceInstructionEd25519(signingKey, nonce, [], [passthrough]);
const nextNonceValue = base58(advanceVectorDigest(ED25519, nonce, identity, [], [passthrough]));
console.log(
    `  Advance instruction:     ${advance.data.length} bytes of data: the signature, and an expiry slot of never`,
);
console.log(`  Passthrough instruction: ${passthrough.data.length} bytes of data, holding the transfer`);
console.log(`  next nonce:              ${nextNonceValue} (known before anything is sent)`);

// A transaction signed now would expire with this blockhash. The two
// instructions do not use a blockhash as their lifetime, so they do not.
const { blockhash: blockhashAtSigning } = await connection.getLatestBlockhash();
if (process.env.VECTOR_SKIP_EXPIRY) {
    console.log(`\n== skipping the wait for blockhash ${blockhashAtSigning} to expire ==`);
} else {
    console.log(`\n== waiting for blockhash ${blockhashAtSigning} to expire (150 slots) ==`);
    await waitForBlockhashExpiry(connection, blockhashAtSigning);
    console.log('  expired; a transaction signed alongside the instructions would now be dropped');
}

// An edited payment. A relayer that swaps in a larger amount still holds only
// the signature over the original, so the digest the program rebuilds is not
// the one that was signed.
console.log('\n== relayed with the amount edited ==');
const edited = SystemProgram.transfer({ fromPubkey: systemPda, lamports: 2n * AMOUNT, toPubkey: recipient });
await expectRejected([advance, createSystemPassthroughInstruction(ED25519, identity, [edited])]);

// The hot side. Any funded key can relay. It cannot modify the two
// instructions, because the cold key has signed a digest of them; it adds
// only the blockhash, the fee, and the compute budget.
console.log('\n== relayed ==');
const relay = [advance, passthrough];
const relaySignature = await sendTransaction(connection, relayer, relay, [relayer]);
const fetched = await connection.getTransaction(relaySignature, { maxSupportedTransactionVersion: 1 });
if (fetched === null) {
    throw new Error(`transaction ${relaySignature} was not found`);
}
const { message } = fetched.transaction;
const relaySigners = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures);
if (relaySigners.some(address => address.equals(signer.publicKey))) {
    throw new Error('the cold key must not sign the relay transaction');
}
console.log(
    `  relay transaction: ${message.serialize().length + 64 * relaySigners.length} bytes, v1, signed by ${JSON.stringify(relaySigners.map(address => address.toBase58()))} (the relayer)`,
);
console.log(`  landed:            ${relaySignature}`);
console.log(`  compute units:     ${fetched.meta?.computeUnitsConsumed}`);

console.log('\n== read back ==');
const balance = await connection.getBalance(recipient);
console.log(`  recipient balance: ${balance} lamports (both transfers)`);
if (BigInt(balance) !== 2n * AMOUNT) {
    throw new Error(`expected the recipient to hold ${2n * AMOUNT} lamports`);
}
const advanced = base58((await fetchVectorAccount(connection, ED25519, identity)).nonce);
console.log(`  nonce after:       ${advanced}`);
console.log(`  expected:          ${nextNonceValue}`);
if (advanced !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}

// The nonce the signature covers is gone, so the signature no longer
// verifies.
console.log('\n== relayed again ==');
await expectRejected(relay);

/**
 * Relays `instructions` and throws unless the relay is rejected with
 * `MissingRequiredSignature`, which is how Vector reports a signature that
 * does not match the transaction. web3.js reports a rejected send as text
 * only, so this matches on the message; a structured error should ideally be
 * provided upstream.
 */
async function expectRejected(instructions: TransactionInstruction[]) {
    try {
        await sendTransaction(connection, relayer, instructions, [relayer]);
    } catch (error) {
        if (
            !(error instanceof SendTransactionError) ||
            !error.transactionError.message.includes('missing required signature')
        ) {
            throw new Error('expected MissingRequiredSignature', { cause: error });
        }
        console.log(`  rejected: ${error.transactionError.message}`);
        return;
    }
    throw new Error('expected a rejection, but the relay landed');
}
