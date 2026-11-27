/**
 * Signs several actions at once, and relays them in any order.
 *
 * A nonce account holds one nonce value, and an action uses that value up. So
 * two actions signed over the same nonce account can only land one after the
 * other, in the order they were signed.
 *
 * To have actions that land independently, give each one its own nonce
 * account. One PDA can be the authority of any number of them. Here the cold
 * key signs three transfers in one session, each over its own nonce account,
 * and the hot key relays them in a different order.
 *
 * Run with `just ts-parallel`.
 */

import { findProgrammaticSignerPda } from '@solana-program/ed25519-programmatic-signer';
import { getTransferSolInstruction } from '@solana-program/system';
import { createNoopSigner, generateKeyPairSigner, lamports, signBytes, singleInstructionPlan } from '@solana/kit';

import { assertProgramsDeployed, createFundedClient } from './lib/cluster';
import { authorizationMessage, executionMessage } from './lib/signer';
import { createNonceAccount, nextNonce } from './lib/spl-nonce';

/** What each of the three actions transfers. */
const AMOUNTS = [10_000_000n, 20_000_000n, 30_000_000n];
/**
 * The order the actions are relayed in: the third, then the first, then the
 * second.
 */
const RELAY_ORDER = [2, 0, 1];

const relayer = await createFundedClient(2_000_000_000n);
await assertProgramsDeployed(relayer.rpc);
const recipient = (await generateKeyPairSigner()).address;
const authority = await generateKeyPairSigner();
const [pda] = await findProgrammaticSignerPda({ authority: authority.address });
await relayer.system.instructions
    .transferSol({ amount: lamports(1_000_000_000n), destination: pda, source: relayer.payer })
    .sendTransaction();

console.log('== setup: one PDA, three nonce accounts ==');
console.log(`  authority: ${authority.address} (cold)`);
console.log(`  pda:       ${pda} (holds the funds)`);
// Create one nonce account per action. The relayer pays their rent. The PDA
// is the authority of all three, so only the cold key can use them.
const nonceAccounts = [];
while (nonceAccounts.length < AMOUNTS.length) {
    const nonceAccount = await createNonceAccount(relayer, pda);
    console.log(`  nonce account: ${nonceAccount}`);
    nonceAccounts.push(nonceAccount);
}

// The cold key signs all three transfers in one session. Each transfer names
// a different nonce account, so none of them depends on another.
console.log('\n== signing on the cold side ==');
const actions = [];
for (const [index, nonceAccount] of nonceAccounts.entries()) {
    const amount = AMOUNTS[index]!;
    const { nonce } = (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data;
    const transfer = getTransferSolInstruction({ amount, destination: recipient, source: createNoopSigner(pda) });
    const execution = executionMessage(pda, singleInstructionPlan(transfer), nonce);
    const authorization = authorizationMessage(execution, nonceAccount, pda, [authority.address]);
    const signature = await signBytes(authority.keyPair.privateKey, authorization);
    const nextNonceValue = await nextNonce(nonceAccount, nonce, execution);
    console.log(`  action: transfer ${amount} lamports, over ${nonceAccount}`);
    actions.push({ authorization, nextNonceValue, signature });
}

// The hot side relays them in a different order from the one they were signed
// in. Each one lands, because each uses its own nonce account.
console.log('\n== relayed out of order ==');
for (const index of RELAY_ORDER) {
    const { authorization, signature } = actions[index]!;
    const { context: relay } = await relayer.ed25519Signer.instructions
        .submit({ message: authorization, signatures: [signature] })
        .sendTransaction();
    console.log(`  transfer of ${AMOUNTS[index]} lamports landed: ${relay.signature}`);
}

console.log('\n== read back ==');
const { value: balance } = await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send();
const total = AMOUNTS.reduce((sum, amount) => sum + amount, 0n);
console.log(`  recipient balance: ${balance} lamports (all three transfers)`);
if (balance !== total) {
    throw new Error(`expected the recipient to hold ${total} lamports`);
}
// Each nonce account advanced once, to the value computed when its action was
// signed.
for (const [index, nonceAccount] of nonceAccounts.entries()) {
    const { nonce: advanced } = (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data;
    console.log(`  ${nonceAccount} nonce: ${advanced}`);
    if (advanced !== actions[index]!.nextNonceValue) {
        throw new Error('the nonce did not advance to the value computed at signing time');
    }
}
