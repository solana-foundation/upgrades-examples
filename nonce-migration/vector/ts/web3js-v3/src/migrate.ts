/**
 * Moves everything a cold key controls to its Vector system PDA, then uses
 * the PDA to act on each of them.
 *
 * Before: the cold key holds SOL and tokens, is the mint and freeze authority
 * of a mint, and is the staker, withdrawer, and lockup custodian of a stake
 * account.
 *
 * The migration is one transaction. It is the last durable nonce transaction
 * the cold key signs.
 *
 * The migration is "checked": the old owner and the new owner both have to
 * sign it. The old owner is the cold key. The new owner is the system PDA, and
 * the cold key signs on its behalf with an `Advance` instruction inside the
 * same transaction. So if the PDA could not act, the migration would fail and
 * nothing would move.
 *
 * After: the cold key signs one digest, and the PDA spends SOL, sends tokens,
 * mints, freezes an account, and withdraws from the locked stake.
 *
 * Run with `just ts-migrate`.
 */

import { fetchStakeStateAccount } from '@solana-program/stake';
import {
    AccountState,
    AuthorityType,
    fetchMint,
    fetchToken,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getCreateMintInstructionPlan,
    getFreezeAccountInstruction,
    getMintToATAInstructionPlanAsync,
    getMintToCheckedInstruction,
    getSetAuthorityInstruction,
    getTransferCheckedInstruction,
    getTransferToATAInstructionPlanAsync,
} from '@solana-program/token';
import { createNoopSigner, sequentialInstructionPlan, unwrapOption } from '@solana/kit';
import {
    Authorized,
    Keypair,
    Lockup,
    PublicKey,
    StakeAuthorizationLayout,
    StakeProgram,
    SystemProgram,
} from '@solana/web3.js';

import {
    advanceVectorDigest,
    createInitializeEd25519,
    createSystemPassthroughInstruction,
    createV1Transaction,
    ED25519,
    fetchVectorAccount,
    findSystemPda,
    findVectorPda,
    signAdvanceInstructionEd25519,
} from './client';
import { assertProgramDeployed, connect, fundedKeypair, sendTransaction } from './lib/cluster';
import { createDurableNonceAccount, fetchDurableNonce } from './lib/durable-nonce';
import { associatedTokenAddress, DECIMALS, fetchBalance, toTransactionInstructions, uiAmount } from './lib/token';

/** What the cold key holds before the migration. */
const COLD_SOL = 5_000_000_000;
const COLD_TOKENS = 1_000_000_000n;
const STAKED = 1_000_000_000n;
/** What the migration moves to the PDA. */
const MIGRATED_SOL = 2_000_000_000n;
/** What the PDA does afterwards. */
const SENT_SOL = 10_000_000n;
const SENT_TOKENS = 250_000_000n;
const MINTED_TOKENS = 100_000_000n;
const WITHDRAWN_STAKE = 500_000_000n;
/** When the stake account's lockup ends: the year 2100. */
const LOCKED_UNTIL = 4_102_444_800;

/** A 32-byte nonce as base58, the way a blockhash is written. */
const base58 = (nonce: Uint8Array) => new PublicKey(nonce).toBase58();

const connection = connect();
await assertProgramDeployed(connection);

const relayer = await fundedKeypair(connection, 5_000_000_000);
const recipient = (await Keypair.generate()).publicKey;
const computeUnits = async (signature: string) =>
    (await connection.getTransaction(signature, { maxSupportedTransactionVersion: 1 }))?.meta?.computeUnitsConsumed;

// The starting point: a cold key that controls everything directly.
console.log('== before: the cold key controls everything ==');
const cold = await fundedKeypair(connection, COLD_SOL);
// The same key will sign for Vector. Two addresses are derived from it: the
// vector account, which holds the nonce, and its system PDA, which will own
// everything. The SDK signs with the 32-byte seed, the first half of the
// secret key, and names the account by the public key.
const signingKey = cold.secretKey.slice(0, 32);
const identity = cold.publicKey.toBytes();
const [vector] = findVectorPda(ED25519, identity);
const [pda] = findSystemPda(vector);

// A mint whose mint authority and freeze authority are both the cold key, and
// 1,000 of its tokens in the cold key's token account.
const newMint = await Keypair.generate();
const mint = newMint.publicKey;
await sendTransaction(
    connection,
    relayer,
    toTransactionInstructions(
        await getCreateMintInstructionPlan(connection, {
            decimals: DECIMALS,
            freezeAuthority: cold.address,
            mintAuthority: cold.address,
            newMint,
            payer: relayer,
        }),
    ),
    [relayer, newMint],
);
await sendTransaction(
    connection,
    cold,
    toTransactionInstructions(
        await getMintToATAInstructionPlanAsync({
            amount: COLD_TOKENS,
            decimals: DECIMALS,
            mint: mint.address,
            mintAuthority: cold,
            owner: cold.address,
            payer: cold,
        }),
    ),
    [cold],
);
const coldTokens = await associatedTokenAddress(cold.publicKey, mint);

// A stake account holding 1 SOL. The cold key is its staker and its
// withdrawer. The account is locked until the year 2100. The cold key is also
// the lockup's custodian: the one party that can still act while the account
// is locked.
const newStake = await Keypair.generate();
const stake = newStake.publicKey;
const stakeRent = BigInt(await connection.getMinimumBalanceForRentExemption(StakeProgram.space));
await sendTransaction(
    connection,
    cold,
    StakeProgram.createAccount({
        authorized: new Authorized(cold.publicKey, cold.publicKey),
        fromPubkey: cold.publicKey,
        lamports: stakeRent + STAKED,
        lockup: new Lockup(LOCKED_UNTIL, 0, cold.publicKey),
        stakePubkey: stake,
    }).instructions,
    [cold, newStake],
);

console.log(`  cold key:       ${cold.publicKey.toBase58()}`);
console.log(`  SOL:            ${await connection.getBalance(cold.publicKey)} lamports`);
console.log(`  tokens:         ${uiAmount(await fetchBalance(connection, coldTokens))} in ${coldTokens.toBase58()}`);
console.log(`  mint:           ${mint.toBase58()} (mint and freeze authority)`);
console.log(`  stake account:  ${stake.toBase58()} (staker, withdrawer, lockup custodian)`);

// The migration needs two nonces.
//
// The first is in a System nonce account, the kind the cold key already uses
// for durable nonce transactions. The migration transaction uses it.
//
// The second is in the vector account. The Advance instruction inside the
// migration uses it. Everything the PDA does afterwards uses it too. The
// relayer creates the vector account and pays its rent.
const durableNonceAccount = await createDurableNonceAccount(connection, cold);
await sendTransaction(connection, relayer, [createInitializeEd25519(relayer.publicKey, identity)], [relayer]);
const fetchNonce = async () => (await fetchVectorAccount(connection, ED25519, identity)).nonce;
console.log(`  vector account: ${vector.toBase58()} (holds the nonce)`);
console.log(`  system PDA:     ${pda.toBase58()} (the new owner; holds nothing yet)`);

// Build the migration. Every instruction hands one thing from the cold key to
// the system PDA. They all go into one Passthrough instruction, so they all
// happen or none do. The token instructions come from the kit token client,
// where the PDA is a noop signer because it has no key.
console.log('\n== signing the migration on the cold side ==');
const pdaSigner = createNoopSigner(pda.address);
const pdaTokens = await associatedTokenAddress(pda, mint);
const handover = [
    // SOL.
    SystemProgram.transfer({ fromPubkey: cold.publicKey, lamports: MIGRATED_SOL, toPubkey: pda }),
    ...toTransactionInstructions(
        sequentialInstructionPlan([
            // Tokens: create the PDA's token account, then move the balance.
            await getCreateAssociatedTokenIdempotentInstructionAsync({
                mint: mint.address,
                owner: pda.address,
                payer: cold,
            }),
            getTransferCheckedInstruction({
                amount: COLD_TOKENS,
                authority: cold,
                decimals: DECIMALS,
                destination: pdaTokens.address,
                mint: mint.address,
                source: coldTokens.address,
            }),
            // The mint: its mint authority and its freeze authority.
            getSetAuthorityInstruction({
                authorityType: AuthorityType.MintTokens,
                newAuthority: pda.address,
                owned: mint.address,
                owner: cold,
            }),
            getSetAuthorityInstruction({
                authorityType: AuthorityType.FreezeAccount,
                newAuthority: pda.address,
                owned: mint.address,
                owner: cold,
            }),
        ]),
    ),
    // The stake account. First the staker, then the withdrawer. While a lockup
    // is in force, changing the withdrawer also needs the custodian to sign.
    // The custodian is still the cold key at this point. These are the
    // "checked" instructions, which need the new authority to sign as well.
    ...StakeProgram.authorizeChecked({
        authorizedPubkey: cold.publicKey,
        newAuthorizedPubkey: pda,
        stakeAuthorizationType: StakeAuthorizationLayout.Staker,
        stakePubkey: stake,
    }).instructions,
    ...StakeProgram.authorizeChecked({
        authorizedPubkey: cold.publicKey,
        custodianPubkey: cold.publicKey,
        newAuthorizedPubkey: pda,
        stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer,
        stakePubkey: stake,
    }).instructions,
    // Last, the lockup's custodian. It has to come last, because the
    // instruction above needed the cold key to still be the custodian.
    ...StakeProgram.setLockupChecked({
        authorizedPubkey: cold.publicKey,
        newAuthorizedPubkey: pda,
        stakePubkey: stake,
    }).instructions,
];

// The cold key signs twice, both offline.
//
// First, as the new owner. It signs a digest of the transaction's
// instructions. That is what lets the system PDA sign the instructions that
// need the new authority.
//
// The digest covers every instruction in the transaction. So
// `AdvanceNonceAccount`, which comes first, is passed in as the instruction
// before. The cold key is passed in as the fee payer, because it is also an
// account of the instructions.
const advanceNonce = SystemProgram.nonceAdvance({ authorizedPubkey: cold.publicKey, noncePubkey: durableNonceAccount });
const migration = createSystemPassthroughInstruction(ED25519, identity, handover);
const migrationAdvance = signAdvanceInstructionEd25519(
    signingKey,
    await fetchNonce(),
    [advanceNonce],
    [migration],
    cold.publicKey,
);
// Second, as the old owner. It signs a durable nonce transaction that carries
// the two Vector instructions. This is the old flow, used one last time.
// `AdvanceNonceAccount` comes first, the nonce goes where the blockhash would
// be, and the cold key pays the fee. The instructions inside see its signature
// on the transaction as the old owner signing.
const durableNonce = await fetchDurableNonce(connection, durableNonceAccount);
const transaction = createV1Transaction({
    feePayer: cold.publicKey,
    instructions: [advanceNonce, migrationAdvance, migration],
    // The budget of the migration transaction. It runs eight instructions in
    // four programs under the Vector program.
    limits: { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 8 * 1024 * 1024 },
    recentBlockhash: durableNonce,
});
await transaction.sign([cold]);
console.log(`  Passthrough instruction: ${handover.length} instructions, ${migration.data.length} bytes of data`);
console.log(`  signed by:               ${cold.publicKey.toBase58()} (the cold key)`);

console.log('\n== relayed ==');
const migrated = await connection.sendTransaction(transaction);
await connection.confirmTransaction({
    nonceAccountPubkey: durableNonceAccount,
    nonceValue: durableNonce,
    signature: migrated,
});
console.log(`  landed:        ${migrated}`);
console.log(`  compute units: ${await computeUnits(migrated)}`);

// Everything now names the PDA.
console.log('\n== after: the PDA controls everything ==');
const pdaSol = BigInt(await connection.getBalance(pda));
console.log(`  SOL:           ${pdaSol} lamports`);
if (pdaSol !== MIGRATED_SOL) {
    throw new Error(`expected the PDA to hold ${MIGRATED_SOL} lamports`);
}
const moved = await fetchBalance(connection, pdaTokens);
console.log(`  tokens:        ${uiAmount(moved)} in ${pdaTokens.toBase58()}`);
if (moved !== COLD_TOKENS || (await fetchBalance(connection, coldTokens)) !== 0n) {
    throw new Error(`expected the PDA to hold all ${COLD_TOKENS} tokens`);
}
const mintState = (await fetchMint(connection.rpc, mint.address)).data;
console.log('  mint:          mint and freeze authority are the PDA');
if (unwrapOption(mintState.mintAuthority) !== pda.address || unwrapOption(mintState.freezeAuthority) !== pda.address) {
    throw new Error('expected the PDA to be the mint and freeze authority');
}
const stakeState = (await fetchStakeStateAccount(connection.rpc, stake.address)).data.state;
if (stakeState.__kind !== 'Initialized') {
    throw new Error('expected an initialized stake account');
}
const [{ authorized, lockup }] = stakeState.fields;
console.log('  stake account: staker, withdrawer, and lockup custodian are the PDA');
if (authorized.staker !== pda.address || authorized.withdrawer !== pda.address || lockup.custodian !== pda.address) {
    throw new Error('expected the PDA to be the staker, withdrawer, and custodian');
}

// From here on the cold key signs digests, never transactions. This one uses
// each thing that was migrated, to show the PDA really controls it.
console.log('\n== using it: one signature, relayed by a hot key ==');
const recipientTokens = await associatedTokenAddress(recipient, mint);
const actions = [
    // Spend SOL.
    SystemProgram.transfer({ fromPubkey: pda, lamports: SENT_SOL, toPubkey: recipient }),
    ...toTransactionInstructions(
        sequentialInstructionPlan([
            // Send tokens, creating the recipient's token account.
            await getTransferToATAInstructionPlanAsync({
                amount: SENT_TOKENS,
                authority: pdaSigner,
                decimals: DECIMALS,
                mint: mint.address,
                payer: pdaSigner,
                recipient: recipient.address,
            }),
            // Mint new tokens, as the mint authority.
            getMintToCheckedInstruction({
                amount: MINTED_TOKENS,
                decimals: DECIMALS,
                mint: mint.address,
                mintAuthority: pdaSigner,
                token: pdaTokens.address,
            }),
            // Freeze the recipient's token account, as the freeze authority.
            getFreezeAccountInstruction({
                account: recipientTokens.address,
                mint: mint.address,
                owner: pdaSigner,
            }),
        ]),
    ),
    // Withdraw from the stake account, as the withdrawer. The lockup is still
    // in force, so the custodian has to sign too. The PDA is now the custodian
    // as well.
    ...StakeProgram.withdraw({
        authorizedPubkey: pda,
        custodianPubkey: pda,
        lamports: WITHDRAWN_STAKE,
        stakePubkey: stake,
        toPubkey: recipient,
    }).instructions,
];
const passthrough = createSystemPassthroughInstruction(ED25519, identity, actions);
const nonce = await fetchNonce();
const advance = signAdvanceInstructionEd25519(signingKey, nonce, [], [passthrough]);
const nextNonceValue = base58(advanceVectorDigest(ED25519, nonce, identity, [], [passthrough]));
const landed = await sendTransaction(connection, relayer, [advance, passthrough], [relayer]);
console.log(`  landed:        ${landed}`);
console.log(`  compute units: ${await computeUnits(landed)}`);

console.log('\n== read back ==');
const received = BigInt(await connection.getBalance(recipient));
console.log(`  recipient SOL:     ${received} lamports (a transfer and a stake withdrawal)`);
if (received !== SENT_SOL + WITHDRAWN_STAKE) {
    throw new Error(`expected the recipient to hold ${SENT_SOL + WITHDRAWN_STAKE} lamports`);
}
const recipientState = (await fetchToken(connection.rpc, recipientTokens.address)).data;
console.log(`  recipient tokens:  ${uiAmount(recipientState.amount)}, frozen`);
if (recipientState.amount !== SENT_TOKENS || recipientState.state !== AccountState.Frozen) {
    throw new Error(`expected the recipient to hold ${SENT_TOKENS} frozen tokens`);
}
const left = await fetchBalance(connection, pdaTokens);
console.log(`  PDA tokens:        ${uiAmount(left)} (sent 250, minted 100)`);
if (left !== COLD_TOKENS - SENT_TOKENS + MINTED_TOKENS) {
    throw new Error('unexpected PDA token balance');
}
const staked = BigInt(await connection.getBalance(stake));
console.log(`  stake account:     ${staked} lamports`);
if (staked !== stakeRent + STAKED - WITHDRAWN_STAKE) {
    throw new Error('unexpected stake account balance');
}
const advanced = base58(await fetchNonce());
console.log(`  nonce after:       ${advanced}`);
console.log(`  expected:          ${nextNonceValue}`);
if (advanced !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}
