/**
 * Signs on a machine that has no network connection.
 *
 * The work is split into three steps:
 *   1. Online: read the nonce, build the action, and compute the digest the
 *      cold key has to sign.
 *   2. `reviewAndSign` runs on the cold machine. It is not given a
 *      connection, so it cannot make a network call. It receives the digest,
 *      shows what it is about to sign, and signs it.
 *   3. Online: put the signature into an Advance instruction and send it with
 *      the action.
 *
 * On Vector the cold key signs a digest, which is a hash. The action cannot
 * be read back out of a hash. So the cold machine shows the same thing a
 * hardware wallet shows: the text `vector:` followed by the digest. The
 * operator has to trust that the online side computed the digest from the
 * action they intend.
 *
 * Run with `just ts-airgapped`.
 */

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import {
    advanceVectorDigest,
    createAdvanceInstruction,
    createInitializeEd25519,
    createSystemPassthroughInstruction,
    ED25519,
    fetchVectorAccount,
    findSystemPda,
    findVectorPda,
    signDigestEd25519,
    signedMessage,
} from './client';
import { assertProgramDeployed, connect, fundedKeypair, sendTransaction } from './lib/cluster';

const AMOUNT = 10_000_000n;

/**
 * Step 2, on the cold machine. It has no connection, so it cannot reach the
 * network.
 *
 * It receives the digest. What the key signs is 39 bytes: the text `vector:`
 * and then the digest. It prints those bytes the way a hardware wallet would,
 * and signs them.
 */
function reviewAndSign(signingKey: Uint8Array, digest: Uint8Array): Uint8Array {
    const message = signedMessage(digest);
    console.log(`  signing: vector:${Buffer.from(digest).toString('hex')}`);
    console.log(`  (${message.length} bytes; the action cannot be read from them)`);
    return signDigestEd25519(signingKey, digest);
}

// Setup, done online by the relayer. The vector account is created and its
// system PDA is funded. Neither step needs the cold key to sign; only its
// public key is used.
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
console.log('== setup ==');
console.log(`  cold key:       ${signer.publicKey.toBase58()}`);
console.log(`  vector account: ${vector.toBase58()} (holds the nonce)`);
console.log(`  system PDA:     ${systemPda.toBase58()} (holds the funds)`);

// Step 1, online. Read the nonce, build the Passthrough instruction that
// holds the transfer, and compute the digest of it. Nothing is signed here;
// only the cold key's public key is needed.
console.log('\n== online: prepare the digest ==');
const { nonce } = await fetchVectorAccount(connection, ED25519, identity);
const transfer = SystemProgram.transfer({ fromPubkey: systemPda, lamports: AMOUNT, toPubkey: recipient });
const passthrough = createSystemPassthroughInstruction(ED25519, identity, [transfer]);
const digest = advanceVectorDigest(ED25519, nonce, identity, [], [passthrough]);
console.log(`  action: transfer ${AMOUNT} lamports to ${recipient.toBase58()}`);
console.log('  to the cold machine: the digest, 32 bytes');

console.log('\n== offline: review and sign ==');
const signature = reviewAndSign(signingKey, digest);
console.log('  to the online machine: the signature, 64 bytes');

// Step 3, online. Put the cold key's signature into an Advance instruction
// and send it together with the Passthrough instruction. Any funded key can
// relay. It cannot change the action, because the signature is over a digest
// of it.
console.log('\n== online: relay ==');
const advance = createAdvanceInstruction(ED25519, identity, signature);
const landed = await sendTransaction(connection, relayer, [advance, passthrough], [relayer]);
console.log(`  landed: ${landed}`);

console.log('\n== read back ==');
const balance = BigInt(await connection.getBalance(recipient));
console.log(`  recipient balance: ${balance} lamports`);
if (balance !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT} lamports`);
}
// The digest the cold key signed is also the value the nonce moves to.
const advanced = new PublicKey((await fetchVectorAccount(connection, ED25519, identity)).nonce);
console.log(`  nonce after:       ${advanced.toBase58()}`);
if (!advanced.equals(new PublicKey(digest))) {
    throw new Error('the nonce did not advance to the digest that was signed');
}
