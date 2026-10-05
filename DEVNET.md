# Public-cluster backend

`runtime/devnet-server.cjs` serves the same API as `runtime/server.cjs`, reading every account from an RPC node. Wallet transactions are prepared unsigned, signed in the browser, then simulated and sent by the server.

## Status

**Deployed on public devnet on 5 October 2026.** See [PUBLIC-DEMO.md](PUBLIC-DEMO.md) for the public execution evidence and deployment manifest. The measurements below are explicitly from the separate local validator.

**Tested over HTTP against a local Agave 3.1.10 validator** with `node tests/devnet-api.cjs`. One run passed, covering:

- create (config and campaign in one transaction), contribute, partial withdraw
- launch by a third wallet after a real one-minute funding window
- two claims, a DBC buy, graduation, migration to DAMM v2, a DAMM v2 sale
- an underfunded campaign's refund
- the refusal cases listed under "What the test checks"

| Measured on the local validator | Value |
|---|---|
| Create transaction, two signature slots | 883 bytes |
| Creation cost paid by the wallet | 113,930,000 lamports, equal to the disclosed total |
| Settle | 870 bytes; about 250,000 compute units simulated |
| Migration, three signature slots | 1,139 bytes; about 167,000 compute units simulated |

Settlement used about 202,000 compute units in LiteSVM and about 250,000 on the validator. The SDK requests 400,000.

## Start

From `work/launch-commitments`.

Public devnet:

```
DEVNET_PROGRAM_ID=<deployed program address> node runtime/devnet-server.cjs
```

Local validator (integration test only):

```
LAUNCH_NETWORK=validator LAUNCH_RPC_URL=http://127.0.0.1:18899 \
DEVNET_PROGRAM_ID=4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD node runtime/devnet-server.cjs
```

Run the test (it starts and stops its own server processes):

```
node tests/devnet-api.cjs
```

| Variable | Meaning |
|---|---|
| `DEVNET_PROGRAM_ID` | Required. The launch-commitments program address on the target cluster |
| `LAUNCH_RPC_URL` | Defaults to `https://api.devnet.solana.com`. Only its host is ever shown in responses or logs |
| `LAUNCH_NETWORK` | `devnet` (default) or `validator`. `validator` is refused unless the RPC URL is loopback |
| `LAUNCH_API_PORT` | Defaults to 19190. The test uses this to start a second instance |

The server binds `127.0.0.1` only and accepts browser origins `http://127.0.0.1:5181` and `http://localhost:5181`.

## Safety properties

- **No wallet keys.** The server never holds or uses a user key and never signs as a wallet.
- **Throwaway co-signers only.** Create needs the new DBC config address to sign; migration needs two position NFT addresses to sign. The server generates those keypairs per request, adds their partial signatures and discards them. They hold no funds.
- **Cluster check before anything is served.** In `devnet` mode the node's genesis hash must be `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. In `validator` mode it must not be mainnet, devnet or testnet. The program address must be executable, its loader-owned data must match the pinned build, and its upgrade authority is disclosed. Until this passes every route returns 503.
- **No time controls.** `/api/advance` returns 404. Time comes from `getSlot` and `getBlockTime`.
- **Honest confirmation.** A sent transaction is reported `confirmed` only when the cluster reports it confirmed with no error. A landed failure is an error response. If neither is seen within 60 seconds the response is HTTP 202 with `status: "unknown"`.
- **Simulation first.** Every send is simulated with signature verification. A failing simulation is never broadcast.

## Routes

| Route | Notes |
|---|---|
| `GET /api/state?wallet=` | Campaigns found with `getProgramAccounts` filtered by account size. `wallet` is optional |
| `GET /api/environment` | Network, RPC host, genesis hash, program, chain time, preset summary |
| `POST /api/prepare` | Actions: `create`, `contribute`, `withdraw`, `settle`, `claim`, `refund`, `migrate`, `trade` |
| `POST /api/send` | Any fully signed transaction up to 1,232 bytes |
| `POST /api/faucet` | Local validator only. In devnet mode it returns an error pointing to a devnet faucet |

### Differences from the local server

- **State** adds `organizer`, `uri`, `presetOk`, `leftoverReceiver`, `tokensBought`, `tokensClaimed` and `receiptCount`. Config-derived fields are `null` if the config account cannot be read.
- **Prepare** adds `bytes`, `signaturesRequired`, `blockhash`, `lastValidBlockHeight`, and for create `createdConfig` and `costs`. `quoteDetails` for trades includes `venue`.
- **Create and migrate transactions arrive partially signed.** The wallet must add its signature without dropping the existing ones.
- **Send** adds `status`. `logs` and `compute` come from the pre-send simulation, not the landed transaction.
- **Withdraw** takes an optional `amount`; without it the whole contribution is withdrawn.
- **Create** takes an optional `uri` (https, up to 200 bytes). Without it a placeholder link is stored on chain.

## Create flow

One transaction creates a fresh DBC config from `runtime/preset.cjs` and the campaign bound to it. The browser wallet pays for everything and becomes fee recipient, leftover receiver and beneficiary. The server funds nothing.

- Settlement window: 10 minutes after funding closes.
- Setup budget: 0.1 SOL.
- The response's `costs` lists the budget, config rent, campaign rent, vault rent floor and network fee. None is recoverable in this version.
- `minTokens` is the preset quote for the target with 1 basis point of slippage.

## What the test checks

- Validator mode refuses to start with a public RPC URL; a missing program ID refuses to start.
- Devnet mode pointed at the local validator returns 503 on state and prepare.
- Disallowed origin gets 403; both allowed origins work.
- The create transaction has an empty wallet signature slot and a filled config slot.
- Send refuses: a missing wallet signature, a wrong signature, an oversized payload, junk bytes.
- Program refusals are named: launching early (`FundingStillOpen`), refunding early (`RefundNotAvailable`), contributing late (`FundingClosed`), a second claim, migrating before the curve completes.
- State values match what was sent: totals, positions, allocation arithmetic, token balances, venue changes.

## Constraints and open items

- **Devnet dependencies were inspected read-only on 5 October 2026.** DBC, DAMM v2, Metaplex, the migration config and funded pool authority exist. Fourteen tests pass locally with captured devnet binaries. The public launch/recovery proof is documented separately in PUBLIC-DEMO.md; graduation and migration remain local-only tests.
- **Public RPC limits.** `getProgramAccounts` and bursts of requests may be throttled on the default endpoint. State makes one batched account read per 25 campaigns after the listing call.
- **Blockhash expiry.** A prepared transaction must be signed and sent before its blockhash expires, roughly a minute.
- **Open relay on localhost.** `/api/send` forwards any signed transaction to the configured cluster. It is reachable only from this machine and the two allowed origins.
- **One process, no persistence.** Nothing is stored; all state is read from chain on each request.
- **The local test tops up DBC's pool authority from the validator faucet** before migrating. On a public cluster that account must already be funded.

## Latest Codex verification

On 5 October 2026, read-only devnet inspection confirmed DBC, DAMM v2, Metaplex, the fixed-tier migration configuration and a funded DBC pool authority. Captured binaries differ from the original fixtures; fourteen financial/lifecycle/recovery tests pass locally against those actual devnet binaries. See devnet-preflight.json and evidence/devnet-bytecode-tests.log. This was a read-only preflight before the subsequent public deployment documented in PUBLIC-DEMO.md.

Wallet Standard browser signing now works in an automated test with a simulated provider against the local validator. A real extension remains to be tested. Run npm run app:devnet to use port 5181 with this backend.

Public devnet uses the same constrained configuration with SOL curve amounts scaled by 0.01 to conserve test funds: default target 0.02 test SOL, graduation threshold 0.104132267 test SOL. Local demonstration/validator mode retains target 2 and threshold 10.413226765. Both scales pass the full lifecycle tests.

Deployment: node deploy-devnet.cjs writes a read-only plan and refuses any cluster other than devnet. DEPLOY_KEYPAIR and PROGRAM_KEYPAIR may point to explicitly selected test key files; defaults are the fresh private/devnet-payer.json and generated program/build/launch_commitments-keypair.json. Add --execute only when funded. The helper pins the reviewed binary hash, refuses an existing program address, retains and discloses the test payer as upgrade authority, and verifies landed bytes. It never supports mainnet. Generated private keys are intentionally absent from the deliverable.

To reproduce the local RPC tests: npm run validator (requires solana-test-validator 3.1.10), then node tests/validator.cjs and node tests/devnet-api.cjs. Use npm run validator -- --reset only to discard this project's test ledger.
