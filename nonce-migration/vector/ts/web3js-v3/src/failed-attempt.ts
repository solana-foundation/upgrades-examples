/**
 * A cold-signed action that fails can be relayed again later, and a deadline
 * is what stops that.
 *
 * First the hazard. The cold key signs a transfer the system PDA cannot
 * afford. The relay fails and rolls back completely, the nonce included, so
 * the signature is still valid: once the PDA is funded, the same two
 * instructions land. A durable nonce transaction would have burned its nonce
 * on the first try.
 *
 * Then the fix. The cold key signs a second transfer with a deadline, the
 * last slot the `Advance` instruction accepts. Relayed after that slot, it is
 * rejected, and it always will be.
 *
 * Run with `just ts-failed-attempt`.
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
    VectorError,
} from './client';
import { assertProgramDeployed, connect, fundedKeypair, sendTransaction } from './lib/cluster';

const AMOUNT = 10_000_000n;
/** How many slots after signing the second action stays valid. */
const DEADLINE_SLOTS = 20n;
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

// The transfer fails inside the System program, and the whole transaction
// rolls back with it. The nonce is part of that: it has not moved.
console.log('\n== relayed while the system PDA is unfunded ==');
await expectRejected(relay, SYSTEM_ERROR_INSUFFICIENT_FUNDS, "the System program's insufficient funds error");
const unchanged = base58(await fetchNonce());
console.log(`  nonce after: ${unchanged} (unchanged)`);
if (unchanged !== base58(nonce)) {
    throw new Error('the nonce moved although the relay failed');
}

// The hazard. Nothing was signed again: these are the same instructions, sent
// after the system PDA was funded. Anyone who kept them could do this, at any
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

// The fix. The Advance instruction carries a last valid slot, and the cold
// key's signature covers it, so a relayer cannot remove or extend it. It is
// the last argument of the same signing function.
console.log('\n== signing a second action with a deadline ==');
const deadline = BigInt(await connection.getSlot()) + DEADLINE_SLOTS;
const timedAdvance = signAdvanceInstructionEd25519(signingKey, advancedNonce, [], [passthrough], undefined, deadline);
console.log(`  action:   transfer ${AMOUNT} lamports from the system PDA`);
console.log(`  deadline: slot ${deadline} (${DEADLINE_SLOTS} slots from now)`);

// Hold the two instructions back until the deadline has passed. The system
// PDA has the funds this time; only the deadline is in the way.
console.log('\n== relayed after the deadline ==');
while (BigInt(await connection.getSlot()) <= deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
}
console.log(`  slot:        ${await connection.getSlot()}`);
await expectRejected([timedAdvance, passthrough], VectorError.Expired, "Vector's Expired");
if (BigInt(await connection.getBalance(recipient)) !== AMOUNT) {
    throw new Error('the expired action moved funds');
}
// The nonce did not move, so the cold key can sign a replacement over it.
const stillUnchanged = base58(await fetchNonce());
console.log(`  nonce after: ${stillUnchanged} (unchanged; a new action can use it)`);
if (stillUnchanged !== base58(advancedNonce)) {
    throw new Error('the nonce moved although the relay failed');
}

/**
 * Relays `instructions` and throws unless the relay is rejected with the
 * custom program error `code`. web3.js reports a rejected send as text only,
 * so this matches on the message; a structured error should ideally be
 * provided upstream.
 */
async function expectRejected(instructions: TransactionInstruction[], code: number, name: string) {
    try {
        await sendTransaction(connection, relayer, instructions, [relayer]);
    } catch (error) {
        if (
            !(error instanceof SendTransactionError) ||
            !error.transactionError.message.endsWith(`custom program error: 0x${code.toString(16)}`)
        ) {
            throw new Error(`expected ${name}`, { cause: error });
        }
        console.log(`  rejected: ${error.transactionError.message} (${name})`);
        return;
    }
    throw new Error(`expected ${name}, but the relay landed`);
}
