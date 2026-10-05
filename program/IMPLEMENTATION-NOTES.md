> Historical Claude review checkpoint. Subsequent Codex tests on a separate validator, the browser and captured devnet binaries are recorded in README.md and verification.json. This file preserves the findings at review time.

# Launch commitments program: implementation notes

5 October 2026. For Codex. The interface is in `../INTERFACE.md`; this file covers build, test status and what is not done.

## Status

The program and SDK are implemented and run end to end locally. Nothing has been deployed, audited or reviewed by a second person.

| Check | Result |
|---|---|
| Rust unit tests (`cargo test`) | 16 pass |
| SBF build | succeeds; `build/launch_commitments.so`, 98,728 bytes, SHA-256 `1e8d66705b2ee91c504552fb7e55cf26fb046d54aec26e0aed54e1c48b9e6e4b` |
| Local end-to-end (`sdk/selftest.test.cjs`, LiteSVM, captured deployed DBC bytecode) | 9 pass |
| Codex's `tests/campaign.test.cjs` and `tests/lifecycle.test.cjs` | 12 pass |

These figures are after the 5 October review round; see `REVIEW-RESPONSE.md` for what changed.

Settlement measured: 870-byte legacy transaction, 202,156 to 213,204 compute units across runs (the spread comes from PDA bump searches at a random program address), 29,077,360 lamports of setup budget spent. Full figures are in `selftest-result.json`.

## Commands

From `work/launch-commitments/program`:

```
cargo test --offline --lib
cargo build-sbf --offline --sbf-out-dir build
```

From `work/launch-commitments`:

```
node --test sdk/selftest.test.cjs
```

Toolchain: `solana-cargo-build-sbf 3.1.10`, platform-tools v1.52, rustc 1.89.0, `solana-program =3.0.0`. `Cargo.lock` was copied from the CPI proof so the build resolves offline.

Two build warnings are expected and harmless here: the "two crate types" LTO notice (the `lib` type exists so unit tests run on the host), and the "undefined and not known syscalls" notice, which the CPI proof program also produced.

`build/launch_commitments-keypair.json` is a throwaway address keypair the build tool generates. Do not copy it into `outputs/`. The self-test loads the `.so` at a random address instead.

## Layout

| File | Purpose |
|---|---|
| `src/processor.rs` | The six handlers and all CPI construction |
| `src/dbc_config.rs` | The one supported `PoolConfig` preset, by byte offset |
| `src/state.rs` | Campaign and receipt layouts, phase rules |
| `src/math.rs` | Pro-rata allocation |
| `src/instruction.rs` | Instruction data parsing |
| `src/ids.rs`, `src/error.rs` | Fixed addresses, error codes |
| `../sdk/index.cjs` | Builders, decoders, derivations |
| `../sdk/selftest.test.cjs` | Local end-to-end checks; uses your `runtime/vm.cjs` and `runtime/preset.cjs` read-only |

## Design decisions you should know

- **Two system-owned PDAs.** `vault` holds principal and signs as pool creator and buyer. `budget` pays all settlement rent. Principal never pays rent because the two never mix.
- **No router.** Settlement builds exactly five kinds of CPI with fixed shapes: DBC initialize, DBC transfer creator, Associated Token create (twice), wrapped-SOL sync, DBC `swap2`. No instruction data from the caller is forwarded.
- **Every CPI target is checked before the PDAs sign.** A substituted DBC, Token, Associated Token, Metaplex or System program fails with 6002. This is tested.
- **One account per role across CPIs.** The pool and both DBC vaults passed to the swap are the same accounts DBC just created under its own seed checks, so a settler cannot redirect the buy.
- **Spend check is a delta.** The wrapped-SOL account's balance must be the same after the swap as before the wrap. Someone pre-funding that account cannot block settlement.
- **Creator transfer is verified.** After the transfer the program reads the pool's creator field (offset 104) and requires it to equal the beneficiary.
- **Receipts are closed, not flagged.** Claim, refund and full withdrawal close the receipt and return its rent. A receipt can only be created by Contribute, which is impossible after close time, so a closed receipt cannot be reopened to claim twice. A second claim fails with 6004.
- **Pre-funded addresses do not block creation.** Campaign and receipt creation fall back to allocate-and-assign when the address already holds lamports. This is tested.
- **Claim and refund need the contributor's signature.** Assets only ever move to the signer.

## What the self-test covers

- The SDK's config offsets match the official 1.5.13 decoder field by field.
- Funded and oversubscribed: contributions, a partial withdrawal, a donation that is not counted, settlement, three pro-rata claims, and exact vault and token balances afterwards.
- Timing boundaries at exactly close time and exactly expiry.
- Underfunded round and expired round: exact refunds, no token created.
- Twelve substituted programs or accounts in Settle, each rejected with the expected code, followed by an honest settlement.
- Creation rejections: a real DBC config that breaks the preset, target at the threshold, a non-config account, bad times, zero target, small budget, duplicate campaign.

## Not covered, for your suite

- DAMM v2 migration after settlement, and public trading on the curve.
- Randomised multi-contributor accounting on chain (the Rust unit test does 2,000 rounds off chain only).
- Maximum-length name, symbol and uri through settlement.
- Amounts near u64 limits on chain.
- A config whose first buy returns less than `minTokens` (error 6017).
- Budget exhaustion and top-up.
- Substitution in Claim beyond the two cases tested (wrong destination owner, someone else's receipt).
- Behaviour on a real validator. LiteSVM may differ from a cluster, and Metaplex here is the SDK fixture.

## Unresolved limitations

- **Not audited.** Treat every safety property as a claim until your hostile tests and a review confirm it.
- **Locked lamports.** The setup budget remainder, the vault rent floor, campaign rent, dust and any donations are never returned. There is no close or sweep instruction.
- **One preset.** Curve shape, supply, decimals, threshold and fee recipients are bound by hash but not judged. The app must show them.
- **`minTokens` is the organizer's number.** The program enforces it but does not check it is close to what the curve will return. On a new pool the output is deterministic, so the app should compute and display the expected amount beside it.
- **Hard-coded DBC 0.2.1 shapes.** Discriminators, account orders and two byte offsets (config fields, pool creator) are fixed. If DBC changes them, settlement fails and refunds still work. DBC 0.2.2 is untested.
- **No events.** The program logs nothing of its own. Indexing relies on account state and the campaign counters.
- **Lost keys.** Nobody else can claim or refund for a contributor.
- **Beneficiary is not validated** beyond being non-zero and not the vault. A wrong address makes the creator role unusable.
- **Upgrade authority** exists wherever the program is deployed and is a trust boundary until removed.
