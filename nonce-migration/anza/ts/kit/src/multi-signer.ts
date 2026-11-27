/**
 * Two cold approvers sign one token withdrawal on separate machines, and a
 * hot key relays it once it holds both signatures.
 *
 * Each cold key has its own PDA. The tokens belong to a Token program
 * multisig whose two signers are those PDAs, so neither approver can move
 * them alone. Both keys sign the same authorization message; relaying with one
 * signature is rejected, and relaying with both lands.
 *
 * Run with `just ts-multi-signer`.
 */

import {
    ED25519_SIGNER_ERROR__MISSING_SIGNATURE,
    findProgrammaticSignerPda,
} from '@solana-program/ed25519-programmatic-signer';
import {
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getMultisigSize,
    getTransferCheckedInstruction,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    type Address,
    createNoopSigner,
    generateKeyPairSigner,
    getBase58Decoder,
    getCompiledTransactionMessageDecoder,
    isSolanaError,
    type ReadonlyUint8Array,
    signBytes,
    type SignatureBytes,
    singleInstructionPlan,
    SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    unwrapSimulationError,
} from '@solana/kit';

import { assertProgramsDeployed, createFundedClient } from './lib/cluster';
import { authorizationMessage, executionMessage } from './lib/signer';
import { createNonceAccount, nextNonce } from './lib/spl-nonce';
import { associatedTokenAddress, DECIMALS, uiAmount } from './lib/token';

/** 1,000 tokens at six decimals: what the multisig holds. */
const SUPPLY = 1_000_000_000n;
/** 250 tokens: what the withdrawal moves. */
const AMOUNT = 250_000_000n;

const relayer = await createFundedClient(5_000_000_000n);
await assertProgramsDeployed(relayer.rpc);
const first = await generateKeyPairSigner();
const second = await generateKeyPairSigner();
const [firstPda] = await findProgrammaticSignerPda({ authority: first.address });
const [secondPda] = await findProgrammaticSignerPda({ authority: second.address });
const recipient = (await generateKeyPairSigner()).address;

console.log('== setup: a 2-of-2 multisig holds 1,000 tokens ==');
console.log(`  first approver:  ${first.address} (cold)`);
console.log(`  its pda:         ${firstPda}`);
console.log(`  second approver: ${second.address} (cold)`);
console.log(`  its pda:         ${secondPda}`);

// Create the 2-of-2 multisig: a Token program account that lists both PDAs as
// signers with a threshold of 2. The relayer pays its rent. Creating it needs
// no cold signature, because the PDAs are only recorded as signers here; they
// sign later, when tokens are withdrawn.
const newMultisig = await generateKeyPairSigner();
const multisig = newMultisig.address;
await relayer.sendTransaction([
    relayer.system.instructions.createAccount({
        lamports: await relayer.getMinimumBalance(getMultisigSize()),
        newAccount: newMultisig,
        programAddress: TOKEN_PROGRAM_ADDRESS,
        space: getMultisigSize(),
    }),
    relayer.token.instructions.initializeMultisig2({ m: 2, multisig, signers: [firstPda, secondPda] }),
]);
const newMint = await generateKeyPairSigner();
const mint = newMint.address;
await relayer.token.instructions
    .createMint({ decimals: DECIMALS, mintAuthority: relayer.payer.address, newMint })
    .sendTransactions();
await relayer.token.instructions
    .mintToATA({ amount: SUPPLY, decimals: DECIMALS, mint, mintAuthority: relayer.payer, owner: multisig })
    .sendTransactions();
await relayer.sendTransaction(
    await getCreateAssociatedTokenIdempotentInstructionAsync({ mint, owner: recipient, payer: relayer.payer }),
);
const multisigAccount = await associatedTokenAddress(multisig, mint);
const recipientAccount = await associatedTokenAddress(recipient, mint);
const balance = async (account: Address) => (await relayer.token.accounts.token.fetch(account)).data.amount;
console.log(`  multisig:        ${multisig} (needs both PDAs)`);
console.log(`  its account:     ${multisigAccount} holds ${uiAmount(await balance(multisigAccount))}`);

// The withdrawal needs one nonce account, as every action does. A nonce
// account has a single authority, so one of the two PDAs has to be chosen;
// this uses the first.
const nonceAccount = await createNonceAccount(relayer, firstPda);
const { nonce } = (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data;
console.log(`  nonce account:   ${nonceAccount}`);
console.log(`  nonce:           ${nonce}`);

// Build the message the approvers will sign. This happens once, on any
// machine, and needs no key:
//   1. the action: a TransferChecked out of the multisig's token account,
//      with both PDAs as its signers (noop signers, since a PDA has no key);
//   2. the execution message that holds the action;
//   3. the authorization message that holds it in an Execute instruction and
//      lists both cold keys as required signers.
console.log('\n== the authorization message both approvers sign ==');
const transfer = getTransferCheckedInstruction({
    amount: AMOUNT,
    authority: multisig,
    decimals: DECIMALS,
    destination: recipientAccount,
    mint,
    multiSigners: [createNoopSigner(firstPda), createNoopSigner(secondPda)],
    source: multisigAccount,
});
const execution = executionMessage(firstPda, singleInstructionPlan(transfer), nonce);
const authorization = authorizationMessage(execution, nonceAccount, firstPda, [first.address, second.address]);
const nextNonceValue = await nextNonce(nonceAccount, nonce, execution);
const decoded = getCompiledTransactionMessageDecoder().decode(authorization);
if (decoded.version !== 1) {
    throw new Error('the authorization message must be v1');
}
const requiredSigners = decoded.staticAccounts.slice(0, decoded.header.numSignerAccounts);
console.log(`  authorization message: ${authorization.length} bytes, ${requiredSigners.length} required signers`);

// Each approver signs the authorization message's bytes on its own machine.
// The two signatures are independent of each other, so the approvers can sign
// in any order. Here the second one signs first.
console.log('\n== signing on each cold side ==');
const secondSignature = await signBytes(second.keyPair.privateKey, authorization);
console.log(`  second approver: ${getBase58Decoder().decode(secondSignature)}`);
const firstSignature = await signBytes(first.keyPair.privateKey, authorization);
console.log(`  first approver:  ${getBase58Decoder().decode(firstSignature)}`);

/**
 * Arranges the collected signatures the way `Submit` expects them.
 *
 * `Submit` takes a list with one entry per required signer of the
 * authorization message, in the order the message lists those signers. This
 * puts each approver's signature at its position. A signer with no collected
 * signature gets `null`.
 *
 * Hand-written, and should ideally be provided by the upstream client, which
 * has no function that orders signatures collected separately.
 */
function signatures(collected: Map<Address, SignatureBytes>): (SignatureBytes | null)[] {
    return requiredSigners.map(signer => collected.get(signer) ?? null);
}

// The hot side. First relay with only the first approver's signature. The
// Signer program rejects it, because the authorization message lists two
// required signers and one of them has not signed.
console.log('\n== relayed with one signature ==');
await expectRejected(
    authorization,
    signatures(new Map([[first.address, firstSignature]])),
    ED25519_SIGNER_ERROR__MISSING_SIGNATURE,
    "the Signer's MissingSignature",
);

console.log('\n== relayed with both ==');
const { context: relay } = await relayer.ed25519Signer.instructions
    .submit({
        message: authorization,
        signatures: signatures(
            new Map([
                [second.address, secondSignature],
                [first.address, firstSignature],
            ]),
        ),
    })
    .sendTransaction();
console.log(`  landed:        ${relay.signature}`);
const fetched = await relayer.rpc
    .getTransaction(relay.signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 1 })
    .send();
console.log(`  compute units: ${fetched?.meta?.computeUnitsConsumed}`);

console.log('\n== read back ==');
const received = await balance(recipientAccount);
console.log(`  recipient account: ${recipientAccount} holds ${uiAmount(received)}`);
if (received !== AMOUNT) {
    throw new Error(`expected the recipient to hold ${AMOUNT}`);
}
const left = await balance(multisigAccount);
console.log(`  multisig account:  holds ${uiAmount(left)}`);
if (left !== SUPPLY - AMOUNT) {
    throw new Error(`expected the multisig to hold ${SUPPLY - AMOUNT}`);
}
const { nonce: advanced } = (await relayer.nonce.accounts.nonce.fetch(nonceAccount)).data;
console.log(`  nonce after:       ${advanced}`);
console.log(`  expected:          ${nextNonceValue}`);
if (advanced !== nextNonceValue) {
    throw new Error('the nonce did not advance to the value computed at signing time');
}

/**
 * Relays `message` with `collected` and throws unless it is rejected with the
 * custom program error `code`. The client simulates before sending, so the
 * rejection arrives wrapped in a simulation error.
 */
async function expectRejected(
    message: ReadonlyUint8Array,
    collected: (SignatureBytes | null)[],
    code: number,
    name: string,
) {
    try {
        await relayer.ed25519Signer.instructions.submit({ message, signatures: collected }).sendTransaction();
    } catch (error) {
        const cause = isSolanaError(error, SOLANA_ERROR__FAILED_TO_SEND_TRANSACTION)
            ? unwrapSimulationError(error.cause)
            : error;
        if (!isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM) || cause.context.code !== code) {
            throw new Error(`expected ${name}`, { cause: error });
        }
        console.log(`  rejected: ${cause.message} (${name})`);
        return;
    }
    throw new Error(`expected ${name}, but the relay landed`);
}
