/**
 * Offline test: the vendored TypeScript SDK, against what the Rust SDK
 * produces for the same inputs. `rust/tests/wire.rs` asserts the same
 * expected values on the Rust side.
 */

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
    advanceVectorDigest,
    createSystemPassthroughInstruction,
    ED25519,
    findSystemPda,
    findVectorPda,
    signAdvanceInstructionEd25519,
} from '../src/client';

// Fixed inputs: the cold key's secret key is 32 bytes of 1, the recipient is
// 32 bytes of 2, and the nonce is 32 bytes of 3.
const COLD_SEED = new Uint8Array(32).fill(1);
const RECIPIENT = new PublicKey(new Uint8Array(32).fill(2));
const NONCE = new Uint8Array(32).fill(3);
const AMOUNT = 10_000_000n;

// What the Rust SDK produces for them. The Advance data is its discriminator,
// an expiry slot of u64::MAX (never), then the signature.
const EXPECTED_SYSTEM_PDA = '5YbEe7Qjhm4sGD89qX5LrczzS6h1E3kdJPWPAARffPAj';
const EXPECTED_ADVANCE_DATA =
    '00ffffffffffffffffcc12e2d2224349b9519c1d8b260d682aef1d0e50e7d045b300f69402b257d06c37ad4e851131837d0048affd56c23b5c28afe760e4f1d594c714d739807d2c00';
const EXPECTED_NEXT_NONCE = 'Bcj9zkLSXMK8WEQV7YvPQsULuwaFwk8Zt95LhgVBuTNw';

describe('against the Rust SDK', () => {
    it('the signed instructions and the next nonce match byte for byte', async () => {
        const identity = (await Keypair.fromSeed(COLD_SEED)).publicKey.toBytes();
        const [systemPda] = findSystemPda(findVectorPda(ED25519, identity)[0]);
        expect(systemPda.toBase58()).toBe(EXPECTED_SYSTEM_PDA);

        const transfer = SystemProgram.transfer({ fromPubkey: systemPda, lamports: AMOUNT, toPubkey: RECIPIENT });
        const passthrough = createSystemPassthroughInstruction(ED25519, identity, [transfer]);
        const advance = signAdvanceInstructionEd25519(COLD_SEED, NONCE, [], [passthrough]);
        expect(Buffer.from(advance.data).toString('hex')).toBe(EXPECTED_ADVANCE_DATA);

        const next = advanceVectorDigest(ED25519, NONCE, identity, [], [passthrough]);
        expect(new PublicKey(next).toBase58()).toBe(EXPECTED_NEXT_NONCE);
    });
});
