/**
 * Cancels an action that the cold key has already signed.
 *
 * A signature cannot be taken back. But every action uses one nonce value,
 * and a nonce value can be used only once. So an action is cancelled by
 * getting something else to use its nonce value first.
 *
 * Here the cold key signs a transfer. In the same session it also signs a
 * revocation: an `Advance` instruction for the same nonce value, with no
 * other instruction beside it. The revocation is relayed first. It does
 * nothing except advance the nonce. When the transfer is relayed afterwards
 * it is rejected, and no funds move.
 *
 * Run with `just ts-cancel`.
 */

import { Keypair, PublicKey, SendTransactionError, SystemProgram } from '@solana/web3.js';

import {
    createInitializeEd25519,
    createSystemPassthroughInstruction,
    ED25519,
    fetchVectorAccount,
    findSystemPda,
    findVectorPda,
    revocationDigest,
    signAdvanceInstructionEd25519,
    signRevocationInstructionEd25519,
} from './client';
import { assertProgramDeployed, connect, fundedKeypair, sendTransaction } from './lib/cluster';

const AMOUNT = 10_000_000n;

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
await sendTransaction(
    connection,
    relayer,
    [
        createInitializeEd25519(relayer.publicKey, identity),
        SystemProgram.transfer({ fromPubkey: relayer.publicKey, lamports: 1_000_000_000n, toPubkey: systemPda }),
    ],
    [relayer],
);
const fetchNonce = async () => (await fetchVectorAccount(connection, ED25519, identity)).nonce;
const nonce = await fetchNonce();

console.log('== setup ==');
console.log(`  cold key:       ${signer.publicKey.toBase58()}`);
console.log(`  vector account: ${vector.toBase58()} (holds the nonce)`);
console.log(`  system PDA:     ${systemPda.toBase58()} (holds the funds)`);
console.log(`  nonce:          ${base58(nonce)}`);

// The cold key signs two things in one session. Both use the same nonce
// value. Only one of them can ever land: whichever lands first advances the
// nonce, and the other's signature then no longer verifies.
console.log('\n== signing on the cold side ==');
// The action is an ordinary transfer out of the system PDA.
const transfer = SystemProgram.transfer({ fromPubkey: systemPda, lamports: AMOUNT, toPubkey: recipient });
const passthrough = createSystemPassthroughInstruction(ED25519, identity, [transfer]);
const advance = signAdvanceInstructionEd25519(signingKey, nonce, [], [passthrough]);
// The revocation. It is an Advance instruction with nothing else in the
// transaction: no Passthrough, so no action runs. The program still advances
// the nonce, and that is all it does.
const revocation = signRevocationInstructionEd25519(signingKey, nonce);
const nextNonceValue = base58(revocationDigest(ED25519, nonce, identity));
console.log(`  action:     transfer ${AMOUNT} lamports from the system PDA`);
console.log('  revocation: an Advance on its own; only advances the nonce');
console.log(`  nonce after the revocation: ${nextNonceValue}`);

// From here on the cold key is not needed. The online side now holds both
// things it signed, the action and the revocation. Suppose it decides the
// transfer should not go ahead. It relays the revocation, which needs no
// new signature. The revocation has to be the only instruction in its
// transaction, because that is what was signed.
console.log('\n== relayed the revocation ==');
const landed = await sendTransaction(connection, relayer, [revocation], [relayer]);
console.log(`  landed:      ${landed}`);
const advanced = base58(await fetchNonce());
console.log(`  nonce after: ${advanced}`);
console.log(`  expected:    ${nextNonceValue}`);
if (advanced !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}

// Now relay the action. It is still a valid signed transaction. But its
// signature was made over the old nonce value, and the account now holds a
// different one. So the signature no longer verifies and the program rejects
// it. The RPC node sees this when it simulates the transaction, and does not
// send it.
console.log('\n== relayed the action afterwards ==');
try {
    await sendTransaction(connection, relayer, [advance, passthrough], [relayer]);
    throw new Error('expected the relay to be rejected, but it landed');
} catch (error) {
    // Vector reports a signature that does not verify as
    // `MissingRequiredSignature`. web3.js reports a rejected send as text
    // only, so this matches on the message. A structured error should ideally
    // be provided upstream.
    if (
        !(error instanceof SendTransactionError) ||
        !error.transactionError.message.includes('missing required signature')
    ) {
        throw new Error('expected MissingRequiredSignature', { cause: error });
    }
    console.log(`  rejected: ${error.transactionError.message}`);
}
const balance = await connection.getBalance(recipient);
console.log(`  recipient balance: ${balance} lamports`);
if (BigInt(balance) !== 0n) {
    throw new Error('the cancelled action moved funds');
}
