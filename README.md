# Launch commitments

A community funds a token launch on published terms. Once the window closes, anyone can execute the agreed DBC launch and first purchase in one transaction. Contributors claim proportional tokens and excess SOL. If the launch fails to fund or expires without executing, each contributor recovers their recorded principal without the organizer or our website.

**Working end-to-end implementation; not yet a completed bounty submission.** The program, SDK, browser app, independent recovery CLI and RPC backend are implemented. Local execution, a separate Agave validator and browser flows pass. The reviewed program is deployed on public devnet; public launch, proportional claims, underfunded refunds, funded-expiry refunds, DBC graduation, DAMM v2 migration and a DAMM sale have passed. [Inspect the public proof](https://mahfuz67.github.io/launch-commitments/). No mainnet deployment, audit, external users, organic volume or customer-demand validation is claimed.

A captioned local demonstration is in [demo/index.html](demo/index.html). It records actual application execution with test funds.

## Try it

Use Node 22.12+ (verified here with Node 25.2.1). From this directory:

```sh
npm ci --ignore-scripts
npm run local
```

In a second terminal:

```sh
npm run app
```

Open http://127.0.0.1:5180. Add test SOL, create a campaign, and switch between the organizer and two contributor wallets. Every transaction requires its own review and signing click. Expand **Local rehearsal controls** to reach close or expiry. After claiming, the same screen supports DBC trading, migration and DAMM trading.

This mode executes real programs in LiteSVM with synthetic accounts. The server holds no browser wallet keys. Test wallets reset on page reload; bank state resets on server restart. These wallets must never receive real funds.

For the RPC-backed app, see [DEVNET.md](DEVNET.md). Start its API, then `npm run app:devnet`, and open http://127.0.0.1:5181. It uses Wallet Standard signing and real chain time. It has no synthetic clock controls. The browser connection was tested with a simulated provider against the local validator; no specific wallet extension compatibility claim is made yet.

## What is enforced

1. At creation, the program commits to the organizer, beneficiary, token metadata, target, minimum token output, close time, expiry and exact DBC configuration hash.
2. Contributions enter a principal vault. A separate organizer-funded budget pays settlement account rent. Contributors may withdraw before close.
3. At close, an adequately funded campaign is permissionlessly settleable until expiry. Settlement creates the token and pool, transfers creator rights to the published beneficiary, and spends exactly the target on the first DBC purchase. All operations roll back if any fails.
4. Claims pay `floor(contribution × tokensBought / finalTotal)` tokens and `floor(contribution × (finalTotal − target) / finalTotal)` lamports. Closing the receipt prevents a repeat claim. Sub-unit rounding dust remains locked.
5. An underfunded campaign is refundable at close; an unexecuted funded campaign is refundable at expiry. Refund does not invoke DBC.
6. The supported constraints require a fixed 1% DBC fee, ordinary SPL/SOL, immutable metadata, fixed supply, no extraction fee at migration and 100% permanently locked migrated liquidity. The unallocated-supply allowance is at most 0.1%; the app preset requests zero leftover. Curve shape, valuation, beneficiary and fee recipients remain economic choices, not certifications of asset quality.

The app uses one economic preset: 1 billion tokens, 6 decimals, creator fee share 100%, creator locked-liquidity share 100%, no requested leftover. The local demonstration has a 2 SOL default target and approximately 10.4132 SOL graduation threshold. Public **devnet test mode scales the curve's SOL amounts by 0.01**: default target 0.02 test SOL and approximately 0.104132267 test SOL graduation threshold. These are test configurations, not valuations or investment recommendations.

The shared first purchase can obtain a lower average price than later public buyers. This is disclosed; there is no claim of equal prices, identity fairness or protection from trading losses. Late large contributors can dilute earlier contributors' token shares, with excess refunded proportionally.

## Verification

```sh
npm run test:core
cd program
cargo test --offline --lib
cargo build-sbf --offline --sbf-out-dir build
```

The checked build has **16 Rust tests and 28 Node tests** passing. The four additional Node tests verify deployment bytecode, loader ownership and upgrade-authority disclosure. Tests cover account/program substitution, immutable-config changes, exact deadline boundaries, rollback, repeated claims, prefunded addresses, donation griefing, rounding, randomized accounting, independent recovery, co-signature preservation, DBC trading, migration, locked liquidity and DAMM trading. The latter lifecycle is tested at both local and smaller devnet scales.

Additional evidence:

- [browser-result.json](browser-result.json): complete local browser lifecycle, including withdrawal and failed-launch refund; desktop and narrow dark-mode inspection.
- [wallet-browser-result.json](wallet-browser-result.json): Wallet Standard protocol path against a real local validator, using a simulated provider.
- [validator-result.json](validator-result.json): normal RPC and block-time launch/claim/refund execution on Agave 3.1.10.
- [devnet-preflight.json](devnet-preflight.json): read-only capture of actual devnet DBC, DAMM and Metaplex programs, migration config and authority funding. These binaries differ from the original fixtures. Fourteen financial/lifecycle/recovery tests also pass locally against those captured devnet binaries.
- `tests/devnet-api.cjs`: the full RPC backend lifecycle and rejection cases. Requires a local validator; results are in `evidence/devnet-api-result.log` in the packaged deliverable.

Settlement is an 870-byte transaction. The separate-validator RPC test measured about 250,000 simulated compute units against a 400,000-unit limit. Config plus campaign creation is 883 bytes with two signature slots; migration is 1,139 bytes with three. Figures vary by addresses and dependency builds.

## Recovery without the website

```sh
node recover.cjs --help
node recover.cjs --rpc https://api.devnet.solana.com --program PROGRAM_ADDRESS --campaign CAMPAIGN_ADDRESS --wallet YOUR_PUBLIC_ADDRESS
```

Add `--action refund`, `claim`, `withdraw` or `settle` to prepare a transaction. Sending requires `--keypair /path/to/your/test-keypair.json --send`. The CLI verifies devnet's genesis hash before sending, simulates first and checks confirmation. Never paste a secret key into chat. The app can export terms and public recovery addresses; it never exports your key.

## Architecture and limits

- `program/`: native Rust Solana program; fixed CPI shapes, no arbitrary-instruction router.
- `sdk/`: account decoders, address derivation and unsigned builders; [INTERFACE.md](INTERFACE.md) is the wire contract.
- `app/`: React interface, Wallet Standard integration and explicit transaction review.
- `runtime/server.cjs`: temporary local rehearsal bank.
- `runtime/devnet-server.cjs`: stateless RPC adapter; no wallet keys, cluster guard, simulation and honest confirmation status.
- `recover.cjs`: server-independent recovery.

The program is not audited. Setup-budget remainder, campaign/vault rent, dust and donations remain locked. Lost contributor keys cannot be recovered by an administrator. Program upgrade authority is a trust boundary wherever deployed. Dependency inspection still reports 14 affected packages including transitive propagation; see [DEPENDENCIES.md](DEPENDENCIES.md). External wallet extension testing, independent review and real demand evidence remain release work.

The SDK interface and captured bytecode are version-sensitive. Changes upstream can prevent settlement; the separate expiry-refund path remains available. The two-agent review found and fixed an unsynchronized wrapped-SOL donation denial of service and an excessive-leftover-supply configuration gap. Passing tests do not turn that review into an audit.

See [PUBLIC-DEMO.md](PUBLIC-DEMO.md) for public deployment and reproduction, [COMPARISON.md](COMPARISON.md) for existing alternatives, [PRODUCT.md](PRODUCT.md) for the user problem and competition, and [SUBMISSION.md](SUBMISSION.md) for the current bounty case and unfinished submission requirements.
