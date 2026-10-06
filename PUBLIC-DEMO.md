# Public devnet demonstration

This release uses Solana devnet test tokens. It is a developer-run demonstration, not customer usage, revenue or a mainnet launch.

The program is deployed at [4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD](https://explorer.solana.com/address/4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD?cluster=devnet). The deployed bytecode is checked against SHA-256 `1e8d66705b2ee91c504552fb7e55cf26fb046d54aec26e0aed54e1c48b9e6e4b`.

**All three public devnet cases passed on 5 October 2026:** successful launch and proportional claims; underfunded refunds; and refunds after a funded campaign expired without launching. Standalone recovery ran with the app server stopped. See [the evidence page](https://mahfuz67.github.io/launch-commitments/) and [transaction manifest](evidence/public-devnet-proof.json).

The successful round collected 0.03 test SOL against a 0.02 target. The underfunded round refunded all 0.007 test SOL. The expired round refunded all 0.022 test SOL. These are developer-operated tests, not external usage. On 6 October 2026, a follow-up run took the same token through a DBC buy, graduation, migration and a 1,000-token sale on DAMM v2. See [migration evidence](evidence/public-migration.json). The original proof manifest remains the historical launch/refund record.

## Hosted app

The static devnet app is published at https://mahfuz67.github.io/launch-commitments/app/. It prepares transactions in the browser, checks the pinned program bytecode and devnet genesis, and sends wallet-signed transactions directly to the public devnet RPC. It requires no local server. The provider can rate-limit requests; refresh and inspect any displayed transaction signature before retrying. Use Phantom or another compatible Wallet Standard wallet set to devnet.

The guided tour at https://mahfuz67.github.io/launch-commitments/walkthrough/ opens actual recorded campaigns and evidence without a wallet. It is not a video of new transactions.

## Run the local backend variant against public devnet

Install Node.js 22.12 or newer, then run these commands in the source directory:

```sh
npm ci --ignore-scripts
DEVNET_PROGRAM_ID=4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD npm run api:devnet
```

In a second terminal:

```sh
npm run app:devnet
```

Open http://127.0.0.1:5181. The website runs locally; its accounts and transactions are on public devnet. This local variant uses the optional RPC adapter server; the hosted version above talks directly to devnet. A compatible Wallet Standard wallet must be set to devnet. Only use test SOL.

The deployment retains an upgrade authority. That authority can replace the program, so the commitment rules are not an assurance against a malicious upgrade. The app displays this trust boundary and rejects code that differs from this reviewed build. The program and its dependencies have not received an independent security audit.

## Independently inspect deployment

```sh
node verify-deployment.cjs
```

This sends no transactions. It checks the devnet genesis, the loader-owned program data, the exact deployed bytecode and upgrade authority. It records `deployment.json`.

## Recover without the app

```sh
node recover.cjs --rpc https://api.devnet.solana.com \
  --program 4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD \
  --campaign CAMPAIGN_ADDRESS --wallet YOUR_PUBLIC_ADDRESS
```

This reads your receipt and the current deadline/status directly from chain. Add `--action refund` to prepare an eligible refund. To send it, use `--keypair /path/to/your/devnet-keypair.json --send`. Do not paste a private key into a website or chat. The app server and organizer are not needed. Network fees remain payable by the transaction signer.

## Scope

Before settlement, contributions can execute the agreed first DBC purchase or be recovered under the published rules. After successful settlement, contributors hold tokens exposed to trading losses. Refunds are not a price guarantee. Organizer-paid setup costs, account rent, donations and rounding dust have separate treatment described in README.md.

## Reproduce the three-campaign proof

Use your own dedicated, funded devnet test key, supplied via `DEPLOY_KEYPAIR`; no wallet keys are included in this repository. The read-only plan reports the test SOL budget. Start the backend as above, then:

```sh
node tests/public-devnet.cjs --with-expiry --minutes 3
node tests/public-devnet.cjs --phase launch --with-expiry --minutes 3 --execute
```

Stop the backend after the launch phase finishes, then run:

```sh
node tests/public-devnet.cjs --phase refund-recovery --execute
node tests/public-devnet.cjs --phase expiry-recovery --execute
node tests/public-devnet.cjs --phase verify
```

The expiry phase waits for the real chain deadline. Evidence is recorded after each transaction; a completed phase refuses to execute twice. Run `--help` for recovery after an interrupted run. Locally generated wallets remain in `private/` and must never be published. The published `evidence/public-devnet-proof.json` contains public addresses, transaction receipts and checks only.
