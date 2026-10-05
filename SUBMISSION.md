# Bounty submission draft — not submitted

## One sentence

Launch commitments lets a community fund a Meteora DBC launch under published, program-enforced terms, then receive its proportional allocation or recover principal without depending on the organizer.

The devnet program retains an upgrade authority; do not claim the system is immutable against upgrades.

## Demonstration sequence

1. Publish the target, minimum output, deadlines, configuration hash and fee beneficiary.
2. Two contributors fund an oversubscribed round; one withdraws and rejoins before close.
3. A third wallet executes the atomic token creation, DBC pool creation and first purchase.
4. Contributors claim proportional tokens and excess SOL; a second claim fails.
5. Public DBC trading completes the curve; migration creates fully locked DAMM v2 liquidity; a DAMM trade succeeds.
6. A separate campaign fails to fund. Recover the contribution, then show the CLI recovery path without the website.
7. Show the hostile test that found the wrapped-SOL donation bug, its fix and the passing regression.

Every frame must label the network. Do not present local signatures as devnet or mainnet transactions. A roughly 75-second captioned local demonstration is included in demo/index.html, with the source recorder in tests/demo.cjs. It is an internal product demonstration; the final public-network pitch remains to be produced.

## Case against the judging criteria

| Criterion from the [bounty](https://superteam.fun/earn/listing/meteora-dbc) | Evidence we can present | Still missing |
|---|---|---|
| Meaningful Meteora integration | DBC is the issuance and first purchase; actual migration and DAMM trading execute. | Public-network graduation/migration evidence; current public proof covers launch and refunds. |
| Technical execution and robustness | Segregated principal/budget; fixed CPI targets; permissionless execution; refunds independent of DBC; hostile tests, validator test, wallet and recovery flows. | Independent security review and dependency remediation. |
| Originality and taste | One enforceable workflow spanning pre-launch commitment through migration; terms and failure recovery are visible to users. | Originality is moderate; shared entry and escrow have clear predecessors. |
| Impact and new asset classes | Removes operator dependence from a specific coordination step. | No independent demand or new-asset adoption proven. |
| Mainnet usage / traction preference | No fabricated usage. | No mainnet deployment or external users. |

## Submission checklist

- [x] Functional program, SDK, local app, RPC adapter and recovery CLI.
- [x] Full success and failure lifecycle tests, including actual devnet bytecode replayed locally.
- [x] Readable architecture, comparison and explicit limitations.
- [x] Public devnet deployment and transaction manifest (launch, claims and both refund paths).
- [ ] Test at least one real wallet extension end to end.
- [ ] Independent review and production dependency decisions.
- [ ] Public source repository and hosted evidence page.
- [ ] Hosted transactional product (the app currently runs locally against devnet).
- [ ] Independent usage evidence, if obtained; never substitute self-trading.
- [x] Captioned local demonstration video.
- [ ] Final public-network demo and pitch assets.
- [ ] Mainnet decision and funding, if warranted.
- [ ] Final bounty form, links and submission.

This is a strong technical foundation for a competitive entry, not evidence that first place is secured. The impact and adoption case still needs work.
