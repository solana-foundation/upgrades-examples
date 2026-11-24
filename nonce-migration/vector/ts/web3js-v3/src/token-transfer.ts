/**
 * Signs a token withdrawal with a cold key that never goes online, then
 * relays it from a hot key: the system PDA moves 250 of a Token program mint,
 * the kind USDC is, to a recipient whose token account does not exist yet and
 * creates that account on the way.
 *
 * Run with `just ts-token-transfer`.
 */

import {
    getCreateMintInstructionPlan,
    getMintToATAInstructionPlanAsync,
    getTransferToATAInstructionPlanAsync,
} from '@solana-program/token';
import { createNoopSigner } from '@solana/kit';
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
import { assertProgramDeployed, connect, fundedKeypair, sendTransaction } from './lib/cluster';
import { associatedTokenAddress, DECIMALS, fetchBalance, toTransactionInstructions, uiAmount } from './lib/token';

/** 1,000 tokens at six decimals: what the system PDA holds. */
const SUPPLY = 1_000_000_000n;
/** 250 tokens: what the withdrawal moves. */
const AMOUNT = 250_000_000n;

/** A 32-byte nonce as base58, the way a blockhash is written. */
const base58 = (nonce: Uint8Array) => new PublicKey(nonce).toBase58();

const connection = connect();
await assertProgramDeployed(connection);

const relayer = await fundedKeypair(connection, 5_000_000_000);
const signer = await Keypair.generate();
// The SDK signs with the 32-byte seed, the first half of the secret key, and
// names the account by the public key.
const signingKey = signer.secretKey.slice(0, 32);
const identity = signer.publicKey.toBytes();
const [vector] = findVectorPda(ED25519, identity);
const [systemPda] = findSystemPda(vector);
const recipient = (await Keypair.generate()).publicKey;

console.log('== setup: the system PDA holds 1,000 tokens ==');
console.log(`  cold key:       ${signer.publicKey.toBase58()}`);
console.log(`  vector account: ${vector.toBase58()} (holds the nonce)`);
console.log(`  system PDA:     ${systemPda.toBase58()} (owns the token account)`);
// The system PDA pays the rent of the token account it creates for the
// recipient, so it needs some SOL as well as tokens.
await sendTransaction(
    connection,
    relayer,
    [
        createInitializeEd25519(relayer.publicKey, identity),
        SystemProgram.transfer({ fromPubkey: relayer.publicKey, lamports: 100_000_000n, toPubkey: systemPda }),
    ],
    [relayer],
);
const newMint = await Keypair.generate();
const mint = newMint.publicKey;
await sendTransaction(
    connection,
    relayer,
    toTransactionInstructions(
        await getCreateMintInstructionPlan(connection, {
            decimals: DECIMALS,
            mintAuthority: relayer.address,
            newMint,
            payer: relayer,
        }),
    ),
    [relayer, newMint],
);
await sendTransaction(
    connection,
    relayer,
    toTransactionInstructions(
        await getMintToATAInstructionPlanAsync({
            amount: SUPPLY,
            decimals: DECIMALS,
            mint: mint.address,
            mintAuthority: relayer,
            owner: systemPda.address,
            payer: relayer,
        }),
    ),
    [relayer],
);
const pdaAccount = await associatedTokenAddress(systemPda, mint);
console.log(`  mint:        ${mint.toBase58()}`);
console.log(`  PDA account: ${pdaAccount.toBase58()} holds ${uiAmount(await fetchBalance(connection, pdaAccount))}`);
console.log(`  recipient:   ${recipient.toBase58()} (no token account yet; the PDA creates it)`);
const { nonce } = await fetchVectorAccount(connection, ED25519, identity);
console.log(`  nonce:       ${base58(nonce)}`);

// The cold side: `transferToATA` from the token client, with the system PDA
// as payer and owner (a noop signer, since it has no key), wrapped in one
// Passthrough instruction, and a digest of it signed into the Advance
// instruction. Nothing here needs an RPC.
console.log('\n== signing on the cold side ==');
const pdaSigner = createNoopSigner(systemPda.address);
const withdrawal = await getTransferToATAInstructionPlanAsync({
    amount: AMOUNT,
    authority: pdaSigner,
    decimals: DECIMALS,
    mint: mint.address,
    payer: pdaSigner,
    recipient: recipient.address,
});
const passthrough = createSystemPassthroughInstruction(ED25519, identity, toTransactionInstructions(withdrawal));
const advance = signAdvanceInstructionEd25519(signingKey, nonce, [], [passthrough]);
const nextNonceValue = base58(advanceVectorDigest(ED25519, nonce, identity, [], [passthrough]));
console.log(`  Advance instruction:     ${advance.data.length} bytes of data`);
console.log(
    `  Passthrough instruction: ${passthrough.data.length} bytes of data, 2 instructions (CreateAssociatedTokenAccountIdempotent, TransferChecked)`,
);

console.log('\n== relayed ==');
const landed = await sendTransaction(connection, relayer, [advance, passthrough], [relayer]);
console.log(`  landed:        ${landed}`);
const fetched = await connection.getTransaction(landed, { maxSupportedTransactionVersion: 1 });
console.log(`  compute units: ${fetched?.meta?.computeUnitsConsumed}`);

console.log('\n== read back ==');
const recipientAccount = await associatedTokenAddress(recipient, mint);
const received = await fetchBalance(connection, recipientAccount);
console.log(
    `  recipient account: ${recipientAccount.toBase58()} holds ${uiAmount(received)} (created by the PDA, which paid its rent)`,
);
if (received !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT}`);
}
const left = await fetchBalance(connection, pdaAccount);
console.log(`  PDA account:       holds ${uiAmount(left)}`);
if (left !== SUPPLY - AMOUNT) {
    throw new Error(`expected the PDA to hold ${SUPPLY - AMOUNT}`);
}
const advanced = base58((await fetchVectorAccount(connection, ED25519, identity)).nonce);
console.log(`  nonce after:       ${advanced}`);
console.log(`  expected:          ${nextNonceValue}`);
if (advanced !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}
