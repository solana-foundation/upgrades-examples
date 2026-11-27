/**
 * Signs several actions at once, and relays them in any order.
 *
 * A vector account holds one nonce value, and an action uses that value up.
 * So two actions signed over the vector account's own nonce can only land one
 * after the other, in the order they were signed.
 *
 * To have actions that land independently, Vector has nonce accounts. A nonce
 * account is a separate small account that holds a nonce of its own. The same
 * cold key signs over it, and the funds stay where they are. Here the cold
 * key signs three transfers in one session, each over its own nonce account,
 * and the hot key relays them in a different order.
 *
 * Run with `just ts-parallel`.
 */

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import {
    advanceMessage,
    createInitializeEd25519,
    createInitializeNonceInstruction,
    createMultiAdvanceInstruction,
    createSystemPassthroughInstruction,
    ED25519,
    fetchNonceAccount,
    fetchVectorAccount,
    findSystemPda,
    findVectorPda,
    NONCE_ACCOUNT_LEN,
    PROGRAM_ID,
    signDigestEd25519,
    signedNonce,
    signerDigest,
} from './client';
import { assertProgramDeployed, connect, fundedKeypair, sendTransaction } from './lib/cluster';

/** What each of the three actions transfers. */
const AMOUNTS = [10_000_000n, 20_000_000n, 30_000_000n];
/**
 * The order the actions are relayed in: the third, then the first, then the
 * second.
 */
const RELAY_ORDER = [2, 0, 1];

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

console.log('== setup: one vector account, three nonce accounts ==');
console.log(`  cold key:       ${signer.publicKey.toBase58()}`);
console.log(`  vector account: ${vector.toBase58()}`);
console.log(`  system PDA:     ${systemPda.toBase58()} (holds the funds)`);
// Create one nonce account per action. A nonce account is an ordinary account
// with its own keypair. It is created with the System program, handed to the
// Vector program, and then initialized for one vector account. The new
// account's key signs both steps. The relayer pays the rent. Only the vector
// account's cold key can sign over the nonce account afterwards.
const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LEN);
const nonceAccounts = [];
while (nonceAccounts.length < AMOUNTS.length) {
    const nonceAccount = await Keypair.generate();
    await sendTransaction(
        connection,
        relayer,
        [
            SystemProgram.createAccount({
                fromPubkey: relayer.publicKey,
                lamports: rent,
                newAccountPubkey: nonceAccount.publicKey,
                programId: PROGRAM_ID,
                space: NONCE_ACCOUNT_LEN,
            }),
            createInitializeNonceInstruction(nonceAccount.publicKey, vector),
        ],
        [relayer, nonceAccount],
    );
    console.log(`  nonce account:  ${nonceAccount.publicKey.toBase58()}`);
    nonceAccounts.push(nonceAccount.publicKey);
}
// A nonce account cannot be used in the slot it was created in. Wait for the
// next slot before going on.
const created = await connection.getSlot();
while ((await connection.getSlot()) <= created) {
    await new Promise(resolve => setTimeout(resolve, 400));
}

// The cold key signs all three transfers in one session. Each transfer names
// a different nonce account, so none of them depends on another.
//
// Signing over a nonce account takes three steps:
//   1. build the message, with the nonce account listed after the vector
//      account;
//   2. compute this account's digest of the message, and sign it. The nonce
//      that goes into the digest is a hash of the nonce account's nonce and
//      the vector account's own nonce;
//   3. put the signature into an Advance instruction.
console.log('\n== signing on the cold side ==');
const { nonce: vectorNonce } = await fetchVectorAccount(connection, ED25519, identity);
const actions = [];
for (const [index, nonceAccount] of nonceAccounts.entries()) {
    const amount = AMOUNTS[index]!;
    const { nonce } = await fetchNonceAccount(connection, nonceAccount);
    const transfer = SystemProgram.transfer({ fromPubkey: systemPda, lamports: amount, toPubkey: recipient });
    const passthrough = createSystemPassthroughInstruction(ED25519, identity, [transfer]);
    const advanceSigner = { identity, nonceAccount, scheme: ED25519 };
    const message = advanceMessage([advanceSigner], [], [passthrough]);
    const digest = signerDigest(message, signedNonce(nonce, vectorNonce), vector);
    const advance = createMultiAdvanceInstruction([
        { ...advanceSigner, signature: signDigestEd25519(signingKey, digest) },
    ]);
    console.log(`  action: transfer ${amount} lamports, over ${nonceAccount.toBase58()}`);
    // The digest is also the value the nonce account moves to.
    actions.push({ instructions: [advance, passthrough], nextNonceValue: base58(digest) });
}

// The hot side relays them in a different order from the one they were signed
// in. Each one lands, because each uses its own nonce account.
console.log('\n== relayed out of order ==');
for (const index of RELAY_ORDER) {
    const landed = await sendTransaction(connection, relayer, actions[index]!.instructions, [relayer]);
    console.log(`  transfer of ${AMOUNTS[index]} lamports landed: ${landed}`);
}

console.log('\n== read back ==');
const balance = BigInt(await connection.getBalance(recipient));
const total = AMOUNTS.reduce((sum, amount) => sum + amount, 0n);
console.log(`  recipient balance: ${balance} lamports (all three transfers)`);
if (balance !== total) {
    throw new Error(`expected the recipient to hold ${total} lamports`);
}
// Each nonce account advanced once, to the value computed when its action was
// signed.
for (const [index, nonceAccount] of nonceAccounts.entries()) {
    const advanced = base58((await fetchNonceAccount(connection, nonceAccount)).nonce);
    console.log(`  ${nonceAccount.toBase58()} nonce: ${advanced}`);
    if (advanced !== actions[index]!.nextNonceValue) {
        throw new Error('the nonce did not advance to the value computed at signing time');
    }
}
// The vector account's own nonce was not used, so it has not moved.
const unchanged = base58((await fetchVectorAccount(connection, ED25519, identity)).nonce);
console.log(`  vector account nonce: ${unchanged} (unchanged)`);
if (unchanged !== base58(vectorNonce)) {
    throw new Error("the vector account's own nonce moved");
}
