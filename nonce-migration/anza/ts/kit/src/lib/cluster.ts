/** Connecting with a funded key, checking the programs are deployed, and waiting out a blockhash. */

import {
    ED25519_SIGNER_PROGRAM_ADDRESS,
    ed25519SignerProgram,
    MESSAGE_EXECUTOR_PROGRAM_ADDRESS,
    NONCE_PROGRAM_ADDRESS,
    nonceProgram,
} from '@solana-program/ed25519-programmatic-signer';
import { systemProgram } from '@solana-program/system';
import { tokenProgram } from '@solana-program/token';
import {
    appendTransactionMessageInstruction,
    type Blockhash,
    createClient,
    createTransactionMessage,
    fetchEncodedAccount,
    getBase64EncodedWireTransaction,
    getSignatureFromTransaction,
    type Instruction,
    lamports,
    pipe,
    setTransactionMessageConfig,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    type Signature,
    signTransactionMessageWithSigners,
    type TransactionError,
} from '@solana/kit';
import { solanaLocalRpc } from '@solana/kit-plugin-rpc';
import { airdropSigner, generatedSigner } from '@solana/kit-plugin-signer';

export const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';
export const DEFAULT_RPC_SUBSCRIPTIONS_URL = 'ws://127.0.0.1:8900';

/**
 * A `@solana/kit` plugin client for a freshly generated key funded by airdrop.
 *
 * `solanaLocalRpc` connects to the endpoints named by `PSIGNER_RPC_URL` and
 * `PSIGNER_RPC_SUBSCRIPTIONS_URL` and installs transaction planning and
 * sending: every transaction the client sends is v1, paid by `client.payer`,
 * with resource limits measured by simulation. The program plugins hang typed
 * instruction builders and account fetchers off the client, and each builder
 * can send itself.
 */
export async function createFundedClient(amount: bigint) {
    return (
        await createClient()
            .use(generatedSigner())
            .use(
                solanaLocalRpc({
                    rpcSubscriptionsUrl: process.env.PSIGNER_RPC_SUBSCRIPTIONS_URL ?? DEFAULT_RPC_SUBSCRIPTIONS_URL,
                    rpcUrl: process.env.PSIGNER_RPC_URL ?? DEFAULT_RPC_URL,
                }),
            )
            .use(airdropSigner(lamports(amount)))
    )
        .use(systemProgram())
        .use(tokenProgram())
        .use(nonceProgram())
        .use(ed25519SignerProgram());
}

export type Client = Awaited<ReturnType<typeof createFundedClient>>;

/** The three programs the examples call, with the names their crates use. */
export const PROGRAMS = [
    ['SPL Nonce', NONCE_PROGRAM_ADDRESS],
    ['SPL Ed25519 Signer', ED25519_SIGNER_PROGRAM_ADDRESS],
    ['SPL Message Executor', MESSAGE_EXECUTOR_PROGRAM_ADDRESS],
] as const;

/**
 * Throws unless all three programs are deployed on the cluster behind `rpc`.
 *
 * Checked up front so a validator started without them names itself, rather
 * than surfacing later as a `ProgramAccountNotFound` on the relay.
 */
export async function assertProgramsDeployed(rpc: Client['rpc']): Promise<void> {
    for (const [name, programAddress] of PROGRAMS) {
        const account = await fetchEncodedAccount(rpc, programAddress);
        if (!account.exists || !account.executable) {
            throw new Error(
                `the ${name} program (${programAddress}) is not deployed on this cluster; start a validator with \`just validator-start\``,
            );
        }
    }
}

/**
 * Sends `instruction` in one v1 transaction paid by the client's payer, but
 * tells the RPC node not to simulate it first, and returns how it ended on
 * chain.
 *
 * An RPC node normally simulates a transaction and refuses to send one that
 * would fail, and the client's own `sendTransaction` simulates as well.
 * Skipping both lets a failing transaction land, which is the only way to see
 * what a failure leaves behind on chain. The client cannot measure the
 * resource limits without simulating, so they are stated here. `err` is
 * `null` if the transaction succeeded.
 */
export async function sendTransactionWithoutPreflight(
    client: Client,
    instruction: Instruction,
): Promise<{ err: TransactionError | null; signature: Signature }> {
    const { value: latest } = await client.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const transaction = await signTransactionMessageWithSigners(
        pipe(
            createTransactionMessage({ version: 1 }),
            m => setTransactionMessageFeePayerSigner(client.payer, m),
            m => setTransactionMessageLifetimeUsingBlockhash(latest, m),
            m => appendTransactionMessageInstruction(instruction, m),
            m =>
                setTransactionMessageConfig(
                    { computeUnitLimit: 200_000, loadedAccountsDataSizeLimit: 4 * 1024 * 1024 },
                    m,
                ),
        ),
    );
    const signature = getSignatureFromTransaction(transaction);
    await client.rpc
        .sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', skipPreflight: true })
        .send();
    // Wait until the cluster has processed it, one way or the other. A
    // transaction can also be dropped without landing. Once its blockhash has
    // expired it never will land, so stop waiting then.
    for (;;) {
        const [status] = (await client.rpc.getSignatureStatuses([signature]).send()).value;
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
            return { err: status.err, signature };
        }
        if ((await client.rpc.getBlockHeight({ commitment: 'confirmed' }).send()) > latest.lastValidBlockHeight) {
            throw new Error(`transaction ${signature} was dropped: its blockhash expired before it landed`);
        }
        await new Promise(resolve => setTimeout(resolve, 400));
    }
}

/**
 * Resolves once `blockhash` can no longer be used in a transaction.
 *
 * A blockhash lives for 150 slots. The examples capture one when the cold key
 * signs and wait it out before relaying, which is the shortest demonstration
 * that the signed artifact does not expire with it.
 */
export async function waitForBlockhashExpiry(rpc: Client['rpc'], blockhash: Blockhash): Promise<void> {
    for (;;) {
        const { value: valid } = await rpc.isBlockhashValid(blockhash, { commitment: 'confirmed' }).send();
        if (!valid) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 2_000));
    }
}
