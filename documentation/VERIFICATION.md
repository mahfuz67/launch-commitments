# Verification and evidence

Moved from the repository README. Run commands from the repository root.

## Checks

```sh
npm run test:core
cd program
cargo test --offline --lib
cargo build-sbf --offline --sbf-out-dir build
```

The checked build has **16 Rust tests and 51 Node tests** passing; the latest recorded Node run is [evidence/hosted-core-tests.log](../evidence/hosted-core-tests.log). The Node suite includes checks of deployment bytecode, loader ownership and upgrade-authority disclosure, and of parity between the hosted browser modules and the SDK. Tests cover account/program substitution, immutable-config changes, exact deadline boundaries, rollback, repeated claims, prefunded addresses, donation griefing, rounding, randomized accounting, independent recovery, co-signature preservation, DBC trading, migration, locked liquidity and DAMM trading. The latter lifecycle is tested at both local and smaller devnet scales.

## Recorded evidence

Generated reports are in [evidence/reports](../evidence/reports) and screenshots in [evidence/screenshots](../evidence/screenshots). The scripts that produce them write there directly.

| Record | Written by | What it shows |
|---|---|---|
| [browser-result.json](../evidence/reports/browser-result.json) | `tests/browser.cjs` | Complete local browser lifecycle, including withdrawal and failed-launch refund; desktop and narrow dark-mode inspection. |
| [wallet-browser-result.json](../evidence/reports/wallet-browser-result.json), [wallet-browser.png](../evidence/screenshots/wallet-browser.png) | `tests/wallet-browser.cjs` | Wallet Standard protocol path against a real local validator, using a simulated provider. |
| [validator-result.json](../evidence/reports/validator-result.json) | `tests/validator.cjs` | Normal RPC and block-time launch/claim/refund execution on Agave 3.1.10. |
| [devnet-preflight.json](../evidence/reports/devnet-preflight.json) | `tests/devnet-preflight.cjs` | Read-only capture of actual devnet DBC, DAMM and Metaplex programs, migration config and authority funding. These binaries differ from the original fixtures. Fourteen financial/lifecycle/recovery tests also pass locally against those captured devnet binaries. |
| [deployment-plan.json](../evidence/reports/deployment-plan.json) | `deploy-devnet.cjs` | The plan recorded before the devnet deployment; `verify-deployment.cjs` reads it and writes the root `deployment.json` manifest. |
| [dependency-audit.json](../evidence/reports/dependency-audit.json) | `npm audit --json` | The follow-up dependency audit discussed in [DEPENDENCIES.md](DEPENDENCIES.md). |
| [public-devnet-proof.json](../evidence/public-devnet-proof.json), [public-migration.json](../evidence/public-migration.json) | `tests/public-devnet.cjs` (public copy staged by `tools/stage-release.py`), `tests/public-migration.cjs` | Public devnet launch, claims, both refund paths, graduation, DAMM v2 migration and sale. See [PUBLIC-DEMO.md](PUBLIC-DEMO.md). |

`tests/devnet-api.cjs` runs the full RPC backend lifecycle and rejection cases. It requires a local validator; its results are in `evidence/devnet-api-result.log` in the packaged deliverable. `tests/browser.cjs` also writes `browser-desktop.png` and `browser-mobile.png` to `evidence/screenshots/`; `.gitignore` keeps those two out of the repository. `sdk/selftest.test.cjs` rewrites `program/selftest-result.json` on each run.

## Measurements

Settlement is an 870-byte transaction. The separate-validator RPC test measured about 250,000 simulated compute units against a 400,000-unit limit. Config plus campaign creation is 883 bytes with two signature slots; migration is 1,139 bytes with three. Figures vary by addresses and dependency builds.
