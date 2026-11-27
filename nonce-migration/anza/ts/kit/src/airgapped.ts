/**
 * Signs on a machine that has no network connection.
 *
 * The work is split into three steps:
 *   1. Online: read the nonce and build the authorization message, unsigned.
 *   2. `reviewAndSign` runs on the cold machine. It is not given a client, so
 *      it cannot make a network call. It receives the authorization message
 *      as bytes, shows what the message would do, and signs those bytes.
 *   3. Online: put the signature next to the message and send them.
 *
 * The cold machine signs exactly the bytes it decoded and displayed. So the
 * operator approves what is shown, and nothing else.
 *
 * Run with `just ts-airgapped`.
 */

import { findProgrammaticSignerPda, parseExecuteInstruction } from '@solana-program/ed25519-programmatic-signer';
import { getTransferSolInstruction, parseTransferSolInstruction } from '@solana-program/system';
import {
    assertIsInstructionWithAccounts,
    assertIsInstructionWithData,
    createNoopSigner,
    decompileTransactionMessage,
    generateKeyPairSigner,
    getCompiledTransactionMessageDecoder,
    type KeyPairSigner,
    lamports,
    type ReadonlyUint8Array,
    signBytes,
    singleInstructionPlan,
} from '@solana/kit';

import { assertProgramsDeployed, createFundedClient } from './lib/cluster';
import { authorizationMessage, executionMessage } from './lib/signer';
import { createNonceAccount } from './lib/spl-nonce';

const AMOUNT = 10_000_000n;

/**
 * Decodes a message and returns its one instruction, with accounts and data.
 * It also returns the compiled message, for its header and lifetime value.
 * Both the authorization message and the execution message inside it are
 * read this way.
 */
function decodeOneInstruction(message: ReadonlyUint8Array) {
    const compiled = getCompiledTransactionMessageDecoder().decode(message);
    const decompiled = decompileTransactionMessage(compiled);
    const [instruction, ...others] = decompiled.instructions;
    if (instruction === undefined || others.length > 0) {
        throw new Error('expected exactly one instruction');
    }
    assertIsInstructionWithAccounts(instruction);
    assertIsInstructionWithData(instruction);
    return { compiled, instruction };
}

/**
 * Step 2, on the cold machine. It has no client, so it cannot reach the
 * network.
 *
 * It receives the authorization message as bytes. It decodes them, layer by
 * layer, down to the action, and prints what it finds. Then it signs the same
 * bytes with the cold key.
 */
async function reviewAndSign(authority: KeyPairSigner, authorization: ReadonlyUint8Array) {
    // The outer layer is the authorization message. It lists who has to sign
    // and holds one instruction, for the Executor program.
    const outer = decodeOneInstruction(authorization);
    if (outer.compiled.version !== 1) {
        throw new Error('the authorization message must be v1');
    }
    const signers = outer.compiled.staticAccounts.slice(0, outer.compiled.header.numSignerAccounts);
    console.log(`  signers:       ${JSON.stringify(signers)}`);

    // The Execute instruction names the nonce account, and carries the
    // execution message as its data.
    const execute = parseExecuteInstruction(outer.instruction);
    console.log(`  nonce account: ${execute.accounts.nonceAccount.address}`);

    // The execution message holds the action. Its lifetime slot holds the
    // nonce. This example expects one System transfer; the parser throws on
    // anything else, and then nothing is signed.
    const inner = decodeOneInstruction(execute.data.message);
    console.log(`  nonce:         ${inner.compiled.lifetimeToken}`);
    const transfer = parseTransferSolInstruction(inner.instruction);
    console.log(
        `  action:        transfer ${transfer.data.amount} lamports from ${transfer.accounts.source.address} to ${transfer.accounts.destination.address}`,
    );

    // Sign the bytes that were just decoded and shown.
    return await signBytes(authority.keyPair.privateKey, authorization);
}

// Setup, done online by the relayer. The cold key's PDA is funded, and a nonce
// account is created with the PDA as its authority. Neither step needs the
// cold key to sign; only its public key is used.
const relayer = await createFundedClient(2_000_000_000n);
await assertProgramsDeployed(relayer.rpc);
const recipient = (await generateKeyPairSigner()).address;
const authority = await generateKeyPairSigner();
const [pda] = await findProgrammaticSignerPda({ authority: authority.address });
await relayer.system.instructions
    .transferSol({ amount: lamports(1_000_000_000n), destination: pda, source: relayer.payer })
    .sendTransaction();
const nonceAccount = await createNonceAccount(relayer, pda);
console.log('== setup ==');
console.log(`  authority:     ${authority.address} (cold)`);
console.log(`  pda:           ${pda} (holds the funds)`);
console.log(`  nonce account: ${nonceAccount}`);

// Step 1, online. Read the nonce and build the authorization message for the
// transfer. Nothing is signed here; only the cold key's address is needed.
console.log('\n== online: prepare the authorization message ==');
const { nonce } = (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data;
const transfer = getTransferSolInstruction({ amount: AMOUNT, destination: recipient, source: createNoopSigner(pda) });
const authorization = authorizationMessage(
    executionMessage(pda, singleInstructionPlan(transfer), nonce),
    nonceAccount,
    pda,
    [authority.address],
);
console.log(`  to the cold machine: the authorization message, ${authorization.length} bytes`);

console.log('\n== offline: review and sign ==');
const signature = await reviewAndSign(authority, authorization);
console.log('  to the online machine: the signature, 64 bytes');

// Step 3, online. Put the cold key's signature next to the authorization
// message in a Submit instruction, and send it. Any funded key can relay. It
// cannot change the message, because the signature is over its bytes.
console.log('\n== online: relay ==');
const { context: relay } = await relayer.ed25519Signer.instructions
    .submit({ message: authorization, signatures: [signature] })
    .sendTransaction();
console.log(`  landed: ${relay.signature}`);

console.log('\n== read back ==');
const { value: balance } = await relayer.rpc.getBalance(recipient, { commitment: 'confirmed' }).send();
console.log(`  recipient balance: ${balance} lamports`);
if (balance !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT} lamports`);
}
