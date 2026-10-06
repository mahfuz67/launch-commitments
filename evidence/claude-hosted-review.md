# Hosted devnet adapter — review and integration note (6 October 2026)

Claude Code (claude-opus-5-5) wrote the browser adapter and its Node tests. Codex integrated it, built the hosted bundle and ran every browser check. This is an engineering note, not a security audit.

## What was added

| File | Role |
| --- | --- |
| `app/devnet-api.mjs` | Entry point. `createDevnetApi(config)` returns `api(path, data)` with the same call shape, JSON and error bodies as the app's `/api` fetch helper. Loads the core on first call. |
| `app/devnet-core.mjs` | Port of `runtime/devnet-server.cjs` without the HTTP layer: state, environment, prepare (create, contribute, withdraw, settle, claim, refund, trade, migrate), send, faucet (validator only). |
| `app/lc-browser.mjs` | ES-module port of `sdk/index.cjs`. Only `hashConfig` differs: it is async and uses WebCrypto. |
| `app/deployment-browser.mjs` | Port of `runtime/deployment-info.cjs` with WebCrypto SHA-256. |
| `app/sha256-browser.mjs`, `app/buffer-global.mjs` | WebCrypto hash that fails closed outside a secure context; Buffer global set before the Meteora and SPL packages load. |
| `tests/hosted-parity.test.cjs` (10 tests) | Holds each port to its Node original. |
| `tests/hosted-api.test.cjs` (13 tests) | Drives the adapter against the real program bytecode. |
| `tests/hosted-rpc.cjs` | Test-only in-memory JSON-RPC node over the LiteSVM bank in `runtime/vm.cjs`. |

Nothing existing was edited by Claude. Codex made the `main.jsx`, `vite.config.mjs` and `package.json` changes.

## Why ports instead of importing the SDK

`sdk/index.cjs` and `runtime/deployment-info.cjs` require `node:crypto`. In a probe build Vite 8 replaced it with an empty stub and warned; in the Vite dev server the CommonJS file was served unconverted, so the browser would fail on `require`. The ports contain no Node built-ins. A source test forbids `node:`, `require(`, storage, `location`, stored-key APIs and any network primitive other than the one RPC transport.

## Guards carried over

- Genesis hash must be devnet before anything else is asked of the node. Validator mode needs a loopback URL and a non-public genesis.
- Loader ownership, program-data layout, exact size and SHA-256 of the deployed bytecode are checked on every `prepare` and `send`, and on reads unless a cache is configured.
- Campaign, receipt and config accounts are checked for owner and size. The config hash and preset are recomputed for display.
- The 1232-byte packet limit, the missing-signature check and simulation with signature verification all run before broadcast.
- Program address and RPC URL come only from `createDevnetApi` arguments. Unset or empty values fall back to the pinned deployment, which a test ties to `deployment.json`.
- The adapter holds no wallet key. It generates only the co-signer address keys the server also generated: one for the new DBC config, two (inside the Meteora SDK) for the DAMM v2 position mints.

## Confirmation behaviour

`send` returns `confirmed` or `finalized` only when the cluster reports that status for the signature. A landed error is thrown as `failed`. No answer within 60 seconds resolves as `unknown`. The adapter broadcasts once and never resubmits.

Deliberate differences from the server:

- Every failure before the broadcast call carries `status: 'rejected'`, including an unreachable RPC or a failed cluster check. The server returned no status there, which the app showed as "unknown".
- A JSON-RPC error reply to `sendTransaction` is reported as `rejected`.
- A lost reply to `sendTransaction` is not treated as failure. The adapter polls the locally computed signature and reports what the cluster says.
- Reads and `prepare` give up after 30 seconds. `send` is never abandoned.
- The `note` text says "this page" instead of "this server".

## Verification

Run by Claude:

- The 23 new tests pass: 10 parity, 13 adapter.
- Parity covers byte-identical instructions and transactions over random inputs, identical decoding of real accounts, 600 mutated configs judged identically, 20 deployment cases accepted or refused identically, and identical argument errors. A deliberate one-flag change in a scratch copy of the port was caught.
- The lifecycle test runs the adapter and the real `runtime/devnet-server.cjs` on the same chain and requires identical status and JSON for more than 70 requests, from create through DAMM v2 sale and refund.
- Fault tests cover unknown, landed-and-failed, lost reply (delivered and not delivered), node refusal, failed simulation, and bytecode changed between prepare and send.

Reported by Codex, not re-run by Claude:

- All 51 tests pass (`evidence/hosted-core-tests.log`).
- `npm run build:hosted` passes. The core is a separate lazy chunk of 619 kB, 143 kB gzipped (`evidence/hosted-build.log`).
- A real browser loaded live devnet campaigns, including a DAMM v2 venue.

Not done by Claude: no browser run, no build of the adapter bundle, no contact with public devnet, no broadcast, no funded operation.

## Integration as wired by Codex

`main.jsx` uses the adapter when `VITE_DIRECT_RPC=true`, with `stateDeploymentCacheMs: 30000`. Otherwise it uses the existing backend fetch. `build:hosted` sets the base path to `/launch-commitments/app/`.

The 30-second cache means polled reads can show state for up to 30 seconds after a program upgrade before refusing. `prepare` and `send` ignore the cache. Set it to 0 to match the server's check-on-every-request behaviour.

## Limitations and risks

- **One RPC node is trusted.** Genesis, bytecode and account data all come from the configured node. A node that lies can pass the guards. The wallet's own simulation is the only independent check. The server had the same model, but each visitor's browser now depends on the public endpoint's rate limits and `getProgramAccounts` availability.
- **The bytecode check is not atomic with landing.** An upgrade between the check and the transaction landing is not detected, as with the server.
- **Receipt contract in `main.jsx`.** Any status other than `unknown`, `failed` or `rejected` renders as "Confirmed transaction". The adapter emits only the server's status set. A new status such as `expired` would be shown as confirmed unless the app changes first.
- **Ports can drift.** A hash test fails when `sdk/index.cjs`, `deployment-info.cjs`, `preset.cjs` or `devnet-server.cjs` changes. Carrying the change into the port and updating the hash is manual.
- **Test double.** `tests/hosted-rpc.cjs` runs real bytecode but is not a validator. Fees, commitment levels, blockhash expiry and rate limiting are approximated.
- **RPC URL is public.** Any key in a custom RPC URL ships in the static bundle.
- **Secure context required.** Without WebCrypto the hash checks refuse. GitHub Pages and loopback are fine.
- **Web Workers.** `@meteora-ag/cp-amm-sdk` deep-imports an Anchor CommonJS file that falls back to Node `util` when `window` is undefined. The core must stay on the main thread.
- **Validator mode and faucet** exist in the core. The hosted build cannot reach them because `main.jsx` passes fixed configuration.

## Remaining concerns worth a decision

1. Real wallet-extension signing through the adapter on devnet is unverified by Claude. The adapter's part of that path is tested only with in-process test keys.
2. Public devnet graduation and DAMM v2 migration through the adapter have been executed only against LiteSVM.
3. `.gitignore` matches `claude-*.md`, and `tools/stage-release.py` does not list this note or the new evidence logs. Publishing them needs an explicit change.
4. `PUBLIC-DEMO.md` and `docs/index.html` still say the app runs locally and is not hosted.
5. The differential test opens loopback sockets and spawns `devnet-server.cjs`. A CI runner without loopback networking would fail it.
