/**
 * The flow being replaced: a System durable nonce transaction.
 *
 * Here for comparison. The cold key owns the funds, creates a nonce account
 * with the System program, and signs a transaction whose first instruction is
 * `AdvanceNonceAccount` and whose blockhash slot holds the nonce value. That
 * transaction is sent as-is, whenever.
 */

import {
    type Connection,
    type DurableNonce,
    Keypair,
    NONCE_ACCOUNT_LENGTH,
    type PublicKey,
    SystemProgram,
    type VersionedTransaction,
} from '@solana/web3.js';

import { createV1Transaction, type V1Limits } from '../client';
import { sendTransaction } from './cluster';

/** Creates a System nonce account whose authority is `cold`, paid for by `cold`. */
export async function createDurableNonceAccount(connection: Connection, cold: Keypair): Promise<PublicKey> {
    const nonceAccount = await Keypair.generate();
    const { instructions } = SystemProgram.createNonceAccount({
        authorizedPubkey: cold.publicKey,
        fromPubkey: cold.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH),
        noncePubkey: nonceAccount.publicKey,
    });
    await sendTransaction(connection, cold, instructions, [cold, nonceAccount]);
    return nonceAccount.publicKey;
}

/** Reads the value a System nonce account currently holds. */
export async function fetchDurableNonce(connection: Connection, nonceAccount: PublicKey): Promise<DurableNonce> {
    const account = await connection.getNonce(nonceAccount);
    if (account === null) {
        throw new Error(`${nonceAccount.toBase58()} is not a System nonce account`);
    }
    return account.nonce;
}

/**
 * The budget of the durable nonce transfer: two System instructions cost 300
 * compute units, and the cold key is offline and cannot simulate.
 */
const DURABLE_NONCE_LIMITS: V1Limits = { computeUnitLimit: 1_000, loadedAccountsDataSizeLimit: 64 * 1024 };

/**
 * Signs a durable nonce transfer from `cold`. Nothing is sent.
 *
 * The message is v1, and a durable nonce works on it as it does on a legacy
 * one: the nonce sits in the blockhash slot and `AdvanceNonceAccount` comes
 * first.
 */
export async function signDurableNonceTransfer(
    cold: Keypair,
    nonceAccount: PublicKey,
    nonce: DurableNonce,
    recipient: PublicKey,
    lamports: bigint,
): Promise<VersionedTransaction> {
    const transaction = createV1Transaction({
        feePayer: cold.publicKey,
        instructions: [
            SystemProgram.nonceAdvance({ authorizedPubkey: cold.publicKey, noncePubkey: nonceAccount }),
            SystemProgram.transfer({ fromPubkey: cold.publicKey, lamports, toPubkey: recipient }),
        ],
        limits: DURABLE_NONCE_LIMITS,
        recentBlockhash: nonce,
    });
    await transaction.sign([cold]);
    return transaction;
}
