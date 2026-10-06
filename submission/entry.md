# Launch Commitments

**Agree on a Meteora launch. Execute it together—or recover your contribution.**

## Project description

Launch Commitments is a coordination layer for communities that want to fund a token launch before the token exists. A shared wallet makes contributors depend on its operator to launch, distribute tokens or issue refunds. Our prototype encodes those actions in a Solana program.

An organizer publishes a funding target, curve configuration, minimum token output, fee beneficiary and deadlines. Contributors deposit SOL into a campaign vault and can withdraw before funding closes. If the target is met, anyone can execute one transaction that creates the token, creates its Meteora DBC pool and makes the agreed collective first purchase. Contributors claim proportional tokens and excess SOL. If funding falls short—or a funded launch never executes before expiry—each contributor can recover their recorded principal without the organizer or website.

Meteora DBC is the issuance and initial pricing mechanism, rather than an incidental integration. The same public campaign subsequently graduated into DAMM v2, where a 1,000-token sale was confirmed. The program separates contributed principal from organizer-funded setup costs, verifies the committed DBC configuration, and rejects a launch whose initial purchase falls below the published minimum. Atomic execution means a failed step rolls back the transaction.

The public devnet proof records successful launch and allocation, underfunded refunds, and funded-expiry refunds with the app server switched off. The repository includes the Rust program, transaction-building SDK, application, tests, transaction receipts and standalone recovery tool. All recorded activity is from developer-controlled wallets using test tokens.

Shared launches and escrow have precedents. Our contribution is this specific DBC execution-or-refund workflow, not a claim to have invented pooled launches. The deployment retains an upgrade authority and has not received an independent audit. No mainnet usage, external customers or new asset class is claimed. Next steps are outside-user validation and further security review before considering a narrowly scoped mainnet pilot.

## Links

- Interactive devnet app: https://mahfuz67.github.io/launch-commitments/app/
- Guided two-minute walkthrough: https://mahfuz67.github.io/launch-commitments/walkthrough/

- Source: https://github.com/mahfuz67/launch-commitments
- Public transaction proof: https://mahfuz67.github.io/launch-commitments/
- Program: https://explorer.solana.com/address/4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD?cluster=devnet
- Comparison: https://github.com/mahfuz67/launch-commitments/blob/main/COMPARISON.md
- Reproduction: https://github.com/mahfuz67/launch-commitments/blob/main/PUBLIC-DEMO.md

## Team

Mahfuz Bello — builder. Development and internal review assisted by Codex and Claude Code. This is not an external security audit.

## Submission status

Prepared, not submitted. The listing was open on 6 October 2026. Its entry form requires sign-in, so account-specific fields and declarations have not yet been verified. The listing's criteria are qualitative; generic skill scoring percentages are not the sponsor's scoring rubric. Migration evidence is complete. The hosted app is available for devnet use. A real Phantom connection has been observed; the signed end-to-end wallet test remains pending. Do not represent that unfinished test as complete.
