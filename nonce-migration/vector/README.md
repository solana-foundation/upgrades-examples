# vector

Working examples for [Vector](https://github.com/blueshift-gg/vector), Blueshift's replacement for durable nonce transactions, in Rust and TypeScript: signing an action with a cold key that never goes online, relaying it later from a hot key, and reading back what happened.

Every example runs against a local `solana-test-validator` from Anza CLI 4.4.1 with the Vector program loaded, and the whole suite is exercised in CI. What changes from a durable nonce transaction, the operations a migration consists of, and what is still to come are in the [directory README](../README.md); this one is the Vector specifics.

## Terms

- **Durable nonce**: a System program nonce account and the transaction that consumes it. What you have today.
- **Vector account**: an account of the Vector program at an address derived from the cold key. It stores that key and one nonce.
- **System PDA**: a second address, derived from the vector account and owned by the System program. It holds the SOL.
- **Advance**: the instruction that carries the cold key's signature and moves the nonce.
- **Passthrough**: the instruction that runs the action as the vector account or its system PDA.
- **Digest**: the hash of the transaction's instructions, the nonce, and the vector account's address. The cold key signs it, and it becomes the next nonce.

The names are Vector's, as its README and SDKs use them.

## Quick start

```sh
just setup-solana     # Anza CLI 4.4.1
just setup            # Rust and TypeScript dependencies
just setup-programs   # build the Vector program from the pinned commit
just demo             # start a validator, run every example, shut it down
```

To keep a validator up and drive the examples yourself:

```sh
just validator-start  # local validator with the Vector program loaded
just sign-relay       # …then any example below
just validator-stop
```

Vector has no release: no tags, nothing on crates.io or npm, and the program is deployed on no cluster. Everything here is pinned to one commit of [blueshift-gg/vector](https://github.com/blueshift-gg/vector), named once in the `Justfile`. The Rust SDK is a git dependency on it, `just setup-programs` builds the program from it with `cargo build-sbf`, and the part of the TypeScript SDK the examples use is checked in under [`ts/web3js-v3/src/client/`](ts/web3js-v3/src/client), copied from it by `just vendor-ts-client`.

## Examples

| What | Rust | TypeScript |
|---|---|---|
| Sign a SOL transfer with a cold key, relay it after the signing-time blockhash expires, reject an edited relay and a replay | `just sign-relay` | `just ts-sign-relay` |
| Sign a token withdrawal with a cold key, creating the recipient's token account on the way, and relay it from a hot key | `just token-transfer` | `just ts-token-transfer` |
| Two cold approvers sign one token withdrawal on separate machines; a relay with one signature is rejected, with both it lands | `just multi-signer` | `just ts-multi-signer` |
| A relay that lands and fails keeps its nonce, and the same signed action lands later | `just failed-attempt` | `just ts-failed-attempt` |
| An action signed with a deadline is rejected once that slot has passed | `just deadline` | `just ts-deadline` |
| Cancel a signed action by landing another one over the same nonce; the cancelled action is then rejected | `just cancel` | `just ts-cancel` |
| Move a cold key's SOL, tokens, mint and freeze authority, and locked stake to its system PDA in one checked transaction, then use each of them | `just migrate` | `just ts-migrate` |
| Sign three actions at once, each over its own nonce account, and relay them out of order | `just parallel` | `just ts-parallel` |
| Sign on a machine with no network: it receives what the online side prepared, shows it, and signs it | `just airgapped` | `just ts-airgapped` |

Source: [`rust/src/bin/`](rust/src/bin) and [`ts/web3js-v3/src/`](ts/web3js-v3/src).

The operations in the directory README are calls into the Vector SDK; the shared modules in [`rust/src/`](rust/src) and [`ts/web3js-v3/src/lib/`](ts/web3js-v3/src/lib) hold only what it lacks.

| Operation | Rust | TypeScript |
|---|---|---|
| Derive the two addresses | `find_vector_pda`, `find_system_pda` | `findVectorPda`, `findSystemPda` |
| Create the vector account | `create_initialize_ed25519` | `createInitializeEd25519` |
| Move the funds | an ordinary transfer to the system PDA | an ordinary transfer to the system PDA |
| Read the nonce | `vector::fetch_nonce` | `fetchVectorAccount` |
| Wrap the action | `create_system_passthrough_instruction` | `createSystemPassthroughInstruction` |
| Sign on the cold side | `sign_advance_instruction_ed25519` | `signAdvanceInstructionEd25519` |
| Compute the next nonce | `advance_vector_digest` | `advanceVectorDigest` |
| Relay on the hot side | send the two instructions | send the two instructions |
| Sign with several approvers | `advance_message` once, `signer_digest` per approver, each signs `signed(&digest)`, then `create_multi_advance_instruction` and `create_multi_passthrough_instruction` | `advanceMessage` once, `signerDigest` and `signDigestEd25519` per approver, then `createMultiAdvanceInstruction` and `createMultiPassthroughInstruction` |
| Sign with a deadline | `advance_message` with the last valid slot, `signer_digest`, `create_multi_advance_instruction` | `signAdvanceInstructionEd25519` with a trailing `validUntil` |
| Cancel a signed action | `sign_revocation_instruction_ed25519`; `revocation_digest` is the nonce it leaves | `signRevocationInstructionEd25519`; `revocationDigest` is the nonce it leaves |
| Migrate with both owners signing | a durable nonce transaction carrying `Advance` and `Passthrough`; sign the `Advance` with `AdvanceNonceAccount` as a pre-instruction and the cold key as fee payer | the same, with `signAdvanceInstructionEd25519` |
| Keep several actions in flight | one nonce account per action: `create_initialize_nonce_instruction`, then sign with `AdvanceSigner { nonce_account }` over `signed_nonce` | one nonce account per action: `createInitializeNonceInstruction`, then sign with `{ nonceAccount }` over `signedNonce` |
| Build the token instructions | `spl-token-interface`, `spl-associated-token-account-interface` | `@solana-program/token`, converted by `toTransactionInstructions` in `token.ts` |

`sign-relay` sends the same transfer twice: first as a durable nonce transaction, then through Vector, printing what it builds as it goes. Between signing and relaying it waits for a blockhash captured at signing time to expire (150 slots), which is the shortest proof that what the cold key signed outlives one. Set `VECTOR_SKIP_EXPIRY=true` to skip the wait. Before the relay it sends the same signature with the amount doubled, and afterwards it sends the relay a second time; both must be rejected.

`token-transfer` is the withdrawal most nonce users run: tokens, not SOL. The system PDA holds 1,000 of a Token program mint, the kind USDC is. The cold key signs one action that creates the recipient's token account, with the system PDA paying the rent, and moves 250 into it; the hot key relays it. It costs 32,000 to 36,000 compute units against about 17,000 for a SOL transfer, most of the difference the account creation. The figure moves from run to run because deriving the token account addresses costs more for some keys than for others. Both numbers are measured on a local validator with the program built from the pinned commit; Vector is deployed on no cluster, so there is no mainnet figure to compare them with. The `Passthrough` data grows from 19 bytes to 21, because it holds each instruction's data and account count while the accounts themselves are listed on the instruction.

`multi-signer` is two approvers on one withdrawal. Each cold key has its own vector account and system PDA, and the 1,000 tokens belong to a Token program multisig whose two signers are those system PDAs, so neither approver can move them alone. The instructions are built once with both approvers listed; each then signs its own digest on its own machine, the second one first here, and the hot key puts both signatures into one `Advance`. A relay with one signature is rejected; with both it lands, and each account's nonce moves to the digest its approver signed. It costs about 32,000 compute units.

`failed-attempt` shows what a failed relay leaves behind. The cold key signs a transfer the system PDA cannot afford. The relay is sent without simulation, so it lands on chain and fails; the relayer pays the fee, and the nonce is rolled back with everything else. The same two instructions then land once the PDA is funded, with nothing signed again. A durable nonce transaction that landed and failed would have used up its nonce.

`deadline` signs a transfer that is valid for 20 slots. The example waits past the deadline and relays. The relay is rejected with Vector's `Expired`, no funds move, and the nonce is unchanged.

`cancel` cancels an action that has already been signed. The cold key signs a transfer and, in the same session, a revocation over the same nonce: an `Advance` with no other instruction. The hot key relays the revocation, which only advances the nonce. The transfer's signature then no longer verifies, so relaying it is rejected and the recipient's balance stays at zero.

`migrate` is the move itself. A cold key starts out holding SOL and tokens, being the mint and freeze authority of a mint, and being the staker, withdrawer, and lockup custodian of a stake account. One transaction hands all of it to the key's system PDA. Then the cold key signs one digest, and the PDA spends SOL, sends tokens, mints, freezes a token account, and withdraws from the locked stake. The migration costs 71,000 to 73,000 compute units and the follow-up about 46,000.

The migration is "checked". It is a durable nonce transaction signed by the cold key, the last one it needs, and inside it is an `Advance` signed by the same key that lets the system PDA sign. Both signatures are required: the stake program's `AuthorizeChecked` and `SetLockupChecked` want the new authority to sign, and so the migration fails, moving nothing, if the PDA cannot act. The example shows this first: the cold key sends the same handover on its own, without the system PDA signing, and it is rejected with a missing signature.

`parallel` signs three transfers in one session and relays them in a different order. A vector account holds one nonce value, so actions signed over it land one after the other. Here each transfer is signed over its own nonce account, a separate small account that holds a nonce of its own, and each lands on its own. The vector account's own nonce does not move.

`airgapped` splits the flow into three steps: prepare online, review and sign offline, relay online. The online side reads the nonce, builds the `Passthrough` instruction that holds the transfer, and computes the 32-byte digest of it. The offline step is a function that is not given a connection, so it cannot make a network call. It receives only the digest. The key signs 39 bytes: the text `vector:` followed by the digest. The step prints those bytes, as a hardware wallet does, and hands back the 64-byte signature. A digest is a hash, so the transfer cannot be read from it; the operator relies on the online side to have computed it from the intended action. The online side puts the signature into an `Advance` instruction and relays it with the `Passthrough`.

## The two instructions

```text
relay transaction            signed by the hot relayer, fresh blockhash, pays the fee, 445 bytes, v1
├─ Advance instruction       to the Vector program: the cold key's signature and an expiry slot, 73 bytes of data
└─ Passthrough instruction   to the Vector program: the action, to run as the system PDA, 19 bytes of data
   └─ the action             an ordinary System transfer from the system PDA
```

There is no inner message. The cold key signs a digest of the transaction's instructions as the program will read them back from the instructions sysvar: every top-level instruction, in order, with only the signature itself cut out. `Advance` checks the signature against that digest and stores the digest as the account's next nonce. `Passthrough` then checks that an `Advance` naming the same account came earlier in the transaction, and runs the action by CPI with the system PDA as signer.

What the cold key signs is 39 bytes: the text `vector:` followed by the digest.

## What crosses the air gap

The cold side needs the nonce value and nothing else from the network. What it hands the relayer is the two instructions, `Advance` and `Passthrough`, as `sign_advance_instruction_ed25519` and `create_system_passthrough_instruction` return them. The SDK defines no file format for the handoff, so serialize them however your air gap requires.

The relayer cannot change the amount, the recipient, or the nonce, and cannot add, drop, or reorder an instruction, without invalidating the signature. It can choose when to relay, with which blockhash, from which fee payer, and with what compute budget.

The next nonce is known before anything is sent because it is the digest the cold key signed: `sha256(sha256(instructions) || current nonce || vector account)`. That is what lets a chain of actions be signed up front, each valid only after the one before, and it is what the examples check after relaying.

## Common gotchas

**There are two addresses, and the SOL goes to the second.** The vector account belongs to the Vector program, so it cannot be the source of a System transfer. The system PDA can, and `create_system_passthrough_instruction` signs as it. SOL sent to the vector account by mistake is not lost, but it leaves only through the program's `Withdraw` or `Close` instruction.

**The vector account has to exist before the cold key signs.** The nonce lives in it, and its first value is derived from a slot hash at creation, so it cannot be computed ahead. Anyone can create the account for any key and pay its rent; the cold key does not sign. Because of that, the account existing says nothing about who created it.

**The signature does not expire unless you say so.** `sign_advance_instruction_ed25519` signs an expiry slot of never, which matches a durable nonce transaction. It also means a relay that fails, which rolls back the nonce with everything else, can be sent again later. `Advance` takes a last valid slot for this: in TypeScript it is the trailing `validUntil` argument of the same function; in Rust, build the digest with `advance_message` and `signer_digest` and the instruction with `create_multi_advance_instruction`. `deadline` does both. The deadline is a slot, not a time.

**Every rejection is `MissingRequiredSignature`.** A replay, an edited amount, and an instruction the relayer added all fail the same way: the digest the program rebuilds is not the one that was signed. There is no custom error code to tell them apart.

**The relayer cannot add a Compute Budget instruction.** The digest covers every top-level instruction. On a v1 transaction that is not a restriction, because the limits and the priority fee are fields of the message and the digest does not cover them. On a legacy transaction they are instructions, so the cold key has to sign them in.

**Unset v1 limits are zero.** The compute unit limit and the loaded-accounts limit have to be stated. The SDK's `createV1Transaction` defaults to the maximum of each; the examples request 200,000 compute units and 4 MB. A SOL transfer uses about 17,000 compute units, a token transfer that creates the recipient's account 32,000 to 36,000, and both load the 580 KB program.

**The cold key signs a hash.** A hardware wallet shows `vector:` and 32 bytes, not the transfer. `verify_advance_signature` in the Rust SDK checks a signature against a set of instructions offline, with the program's own code, and returns the next nonce. The TypeScript SDK has `verifyAdvanceTransaction`, which is not among the vendored files.

**Name the fee payer only if the action does.** The digest covers the fee payer when it is also an account of a signed instruction, a refund to the relayer for example. Pass it as the last argument of the signing functions in that case, and only that key can relay. In these examples it is not, so any funded key can.

**Each approver has its own account and its own nonce.** Two approvers are two vector accounts and two system PDAs. Each signs a different digest, the shared message combined with its own nonce and address, and each account's nonce advances separately. An action needs both only if something it touches requires both to sign, such as the Token multisig in `multi-signer`.

**The signer list is fixed before anyone signs.** Every approver's digest covers the full list of signers in the `Advance` instruction and their order, so an approver cannot be added, dropped, or swapped after the first signature, and the signatures go into the instruction in that same order. A transaction can also carry only one `Advance`: all approvers go into it.

**One-call signing is for one signer.** `sign_advance_instruction_ed25519` builds, signs, and returns an `Advance` for a single key. For several approvers on separate machines, use `advance_message`, `signer_digest`, and `create_multi_advance_instruction`, as `multi-signer` does.

**A revocation has to be signed by the cold key too, and sent alone.** Nothing online can advance the nonce on its own. Cancelling means relaying `sign_revocation_instruction_ed25519`'s `Advance`, which needs the cold key's signature. If it is signed in the same session as the action, the cold key does not have to come back online to cancel. It was signed as the only instruction of its transaction, so it has to be relayed that way.

**Everything goes to the system PDA, authorities included.** Both the vector account and its system PDA can sign through `Passthrough`, so either could be a stake or mint authority. `migrate` uses the system PDA for all of it. It already has to hold the SOL, because the vector account cannot be the source of a System transfer, and one address for funds and authorities is simpler to operate and to audit.

**A Passthrough can carry another signer.** In the migration the instructions need two signers: the system PDA, which the program signs for, and the cold key itself as the current owner. The cold key signs the transaction, and `Passthrough` passes that on to the instructions inside. Because the cold key is the fee payer and also an account of those instructions, it has to be given as the fee payer when signing the `Advance`. `AdvanceNonceAccount` is given as the instruction that comes before it, since the digest covers every instruction in the transaction.

**A lockup custodian is one more authority to move.** While a stake lockup is in force, changing the withdrawer or withdrawing needs the custodian's signature as well. `migrate` moves the withdrawer while the cold key is still custodian, then moves the custodian, in that order.

**One nonce, one action in flight.** A vector account holds one nonce, so a second action signed over it is valid only after the first lands. For actions that land independently, create nonce accounts and sign each action over a different one, as `parallel` does. A nonce account cannot be used in the slot it was created in. The nonce that goes into the digest is `signed_nonce`: a hash of the nonce account's nonce and the vector account's own nonce.

**The system PDA pays rent, so keep it in SOL.** It is a System-owned address with lamports, so a `Passthrough` can carry `CreateAssociatedTokenAccountIdempotent` with the system PDA as payer, which is how `token-transfer` creates the recipient's account. A system PDA that holds only tokens cannot do that. The token accounts belong to the system PDA, not to the vector account.

**No token client is written for `@solana/web3.js` 3.** `@solana/spl-token` still requires web3.js 1, so the TypeScript example builds its token instructions with `@solana-program/token`, the `@solana/kit` client. web3.js 3 is built on kit and its own compiler accepts kit instructions, but the Vector SDK's builders take only `TransactionInstruction`, and web3.js does not export its converter. [`ts/web3js-v3/src/lib/token.ts`](ts/web3js-v3/src/lib/token.ts) has a hand-written one, `toTransactionInstructions`, until one of the two changes.

**The TypeScript SDK is not on npm and targets `@solana/web3.js` 3, not `@solana/kit`.** [`scripts/vendor-ts-client.sh`](scripts/vendor-ts-client.sh) copies the six source files the Ed25519 scheme needs out of the pinned commit. The SDK's index and its offline verifier import every signature scheme, and with them the post-quantum libraries; the examples need neither. On crates.io, `vector-core` is an unrelated project, so the Rust SDK is a git dependency.

**The program builds for SBPF v0.** `cargo build-sbf` 4.4 targets SBPF v3 by default, under which the program's dependencies fail to link their syscalls. `scripts/setup-programs.sh` passes `--arch v0`, as the Vector README says to.

## Version requirements

| Component | Minimum | Why |
|---|---|---|
| Anza CLI / Agave | 4.4.1 | the current stable release; every transaction here is v1, for which Vector asks 4.2.2 or later |
| `blueshift-gg/vector` | commit `f806f6c` (14 Nov 2026), version 2.0.0 | the program, the Rust SDK, and the vendored TypeScript SDK come from this commit; there are no tags or releases |
| `vector-core` | git, same commit | the Rust SDK; it depends on the program crate, so the digest is computed by the program's own code |
| Rust | 1.100.0 | the toolchain `nonce-migration/anza` pins, so both backends build with one |
| `ed25519-dalek` | 2.1.1 | the key type the SDK's Ed25519 signer takes, at the exact version it pins |
| `solana-message` | 5.1.0 | the version `nonce-migration/anza` uses; `v1::Message` for every transaction |
| `@solana/web3.js` | 3.2.1 | the SDK's peer dependency; `compileToV1Message` and v1 `VersionedTransaction` |
| `@noble/curves`, `@noble/hashes` | 1.8.0, 1.7.0 | what the vendored SDK files import for Ed25519 and SHA-256 |
| `spl-token-interface` | 3.0.0 | the version `nonce-migration/anza` uses; `spl-associated-token-account-interface` 2.0.0 alongside it |
| `@solana-program/token` | 0.18.0 | the `createMint`, `mintToATA`, and `transferToATA` instruction plans |
| `solana-stake-interface`, `@solana-program/stake` | 5.1.1, 0.11.0 | `migrate`: the crate builds the stake instructions in Rust; in TypeScript web3.js's own `StakeProgram` builds them and the kit client reads the account back |
| `@solana/kit` | 8.6.0 | what `@solana-program/token` is written for and web3.js 3 is built on; `createNoopSigner` and `flattenInstructionPlan` |

## Configuration

Every example reads its settings from the environment.

| Variable | Default | Used by |
|---|---|---|
| `VECTOR_RPC_URL` | `http://127.0.0.1:8899` | all examples |
| `VECTOR_RPC_SUBSCRIPTIONS_URL` | `ws://127.0.0.1:8900` | TypeScript examples |
| `VECTOR_SKIP_EXPIRY` | unset | set to any value to relay without waiting for the signing-time blockhash to expire |
| `VECTOR_COMMIT` | set by `just` | the pinned commit the scripts clone |

## Testing

```sh
just test   # offline: what the cold key signs and the next nonce, in both languages
just demo   # every example against a fresh validator; each checks its own result
just check  # format, lint, typecheck, and the offline tests
```

The offline tests sign one fixed transfer in both languages and assert the same `Advance` data and the same next nonce; [`rust/tests/wire.rs`](rust/tests/wire.rs) and [`ts/web3js-v3/test/wire.test.ts`](ts/web3js-v3/test/wire.test.ts) hold the same expected values. Unlike a compiled message, the digest does not depend on how a library orders accounts, so the two SDKs agree byte for byte and an action signed in one language relays from the other. The examples are the live tests: each exits non-zero unless the relay landed, the funds arrived, the nonce advanced to the value computed at signing time, and a relay with the amount edited and a replay were both rejected; `multi-signer` requires the one-signature relay to be rejected and both nonces to advance, `failed-attempt` requires the first relay to fail on chain with the nonce unchanged, `deadline` requires the late relay to be rejected with the nonce unchanged, `cancel` requires the cancelled action to be rejected with the funds unmoved, and `migrate` requires the handover without the new owner to be rejected, and checks every balance, every authority, and the lockup after each of its two transactions; `parallel` requires all three transfers to land out of order with each nonce account advanced; `airgapped` requires the transfer signed offline to land. CI runs `just check` and `just demo`.

## Layout

```
rust/src/bin/               Rust example binaries, one per example
rust/src/                   the Rust library they share
rust/tests/                 offline tests
ts/web3js-v3/src/           @solana/web3.js 3 example scripts, one per example
ts/web3js-v3/src/lib/       the modules they share
ts/web3js-v3/src/client/    the Ed25519 part of the Vector TypeScript SDK, vendored from the pinned commit
ts/web3js-v3/test/          offline tests
scripts/                    validator, program build, and SDK vendoring
```

Runnable examples are separate from the code they share. A file directly under `src/bin/` or `src/` is an entry point: it runs top to bottom and has a `just` recipe. The library modules mirror each other and `nonce-migration/anza`: `cluster` connects, funds keys, sends v1 transactions, and checks the program is deployed; `durable_nonce` (`durable-nonce` in TypeScript) is the durable nonce flow for comparison; `token` holds the token helpers the examples need, which in Rust includes the mint setup and in TypeScript the conversion of kit instructions; `vector`, in Rust only, reads the nonce of a vector account and of a nonce account, which the TypeScript SDK does itself.

## Additional resources

- [blueshift-gg/vector](https://github.com/blueshift-gg/vector), whose README is the specification
- [Nonce Replacement Meta-Proposal, SIMD discussion #456](https://github.com/solana-foundation/solana-improvement-documents/discussions/456)
