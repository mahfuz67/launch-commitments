# Launch Commitments

A community funds a token launch on published terms. Once the window closes, anyone can execute the agreed Meteora DBC launch and first purchase in one transaction. Contributors claim proportional tokens and excess SOL. If the launch fails to fund or expires without executing, each contributor recovers their recorded principal without the organizer or our website.

**Working end-to-end devnet prototype; not yet a completed bounty submission.** The program, SDK, browser app, recovery CLI and RPC backend are implemented, and the reviewed program is deployed on public devnet. No mainnet deployment, audit, external users, organic volume or customer-demand validation is claimed.

## See it

| | |
|---|---|
| Live devnet app | https://mahfuz67.github.io/launch-commitments/app/ |
| Guided walkthrough, no wallet needed | https://mahfuz67.github.io/launch-commitments/walkthrough/ |
| Public transaction proof | https://mahfuz67.github.io/launch-commitments/ |
| Deployed program | [4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD](https://explorer.solana.com/address/4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD?cluster=devnet) |
| Captioned local demonstration | [demo/index.html](demo/index.html) |

The live app prepares transactions in the browser and sends wallet-signed transactions directly to the public devnet RPC. Use Phantom or another Wallet Standard wallet set to devnet, with test SOL only.

Public devnet runs passed launch, proportional claims, underfunded refunds, funded-expiry refunds, DBC graduation, DAMM v2 migration and a DAMM sale. Every wallet in them is developer-operated. The transaction manifests are [evidence/public-devnet-proof.json](evidence/public-devnet-proof.json) and [evidence/public-migration.json](evidence/public-migration.json); [documentation/PUBLIC-DEMO.md](documentation/PUBLIC-DEMO.md) explains how to reproduce them.

## Quickstart

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

To run the app against public devnet through the local RPC adapter, follow [documentation/PUBLIC-DEMO.md](documentation/PUBLIC-DEMO.md). To check the build:

```sh
npm run test:core
cd program && cargo test --locked --lib
```

[documentation/VERIFICATION.md](documentation/VERIFICATION.md) lists what the tests cover and the recorded evidence. To recover a contribution with no app or server, run `node recover.cjs --help`; see [documentation/RECOVERY.md](documentation/RECOVERY.md).

## Architecture

- `program/`: native Rust Solana program; fixed CPI shapes, no arbitrary-instruction router. `program/build/` holds the deployed bytecode the tests check.
- `sdk/`: account decoders, address derivation and unsigned builders; [INTERFACE.md](INTERFACE.md) is the wire contract.
- `app/`: React interface, Wallet Standard integration and explicit transaction review.
- `runtime/server.cjs`: temporary local rehearsal bank.
- `runtime/devnet-server.cjs`: stateless RPC adapter; no wallet keys, cluster guard, simulation and honest confirmation status.
- `recover.cjs`: server-independent recovery.
- `tests/`, `fixtures/`, `fixtures-devnet/`: test suites and the captured DBC, DAMM v2 and Metaplex binaries they run against.
- `evidence/`: logs, reviews and transaction manifests, with generated reports in `evidence/reports/` and screenshots in `evidence/screenshots/`.
- `docs/`: the published GitHub Pages site. `documentation/` holds the written guides.

The program commits at creation to the organizer, beneficiary, token metadata, target, minimum token output, deadlines and exact DBC configuration hash. Contributions sit in a principal vault, separate from the organizer-funded setup budget. Settlement creates the token and pool and spends exactly the target on the first DBC purchase, or rolls back entirely. Refunds do not invoke DBC. [documentation/MECHANISM.md](documentation/MECHANISM.md) has the full rules, claim arithmetic and app preset.

## Limitations

- The program is not audited. It was reviewed only by the two agents that built it.
- The devnet deployment retains an upgrade authority, which can replace the program. The rules protect against the organizer and the website, not against that key holder.
- Setup-budget remainder, campaign and vault rent, rounding dust and donations remain locked. Lost contributor keys cannot be recovered by an administrator.
- After settlement, contributors hold tokens exposed to trading losses. Refunds are not a price guarantee, and the shared first purchase can obtain a lower average price than later public buyers.
- The DBC and Metaplex instruction layouts are hard-coded. Upstream changes can prevent settlement; the expiry-refund path does not depend on them.
- Dependency inspection still reports 14 affected packages, including transitive propagation; see [documentation/DEPENDENCIES.md](documentation/DEPENDENCIES.md).
- The automated browser wallet test uses a simulated Wallet Standard provider. External wallet extension testing, independent review and real demand evidence remain release work.

## Documentation

[documentation/](documentation/README.md) indexes the deeper guides: [mechanism](documentation/MECHANISM.md), [verification](documentation/VERIFICATION.md), [recovery](documentation/RECOVERY.md), [public devnet demonstration](documentation/PUBLIC-DEMO.md), [RPC backend](documentation/DEVNET.md), [comparison with alternatives](documentation/COMPARISON.md), [product evidence](documentation/PRODUCT.md), [bounty submission draft](documentation/SUBMISSION.md) and [dependency status](documentation/DEPENDENCIES.md).

Original source is MIT licensed; see [LICENSE](LICENSE) and [THIRD_PARTY.md](THIRD_PARTY.md) for bundled third-party material.
