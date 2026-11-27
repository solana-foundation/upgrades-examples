/**
 * Moves everything a cold key controls to its programmatic signer PDA, then
 * uses the PDA to act on each of them.
 *
 * Before: the cold key holds SOL and tokens, is the mint and freeze authority
 * of a mint, and is the staker, withdrawer, and lockup custodian of a stake
 * account.
 *
 * The migration is one transaction. It is the last durable nonce transaction
 * the cold key signs.
 *
 * The migration is "checked": the old owner and the new owner both have to
 * sign it. The old owner is the cold key. The new owner is the PDA, and the
 * cold key approves on its behalf with an authorization inside the same
 * transaction. So if the PDA could not act, the migration would fail and
 * nothing would move. This is how the upstream docs say to migrate.
 *
 * After: the cold key signs one authorization, and the PDA spends SOL, sends
 * tokens, mints, freezes an account, and withdraws from the locked stake.
 *
 * Run with `just ts-migrate`.
 */

import { findProgrammaticSignerPda, getSubmitInstruction } from '@solana-program/ed25519-programmatic-signer';
import {
    fetchStakeStateAccount,
    getAuthorizeCheckedInstruction,
    getInitializeInstruction,
    getSetLockupCheckedInstruction,
    getWithdrawInstruction,
    STAKE_PROGRAM_ADDRESS,
    StakeAuthorize,
} from '@solana-program/stake';
import { getTransferSolInstruction } from '@solana-program/system';
import {
    AccountState,
    AuthorityType,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getFreezeAccountInstruction,
    getMintToCheckedInstruction,
    getSetAuthorityInstruction,
    getTransferCheckedInstruction,
    getTransferToATAInstructionPlanAsync,
} from '@solana-program/token';
import {
    type Address,
    appendTransactionMessageInstruction,
    assertIsTransactionWithDurableNonceLifetime,
    createNoopSigner,
    createTransactionMessage,
    generateKeyPairSigner,
    getSignatureFromTransaction,
    lamports,
    type Nonce,
    pipe,
    sendAndConfirmDurableNonceTransactionFactory,
    sequentialInstructionPlan,
    setTransactionMessageConfig,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingDurableNonce,
    signBytes,
    signTransactionMessageWithSigners,
    unwrapOption,
    upgradeRoleToSigner,
} from '@solana/kit';

import { assertProgramsDeployed, createFundedClient } from './lib/cluster';
import { createDurableNonceAccount } from './lib/durable-nonce';
import { authorizationMessage, executionMessage } from './lib/signer';
import { createNonceAccount, nextNonce } from './lib/spl-nonce';
import { associatedTokenAddress, DECIMALS, uiAmount } from './lib/token';

/** What the cold key holds before the migration. */
const COLD_SOL = 5_000_000_000n;
const COLD_TOKENS = 1_000_000_000n;
const STAKED = 1_000_000_000n;
/** What the migration moves to the PDA. */
const MIGRATED_SOL = 2_000_000_000n;
/** What the PDA does afterwards. */
const SENT_SOL = 10_000_000n;
const SENT_TOKENS = 250_000_000n;
const MINTED_TOKENS = 100_000_000n;
const WITHDRAWN_STAKE = 500_000_000n;
/**
 * The size of a stake account. Written out here because the stake client
 * does not export it; ideally it would.
 */
const STAKE_ACCOUNT_SIZE = 200;
/** When the stake account's lockup ends: the year 2100. */
const LOCKED_UNTIL = 4_102_444_800n;

const relayer = await createFundedClient(5_000_000_000n);
await assertProgramsDeployed(relayer.rpc);
const recipient = (await generateKeyPairSigner()).address;
const fetchSol = async (address: Address) =>
    (await relayer.rpc.getBalance(address, { commitment: 'confirmed' }).send()).value;
const fetchTokens = async (account: Address) => (await relayer.token.accounts.token.fetch(account)).data.amount;
const fetchNonce = async (account: Address) => (await relayer.nonce.accounts.nonce.fetch(account)).data.nonce;
const computeUnits = async (signature: Parameters<typeof relayer.rpc.getTransaction>[0]) =>
    (
        await relayer.rpc
            .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
            .send()
    )?.meta?.computeUnitsConsumed;

// The starting point: a cold key that controls everything directly.
console.log('== before: the cold key controls everything ==');
const coldClient = await createFundedClient(COLD_SOL);
const cold = coldClient.payer;
const [pda] = await findProgrammaticSignerPda({ authority: cold.address });

// A mint whose mint authority and freeze authority are both the cold key, and
// 1,000 of its tokens in the cold key's token account.
const newMint = await generateKeyPairSigner();
const mint = newMint.address;
await relayer.token.instructions
    .createMint({ decimals: DECIMALS, freezeAuthority: cold.address, mintAuthority: cold.address, newMint })
    .sendTransactions();
await coldClient.token.instructions
    .mintToATA({ amount: COLD_TOKENS, decimals: DECIMALS, mint, mintAuthority: cold, owner: cold.address })
    .sendTransactions();
const coldTokens = await associatedTokenAddress(cold.address, mint);

// A stake account holding 1 SOL. The cold key is its staker and its
// withdrawer. The account is locked until the year 2100. The cold key is also
// the lockup's custodian: the one party that can still act while the account
// is locked.
const newStake = await generateKeyPairSigner();
const stake = newStake.address;
const stakeRent = await coldClient.getMinimumBalance(STAKE_ACCOUNT_SIZE);
await coldClient.sendTransaction([
    coldClient.system.instructions.createAccount({
        lamports: lamports(stakeRent + STAKED),
        newAccount: newStake,
        programAddress: STAKE_PROGRAM_ADDRESS,
        space: STAKE_ACCOUNT_SIZE,
    }),
    getInitializeInstruction({
        arg0: { staker: cold.address, withdrawer: cold.address },
        arg1: { custodian: cold.address, epoch: 0n, unixTimestamp: LOCKED_UNTIL },
        stake,
    }),
]);

console.log(`  cold key:      ${cold.address}`);
console.log(`  SOL:           ${await fetchSol(cold.address)} lamports`);
console.log(`  tokens:        ${uiAmount(await fetchTokens(coldTokens))} in ${coldTokens}`);
console.log(`  mint:          ${mint} (mint and freeze authority)`);
console.log(`  stake account: ${stake} (staker, withdrawer, lockup custodian)`);

// The migration needs two nonce accounts.
//
// The first is a System nonce account, the kind the cold key already uses for
// durable nonce transactions. The migration transaction uses it.
//
// The second is an SPL nonce account that belongs to the PDA. The
// authorization inside the migration uses it. Everything the PDA does
// afterwards uses it too.
const durableNonceAccount = await createDurableNonceAccount(coldClient);
const nonceAccount = await createNonceAccount(relayer, pda);
console.log(`  pda:           ${pda} (the new owner; holds nothing yet)`);

// Build the migration. Every instruction hands one thing from the cold key to
// the PDA. They all go into one execution message, so they all happen or none
// do. The PDA has no key, so wherever it has to sign it is a noop signer.
console.log('\n== signing the migration on the cold side ==');
const pdaSigner = createNoopSigner(pda);
const pdaTokens = await associatedTokenAddress(pda, mint);
const handover = [
    // Move SOL from the cold key to the PDA.
    getTransferSolInstruction({ amount: MIGRATED_SOL, destination: pda, source: cold }),
    // Tokens: create the PDA's token account, then move the balance.
    await getCreateAssociatedTokenIdempotentInstructionAsync({ mint, owner: pda, payer: cold }),
    getTransferCheckedInstruction({
        amount: COLD_TOKENS,
        authority: cold,
        decimals: DECIMALS,
        destination: pdaTokens,
        mint,
        source: coldTokens,
    }),
    // The mint: its mint authority and its freeze authority.
    getSetAuthorityInstruction({
        authorityType: AuthorityType.MintTokens,
        newAuthority: pda,
        owned: mint,
        owner: cold,
    }),
    getSetAuthorityInstruction({
        authorityType: AuthorityType.FreezeAccount,
        newAuthority: pda,
        owned: mint,
        owner: cold,
    }),
    // The stake account. First the staker, then the withdrawer. While a lockup
    // is in force, changing the withdrawer also needs the custodian to sign.
    // The custodian is still the cold key at this point. These are the
    // "checked" instructions, which need the new authority to sign as well.
    getAuthorizeCheckedInstruction({
        authority: cold,
        newAuthority: pdaSigner,
        stake,
        stakeAuthorize: StakeAuthorize.Staker,
    }),
    getAuthorizeCheckedInstruction({
        authority: cold,
        lockupAuthority: cold,
        newAuthority: pdaSigner,
        stake,
        stakeAuthorize: StakeAuthorize.Withdrawer,
    }),
    // Last, the lockup's custodian. It has to come last, because the
    // instruction above needed the cold key to still be the custodian.
    getSetLockupCheckedInstruction({
        authority: cold,
        epoch: null,
        newAuthority: pdaSigner,
        stake,
        unixTimestamp: null,
    }),
];

// The cold key signs twice, both offline.
//
// First, as the new owner. It signs an authorization for the execution
// message, which is what lets the PDA sign the instructions that need the new
// authority.
const migration = executionMessage(pda, sequentialInstructionPlan(handover), await fetchNonce(nonceAccount));
const migrationAuthorization = authorizationMessage(migration, nonceAccount, pda, [cold.address]);
const submit = getSubmitInstruction({
    message: migrationAuthorization,
    signatures: [await signBytes(cold.keyPair.privateKey, migrationAuthorization)],
});
// The instructions inside also need the cold key to sign, as the old owner. It
// does that by signing the transaction below. For that signature to reach the
// instructions inside, the cold key has to be marked as a signer of the Submit
// instruction.
const forwardingSubmit = {
    ...submit,
    accounts: submit.accounts.map(account =>
        account.address === cold.address ? { ...account, role: upgradeRoleToSigner(account.role) } : account,
    ),
};
// Second, as the old owner. It signs a durable nonce transaction that carries
// the Submit instruction. This is the old flow, used one last time.
// `AdvanceNonceAccount` comes first, the nonce goes where the blockhash would
// be, and the cold key pays the fee.
const durableNonce = (await coldClient.system.accounts.nonce.fetch(durableNonceAccount)).data.blockhash;
const transaction = await signTransactionMessageWithSigners(
    pipe(
        createTransactionMessage({ version: 1 }),
        m => setTransactionMessageFeePayerSigner(cold, m),
        m =>
            setTransactionMessageLifetimeUsingDurableNonce(
                {
                    nonce: durableNonce as string as Nonce,
                    nonceAccountAddress: durableNonceAccount,
                    nonceAuthorityAddress: cold.address,
                },
                m,
            ),
        m => appendTransactionMessageInstruction(forwardingSubmit, m),
        // The budget of the migration transaction. It runs eight instructions
        // in four programs under the Signer and the Executor.
        m =>
            setTransactionMessageConfig({ computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 8 * 1024 * 1024 }, m),
    ),
);
assertIsTransactionWithDurableNonceLifetime(transaction);
console.log(`  execution message: ${handover.length} instructions, ${migration.length} bytes`);
console.log(`  signed by:         ${JSON.stringify(Object.keys(transaction.signatures))} (the cold key)`);

// Send the migration transaction. The cold key has already signed it and
// pays its fee, so no other signature is needed. Anyone can send it.
console.log('\n== relayed ==');
await sendAndConfirmDurableNonceTransactionFactory(coldClient)(transaction, { commitment: 'confirmed' });
console.log(`  landed:        ${getSignatureFromTransaction(transaction)}`);
console.log(`  compute units: ${await computeUnits(getSignatureFromTransaction(transaction))}`);

// Read each thing back and check that it now belongs to the PDA.
console.log('\n== after: the PDA controls everything ==');
const pdaSol = await fetchSol(pda);
console.log(`  SOL:           ${pdaSol} lamports`);
if (pdaSol !== MIGRATED_SOL) {
    throw new Error(`expected the PDA to hold ${MIGRATED_SOL} lamports`);
}
const moved = await fetchTokens(pdaTokens);
console.log(`  tokens:        ${uiAmount(moved)} in ${pdaTokens}`);
if (moved !== COLD_TOKENS || (await fetchTokens(coldTokens)) !== 0n) {
    throw new Error(`expected the PDA to hold all ${COLD_TOKENS} tokens`);
}
const mintState = (await relayer.token.accounts.mint.fetch(mint)).data;
console.log('  mint:          mint and freeze authority are the PDA');
if (unwrapOption(mintState.mintAuthority) !== pda || unwrapOption(mintState.freezeAuthority) !== pda) {
    throw new Error('expected the PDA to be the mint and freeze authority');
}
const stakeState = (await fetchStakeStateAccount(relayer.rpc, stake)).data.state;
if (stakeState.__kind !== 'Initialized') {
    throw new Error('expected an initialized stake account');
}
const [{ authorized, lockup }] = stakeState.fields;
console.log('  stake account: staker, withdrawer, and lockup custodian are the PDA');
if (authorized.staker !== pda || authorized.withdrawer !== pda || lockup.custodian !== pda) {
    throw new Error('expected the PDA to be the staker, withdrawer, and custodian');
}

// From here on the cold key signs authorizations, never transactions. This
// one uses each thing that was migrated, to show the PDA really controls it.
console.log('\n== using it: one authorization, relayed by a hot key ==');
const recipientTokens = await associatedTokenAddress(recipient, mint);
const actions = sequentialInstructionPlan([
    // Spend SOL.
    getTransferSolInstruction({ amount: SENT_SOL, destination: recipient, source: pdaSigner }),
    // Send tokens, creating the recipient's token account.
    await getTransferToATAInstructionPlanAsync({
        amount: SENT_TOKENS,
        authority: pdaSigner,
        decimals: DECIMALS,
        mint,
        payer: pdaSigner,
        recipient,
    }),
    // Mint new tokens, as the mint authority.
    getMintToCheckedInstruction({
        amount: MINTED_TOKENS,
        decimals: DECIMALS,
        mint,
        mintAuthority: pdaSigner,
        token: pdaTokens,
    }),
    // Freeze the recipient's token account, as the freeze authority.
    getFreezeAccountInstruction({ account: recipientTokens, mint, owner: pdaSigner }),
    // Withdraw from the stake account, as the withdrawer. The lockup is still
    // in force, so the custodian has to sign too. The PDA is now the custodian
    // as well.
    getWithdrawInstruction({
        args: WITHDRAWN_STAKE,
        lockupAuthority: pdaSigner,
        recipient,
        stake,
        withdrawAuthority: pdaSigner,
    }),
]);
const nonce = await fetchNonce(nonceAccount);
const execution = executionMessage(pda, actions, nonce);
const authorization = authorizationMessage(execution, nonceAccount, pda, [cold.address]);
const signature = await signBytes(cold.keyPair.privateKey, authorization);
const nextNonceValue = await nextNonce(nonceAccount, nonce, execution);
const { context: relay } = await relayer.ed25519Signer.instructions
    .submit({ message: authorization, signatures: [signature] })
    .sendTransaction();
console.log(`  landed:        ${relay.signature}`);
console.log(`  compute units: ${await computeUnits(relay.signature)}`);

console.log('\n== read back ==');
const received = await fetchSol(recipient);
console.log(`  recipient SOL:     ${received} lamports (a transfer and a stake withdrawal)`);
if (received !== SENT_SOL + WITHDRAWN_STAKE) {
    throw new Error(`expected the recipient to hold ${SENT_SOL + WITHDRAWN_STAKE} lamports`);
}
const recipientState = (await relayer.token.accounts.token.fetch(recipientTokens)).data;
console.log(`  recipient tokens:  ${uiAmount(recipientState.amount)}, frozen`);
if (recipientState.amount !== SENT_TOKENS || recipientState.state !== AccountState.Frozen) {
    throw new Error(`expected the recipient to hold ${SENT_TOKENS} frozen tokens`);
}
const left = await fetchTokens(pdaTokens);
console.log(`  PDA tokens:        ${uiAmount(left)} (sent 250, minted 100)`);
if (left !== COLD_TOKENS - SENT_TOKENS + MINTED_TOKENS) {
    throw new Error('unexpected PDA token balance');
}
const staked = await fetchSol(stake);
console.log(`  stake account:     ${staked} lamports`);
if (staked !== stakeRent + STAKED - WITHDRAWN_STAKE) {
    throw new Error('unexpected stake account balance');
}
const advanced = await fetchNonce(nonceAccount);
console.log(`  nonce after:       ${advanced}`);
console.log(`  expected:          ${nextNonceValue}`);
if (advanced !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}
