/** Connecting to a cluster, funding keys, sending transactions, and waiting out a blockhash. */

import {
    type Blockhash,
    Connection,
    Keypair,
    type TransactionInstruction,
    type TransactionSignature,
} from '@solana/web3.js';

import { createV1Transaction, PROGRAM_ID, type V1Limits } from '../client';

export const DEFAULT_RPC_URL = 'http://127.0.0.1:8899';
export const DEFAULT_RPC_SUBSCRIPTIONS_URL = 'ws://127.0.0.1:8900';

/**
 * The budget every transaction the examples send requests.
 *
 * Unset v1 limits are zero, not the legacy defaults, so each transaction
 * states them; the SDK's own default is the 1.4 million maximum. They live in
 * the message, not in an instruction, so the cold key's digest does not cover
 * them and the relayer chooses. The relay of a SOL transfer costs about 17,000
 * compute units, a token transfer 32,000 to 36,000, and both load the 580 KB
 * program.
 */
const LIMITS: V1Limits = { computeUnitLimit: 200_000, loadedAccountsDataSizeLimit: 4 * 1024 * 1024 };

/**
 * Connects to the endpoints named by `VECTOR_RPC_URL` and
 * `VECTOR_RPC_SUBSCRIPTIONS_URL`, or a local validator, at `confirmed`
 * commitment, which every example uses.
 */
export function connect(): Connection {
    return new Connection(process.env.VECTOR_RPC_URL ?? DEFAULT_RPC_URL, {
        commitment: 'confirmed',
        wsEndpoint: process.env.VECTOR_RPC_SUBSCRIPTIONS_URL ?? DEFAULT_RPC_SUBSCRIPTIONS_URL,
    });
}

/**
 * Throws unless the Vector program is deployed on the cluster behind
 * `connection`.
 *
 * Checked up front so a validator started without it names itself, rather
 * than surfacing later as a `ProgramAccountNotFound` on the relay.
 */
export async function assertProgramDeployed(connection: Connection): Promise<void> {
    const account = await connection.getAccountInfo(PROGRAM_ID);
    if (!account?.executable) {
        throw new Error(
            `the Vector program (${PROGRAM_ID.toBase58()}) is not deployed on this cluster; start a validator with \`just validator-start\``,
        );
    }
}

/** Creates a keypair funded by airdrop, waiting for the airdrop to confirm. */
export async function fundedKeypair(connection: Connection, lamports: number): Promise<Keypair> {
    const keypair = await Keypair.generate();
    const signature = await connection.requestAirdrop(keypair.publicKey, lamports);
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) });
    return keypair;
}

/**
 * Sends `instructions` in one v1 transaction paid by `payer`, signed by
 * `signers`, and waits for it to confirm. Setup steps and the relay both go
 * through here: the relay is the `Advance` and `Passthrough` instructions
 * from a hot key.
 */
export async function sendTransaction(
    connection: Connection,
    payer: Keypair,
    instructions: TransactionInstruction[],
    signers: Keypair[],
): Promise<TransactionSignature> {
    const latest = await connection.getLatestBlockhash();
    const transaction = createV1Transaction({
        feePayer: payer.publicKey,
        instructions,
        limits: LIMITS,
        recentBlockhash: latest.blockhash,
    });
    await transaction.sign(signers);
    const signature = await connection.sendTransaction(transaction);
    await connection.confirmTransaction({ signature, ...latest });
    return signature;
}

/**
 * Resolves once `blockhash` can no longer be used in a transaction.
 *
 * A blockhash lives for 150 slots. The examples capture one when the cold key
 * signs and wait it out before relaying, which is the shortest demonstration
 * that what the cold key signed does not expire with it.
 */
export async function waitForBlockhashExpiry(connection: Connection, blockhash: Blockhash): Promise<void> {
    while ((await connection.isBlockhashValid(blockhash)).value) {
        await new Promise(resolve => setTimeout(resolve, 2_000));
    }
}
