# Product decision and evidence

## Intended user and job

A community organizer wants to coordinate a launch before a public DBC pool exists. Contributors want to know what their pooled funds can do, what allocation they will receive, and how to recover funds if the organizer disappears or the launch does not happen.

The specific job is **execute these launch terms or let me recover my contribution without an operator**. DBC is the actual issuance, initial purchase and price-discovery mechanism. DAMM v2 is the successor liquidity venue. Neither is an incidental integration.

## Evidence and what it does not prove

| Public evidence | Implication | Limit |
|---|---|---|
| [Meteora Presale SDK](https://github.com/MeteoraAg/presale-sdk) separates fundraising from liquidity deployment; its documentation places deployment with the creator. | There is a real workflow boundary between raising money and deploying liquidity. | This does not measure how often users experience failure or whether they will switch. |
| [ProofLaunch](https://prooflaunch.fun/rhc/docs) advertises contract-enforced shared launches and refunds on Robinhood Chain. An indexed older Solana README describes platform-managed execution; the repository currently returned 404 in one review. | Both shared entry and contract-enforced recovery have precedents. | Neither deployment security nor usage was independently verified. Do not describe the entire current product as operator-custodied. |
| [Alpha Vault documentation](https://github.com/MeteoraAg/docs/blob/main/developer-guides/alpha-vault/index.mdx) describes distribution around DAMM/DLMM pools. | Existing Meteora launch allocation tools must be compared seriously. Our focus is the commitment before creating the DBC pool, plus atomic execution or refund. | This is a narrower workflow difference, not proof of a broad market gap. |
| [Party crowdfunding](https://docs.partydao.org/docs/crowdfund/Overview) already supports on-chain collective coordination. | Escrow and proportional crowdfunding are established patterns. | No “world first” claim is justified. |

These are primary public product/code sources. They establish mechanism and competitive context, not independently verified recurring losses or customer demand. No invented interviews or testimonials are used. Colosseum Copilot access returned 403 during the fresh comparison attempt; prior saved research was retained but not labelled as a successful fresh query.

Plain DBC already sells tokens through a curve without a separate organizer-held presale wallet. This component earns its place only when contributors need to coordinate before token creation. No public request for our exact implementation was found in the October 5 research. The launchpad-module positioning is an untested hypothesis.

## Why this candidate survived

It has one concrete user action, a demonstrable failure path, a DBC-specific transaction boundary and an outcome that can be checked on chain. Its hardest assumption—creating the launch and executing its first buy atomically from segregated principal—now works in both LiteSVM and a separate validator. The UI also covers the unpopular outcome: no launch, full accounted-principal recovery.

Claude and Codex independently challenged the candidates. A prepaid-service-credit direction was dropped because its reserve economics and service-delivery demand were not supported. Fee rights received no preference from prior effort. The current direction won on a coherent executable workflow, not because we proved market adoption.

## What could still make it lose

- The initial asset is a conventional community token, not a demonstrated new asset class.
- Contract-enforced pooled launches also have cross-chain precedents. Our Solana DBC implementation is not a new category.
- Organizers may prefer an existing launchpad and accept its trust model.
- New custody code increases review burden; a clean demo is insufficient evidence of production security.
- Without independent usage, the impact/traction case is weaker than the technical case.

## The next meaningful evidence

A public devnet deployment with independently reproducible transactions; external users completing creation, contribution and recovery without help; a clear comparison of the operator-dependent steps removed; then a reviewed, narrowly scoped mainnet pilot if warranted. Our own wallets are tests and must not be counted as users or organic volume. No outreach messages have been sent.
