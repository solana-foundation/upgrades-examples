/**
 * Signs an action with a deadline. After the deadline, it cannot be relayed.
 *
 * A signed action stays valid until its nonce moves. A deadline ends that
 * earlier. Vector has one built in: the `Advance` instruction carries a last
 * valid slot, and the program rejects the instruction after that slot.
 *
 * Here the cold key signs a transfer with a deadline. The example waits until
 * the deadline has passed and then relays. The relay is rejected, no funds
 * move, and the nonce is unchanged.
 *
 * Run with `just ts-deadline`.
 */

import { Keypair, PublicKey, SendTransactionError, SystemProgram } from '@solana/web3.js';

import {
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
/**
 * How many slots after signing the action stays valid. It is short so the
 * example finishes quickly; a real deadline would be much further out.
 */
const DEADLINE_SLOTS = 20n;

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

// The cold key signs a transfer with a deadline. The deadline is a slot
// number, and it goes into the Advance instruction. The cold key's signature
// covers it, so a relayer cannot remove or extend it. The deadline is the
// last argument of the signing function. The argument before it is the fee
// payer, which this action does not name.
console.log('\n== signing on the cold side ==');
const deadline = BigInt(await connection.getSlot()) + DEADLINE_SLOTS;
const transfer = SystemProgram.transfer({ fromPubkey: systemPda, lamports: AMOUNT, toPubkey: recipient });
const passthrough = createSystemPassthroughInstruction(ED25519, identity, [transfer]);
const advance = signAdvanceInstructionEd25519(signingKey, nonce, [], [passthrough], undefined, deadline);
console.log(`  action:   transfer ${AMOUNT} lamports from the system PDA`);
console.log(`  deadline: slot ${deadline} (${DEADLINE_SLOTS} slots from now)`);

// Wait until the deadline has passed, then relay. The system PDA has the
// funds, so the only thing in the way is the deadline. The RPC node simulates
// the transaction, sees the Advance instruction fail, and rejects it.
//
// web3.js reports a rejected send as text only, so the check below matches on
// the message. A structured error should ideally be provided upstream.
console.log('\n== relayed after the deadline ==');
while (BigInt(await connection.getSlot()) <= deadline) {
    await new Promise(resolve => setTimeout(resolve, 400));
}
console.log(`  slot:     ${await connection.getSlot()}`);
try {
    await sendTransaction(connection, relayer, [advance, passthrough], [relayer]);
    throw new Error('expected the relay to be rejected, but it landed');
} catch (error) {
    if (
        !(error instanceof SendTransactionError) ||
        !error.transactionError.message.endsWith(`custom program error: 0x${VectorError.Expired.toString(16)}`)
    ) {
        throw new Error("expected Vector's Expired", { cause: error });
    }
    console.log(`  rejected: ${error.transactionError.message} (Vector's Expired)`);
}

console.log('\n== read back ==');
const balance = BigInt(await connection.getBalance(recipient));
console.log(`  recipient balance: ${balance} lamports`);
if (balance !== 0n) {
    throw new Error('the expired action moved funds');
}
// The expired action did not run, so the nonce did not move. The cold key can
// sign a new action over the same nonce.
const unchanged = base58(await fetchNonce());
console.log(`  nonce:             ${unchanged} (unchanged)`);
if (unchanged !== base58(nonce)) {
    throw new Error('the nonce moved although the relay was rejected');
}
