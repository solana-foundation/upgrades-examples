/**
 * Two cold approvers sign one token withdrawal on separate machines, and a
 * hot key relays it once it holds both signatures.
 *
 * Each cold key has its own vector account and system PDA. The tokens belong
 * to a Token program multisig whose two signers are those system PDAs, so
 * neither approver can move them alone. Both keys sign over the same
 * instructions; relaying with one signature is rejected, and relaying with
 * both lands.
 *
 * Run with `just ts-multi-signer`.
 */

import {
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getCreateMintInstructionPlan,
    getInitializeMultisig2Instruction,
    getMintToATAInstructionPlanAsync,
    getMultisigSize,
    getTransferCheckedInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { createNoopSigner, getBase58Decoder, singleInstructionPlan } from '@solana/kit';
import { Keypair, PublicKey, SendTransactionError, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

import {
    advanceMessage,
    createInitializeEd25519,
    createMultiAdvanceInstruction,
    createMultiPassthroughInstruction,
    ED25519,
    fetchVectorAccount,
    findSystemPda,
    findVectorPda,
    signDigestEd25519,
    signerDigest,
} from './client';
import { assertProgramDeployed, connect, fundedKeypair, sendTransaction } from './lib/cluster';
import { associatedTokenAddress, DECIMALS, fetchBalance, toTransactionInstructions, uiAmount } from './lib/token';

/** 1,000 tokens at six decimals: what the multisig holds. */
const SUPPLY = 1_000_000_000n;
/** 250 tokens: what the withdrawal moves. */
const AMOUNT = 250_000_000n;

/** 32 or 64 bytes as base58, the way a blockhash or a signature is written. */
const base58 = (bytes: Uint8Array) => getBase58Decoder().decode(bytes);

const connection = connect();
await assertProgramDeployed(connection);

const relayer = await fundedKeypair(connection, 5_000_000_000);
const first = await Keypair.generate();
const second = await Keypair.generate();
// The SDK signs with the 32-byte seed, the first half of the secret key, and
// names an account by the public key.
const firstKey = first.secretKey.slice(0, 32);
const secondKey = second.secretKey.slice(0, 32);
const firstIdentity = first.publicKey.toBytes();
const secondIdentity = second.publicKey.toBytes();
const [firstVector] = findVectorPda(ED25519, firstIdentity);
const [secondVector] = findVectorPda(ED25519, secondIdentity);
const [firstPda] = findSystemPda(firstVector);
const [secondPda] = findSystemPda(secondVector);
const recipient = (await Keypair.generate()).publicKey;

console.log('== setup: a 2-of-2 multisig holds 1,000 tokens ==');
console.log(`  first approver:  ${first.publicKey.toBase58()} (cold)`);
console.log(`  its vector account: ${firstVector.toBase58()}`);
console.log(`  its system PDA:     ${firstPda.toBase58()}`);
console.log(`  second approver: ${second.publicKey.toBase58()} (cold)`);
console.log(`  its vector account: ${secondVector.toBase58()}`);
console.log(`  its system PDA:     ${secondPda.toBase58()}`);

// Each approver needs its own vector account, which holds its nonce. The
// relayer creates both and pays their rent.
await sendTransaction(
    connection,
    relayer,
    [
        createInitializeEd25519(relayer.publicKey, firstIdentity),
        createInitializeEd25519(relayer.publicKey, secondIdentity),
    ],
    [relayer],
);

// Create the 2-of-2 multisig: a Token program account that lists both system
// PDAs as signers with a threshold of 2. The relayer pays its rent. Creating
// it needs no cold signature, because the PDAs are only recorded as signers
// here; they sign later, when tokens are withdrawn.
const newMultisig = await Keypair.generate();
const multisig = newMultisig.publicKey;
await sendTransaction(
    connection,
    relayer,
    [
        SystemProgram.createAccount({
            fromPubkey: relayer.publicKey,
            lamports: await connection.getMinimumBalanceForRentExemption(getMultisigSize()),
            newAccountPubkey: multisig,
            programId: new PublicKey(TOKEN_PROGRAM_ADDRESS),
            space: getMultisigSize(),
        }),
        ...toTransactionInstructions(
            singleInstructionPlan(
                getInitializeMultisig2Instruction({
                    m: 2,
                    multisig: multisig.address,
                    signers: [firstPda.address, secondPda.address],
                }),
            ),
        ),
    ],
    [relayer, newMultisig],
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
            owner: multisig.address,
            payer: relayer,
        }),
    ),
    [relayer],
);
await sendTransaction(
    connection,
    relayer,
    toTransactionInstructions(
        singleInstructionPlan(
            await getCreateAssociatedTokenIdempotentInstructionAsync({
                mint: mint.address,
                owner: recipient.address,
                payer: relayer,
            }),
        ),
    ),
    [relayer],
);
const multisigAccount = await associatedTokenAddress(multisig, mint);
const recipientAccount = await associatedTokenAddress(recipient, mint);
console.log(`  multisig:        ${multisig.toBase58()} (needs both system PDAs)`);
console.log(
    `  its account:     ${multisigAccount.toBase58()} holds ${uiAmount(await fetchBalance(connection, multisigAccount))}`,
);

// Each approver signs over its own account's nonce.
const { nonce: firstNonce } = await fetchVectorAccount(connection, ED25519, firstIdentity);
const { nonce: secondNonce } = await fetchVectorAccount(connection, ED25519, secondIdentity);
console.log(`  first nonce:     ${base58(firstNonce)}`);
console.log(`  second nonce:    ${base58(secondNonce)}`);

// Build what the approvers will sign. This happens once, on any machine, and
// needs no key:
//   1. the action: a TransferChecked out of the multisig's token account,
//      with both system PDAs as its signers (noop signers, since a PDA has
//      no key);
//   2. the Passthrough instruction that holds the action and signs as both
//      system PDAs;
//   3. the message: a hash of the transaction's instructions, with both
//      approvers listed as signers of the Advance instruction. The list is
//      fixed here; an approver cannot be added or swapped later.
console.log('\n== the message both approvers sign over ==');
const transfer = getTransferCheckedInstruction({
    amount: AMOUNT,
    authority: multisig.address,
    decimals: DECIMALS,
    destination: recipientAccount.address,
    mint: mint.address,
    multiSigners: [createNoopSigner(firstPda.address), createNoopSigner(secondPda.address)],
    source: multisigAccount.address,
});
const passthrough = createMultiPassthroughInstruction(
    [
        { identity: firstIdentity, scheme: ED25519, system: true },
        { identity: secondIdentity, scheme: ED25519, system: true },
    ],
    toTransactionInstructions(singleInstructionPlan(transfer)),
);
const firstSigner = { identity: firstIdentity, scheme: ED25519 };
const secondSigner = { identity: secondIdentity, scheme: ED25519 };
const message = advanceMessage([firstSigner, secondSigner], [], [passthrough]);
console.log(`  message: ${base58(message)}`);

// Each approver signs on its own machine. What it signs is its own digest:
// the shared message combined with its account's nonce and address. That
// digest is also the nonce its account moves to. The two signatures are
// independent of each other, so the approvers can sign in any order. Here the
// second one signs first.
console.log('\n== signing on each cold side ==');
const secondDigest = signerDigest(message, secondNonce, secondVector);
const secondSignature = signDigestEd25519(secondKey, secondDigest);
console.log(`  second approver: ${base58(secondSignature)}`);
const firstDigest = signerDigest(message, firstNonce, firstVector);
const firstSignature = signDigestEd25519(firstKey, firstDigest);
console.log(`  first approver:  ${base58(firstSignature)}`);

// The hot side. First relay with only the first approver's signature, leaving
// the second one's place empty. The program rejects it, because the Advance
// instruction lists two signers and verifies a signature for each.
console.log('\n== relayed with one signature ==');
await expectRejected([
    createMultiAdvanceInstruction([
        { ...firstSigner, signature: firstSignature },
        { ...secondSigner, signature: new Uint8Array(64) },
    ]),
    passthrough,
]);

// Both signatures go into one Advance instruction, in the order the signers
// were listed when the message was built.
console.log('\n== relayed with both ==');
const advance = createMultiAdvanceInstruction([
    { ...firstSigner, signature: firstSignature },
    { ...secondSigner, signature: secondSignature },
]);
const landed = await sendTransaction(connection, relayer, [advance, passthrough], [relayer]);
console.log(`  landed:        ${landed}`);
const fetched = await connection.getTransaction(landed, { maxSupportedTransactionVersion: 1 });
console.log(`  compute units: ${fetched?.meta?.computeUnitsConsumed}`);

console.log('\n== read back ==');
const received = await fetchBalance(connection, recipientAccount);
console.log(`  recipient account: ${recipientAccount.toBase58()} holds ${uiAmount(received)}`);
if (received !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT}`);
}
const left = await fetchBalance(connection, multisigAccount);
console.log(`  multisig account:  holds ${uiAmount(left)}`);
if (left !== SUPPLY - AMOUNT) {
    throw new Error(`expected the multisig to hold ${SUPPLY - AMOUNT}`);
}
// Each account's nonce moved to the digest its own approver signed.
for (const [name, identity, digest] of [
    ['first', firstIdentity, firstDigest],
    ['second', secondIdentity, secondDigest],
] as const) {
    const advanced = base58((await fetchVectorAccount(connection, ED25519, identity)).nonce);
    console.log(`  ${name} nonce after: ${advanced}`);
    console.log(`  expected:          ${base58(digest)}`);
    if (advanced !== base58(digest)) {
        throw new Error(`the ${name} nonce did not advance to the value computed at signing time`);
    }
}

/**
 * Relays `instructions` and throws unless the relay is rejected with
 * `MissingRequiredSignature`, which is how Vector reports a signature that
 * does not verify. web3.js reports a rejected send as text only, so this
 * matches on the message; a structured error should ideally be provided
 * upstream.
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
