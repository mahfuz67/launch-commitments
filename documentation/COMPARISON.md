# Launch Commitments compared with existing options

5 October 2026. Sources are the projects' own documentation and repositories, fetched on this date and linked inline. Documentation shows what a product says it does. None of the other products' code was run, no wallet was connected to them and no transaction was sent to them, so their descriptions here are unverified claims by their authors.

This comparison makes no claim that Launch Commitments is unique, first, or wanted. Pooled launches with refunds already exist on Solana and elsewhere. The differences below are about who holds the money, who has to act, and what the launch venue is.

## The options side by side

| Option | Who holds committed funds before launch | Who has to act for the launch to happen | If the raise fails | Where the token trades first |
|---|---|---|---|---|
| Plain DBC | Nobody. There is no commitment stage; buyers trade against the curve | The creator or launchpad creates the pool; each buyer buys for themselves | Not applicable. A buyer can only sell back on the curve at the current price | DBC curve |
| Meteora Presale Vault | A Meteora program vault | The creator: withdraws the raised funds and deploys liquidity themselves | Buyers withdraw their deposit | Wherever the creator later lists it |
| Alpha Vault with a DAMM v2 launch pool | A Meteora program vault tied to an existing pool | The creator seeds the pool first; crankers fill the vault's buy in the pre-activation window | Unused deposits are withdrawable. No minimum-raise failure mode is described in the overview | DAMM v2 (also DLMM, DAMM v1) |
| ProofLaunch on Solana | A pooled wallet, per its docs | The creator launches when all slots fill; tokens are then sent to backers | Refund claimed from the site if slots do not fill in three days | Pump.fun, Meteora or Raydium LaunchLab |
| ProofLaunch on Robinhood Chain | A per-campaign contract | The creator, or anyone after the deadline | Refunds open after the deadline plus a three-day grace | pons, on Robinhood Chain. Not Solana |
| Blank Pre-Raise | Meteora Presale Vault escrow | Blank operates automatic settlement, per its docs | Every contributor can refund | A DAMM v2 pool that Blank seeds with the raised SOL |
| Launch Commitments | A per-campaign vault owned by this project's program | Anyone, between close and expiry, in one transaction | Each contributor refunds their own principal with their own signature | DBC curve |

## Each option in more detail

### Plain DBC

A creator or launchpad creates a config and a pool, and buyers purchase along the curve at rising prices. When the quote reserve reaches the configured threshold, curve trading stops and the pool can migrate to DAMM v2 ([migration docs](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity)).

There is no pooled pre-launch stage, so there is no organizer-held fund to protect and nothing to refund. This is the baseline to beat: Launch Commitments adds a stage, and custody code, that plain DBC does not need. The extra stage only earns its place when a group wants to commit before a token exists and enter at one shared price.

Fees, per [Meteora's DBC fee docs](https://docs.meteora.ag/core-products/dbc/fees/overview): the protocol receives 20% of the trading fee, and the partner and creator split the rest as the config sets. The docs also describe a fixed 0.2% protocol fee on migrated liquidity.

### Meteora Presale Vault

A first-party program for a standalone token sale ([docs](https://docs.meteora.ag/helper-products/presale-vault/what-is-presale-vault), [SDK](https://github.com/MeteoraAg/presale-sdk)). It offers fixed-price, first-come and pro rata modes, allowlists, per-buyer caps, vesting, and refunds of oversubscription. The docs mark it as beta.

Two points matter for this comparison:

- A failed sale permits recovery of deposited quote and refundable fees. Failure refunds are already a first-party feature.
- After success, the creator can withdraw raised funds; the presale product does not itself create or fund the trading venue.

So it protects contributors when a sale fails, and hands the funds to the creator when it succeeds. Launch Commitments differs only in the second case: the funds cannot go to the creator, only into the first purchase on the published curve. Presale Vault has features Launch Commitments lacks, including caps, allowlists, vesting and fixed pricing.

### Alpha Vault with a DAMM v2 launch pool

Also first-party ([docs](https://docs.meteora.ag/helper-products/alpha-vault/what-is-alpha-vault)). Supporters deposit before a launch pool opens. During the pool's pre-activation window the vault buys from that pool, then depositors claim tokens and withdraw unused quote. It supports pro rata and first-come modes, allowlists and vesting. Supported pools are listed as DLMM, DAMM v1 and DAMM v2. DBC is not listed.

This is the closest first-party equivalent of a shared first purchase. The difference is the venue and what the creator must do first. An Alpha Vault needs an existing launch pool that the creator has created and seeded. Launch Commitments creates the token and the DBC pool in the same transaction as the purchase, so no token or pool exists unless the round funds.

A team that is happy to launch on DAMM v2 with its own seeded pool can use Alpha Vault today, on a first-party mainnet program. Launch Commitments is only relevant when the launch is meant to be a DBC curve.

### ProofLaunch

Two versions exist and they have different trust models.

**Solana.** The [current Solana docs](https://sol.prooflaunch.fun/docs) (v0.2.0) describe 2 to 24 backer slots, a choice of Pump.fun, Meteora or Raydium LaunchLab, one transaction that creates the token and buys with the pool, and proportional distribution. The documentation describes custody in a shared on-chain wallet. Unfilled raises can be refunded from the site after three days. The same page contrasts itself with the Robinhood Chain version, where contracts replace platform operations. An earlier README in its [GitHub repository](https://github.com/Based-LTD/prooflaunch) described platform-controlled wallets and scheduled jobs. That repository returned 404 on 5 October 2026, so the README is historical, read from a web index.

This is the same product idea as Launch Commitments on the same chain, and it supports more venues. The difference is that its pooled funds sit in a wallet and its launch and refunds are platform operations, while ours sit in a program vault and are executed by whoever sends the transaction. We did not test its refunds and have no evidence that they fail.

**Robinhood Chain.** The [current docs](https://prooflaunch.fun/rhc/docs) (v0.3.0) describe a contract per campaign that holds the pool, launches and buys in one transaction, and lets backers claim pro rata. They state "no admin keys, no pause switch, no upgrade path" and "goal unmet by deadline (+3-day grace) → refunds open unconditionally". Listed fees are 0.001 ETH to create a launch, and fixed shares of the creator fee stream for a token burn and the platform.

By its own description this version makes a stronger claim than ours: no upgrade path, where our program is upgradeable. It is on a different chain and launches on a different venue, so it is not an alternative for a Meteora DBC launch. It does show that contract-enforced pooled launches are not a new category. Its site shows no audit and we verified none of it.

### Blank

A Solana launchpad whose [FAQ](https://blank.build/faq) says it is live on mainnet. Its [Pre-Raise docs](https://blank.build/docs/launching-tokens/pre-raise) describe contributors committing SOL before trading opens, with exactly two outcomes. If the minimum is met, Blank says it deploys the raised SOL and allocated tokens into DAMM v2, permanently locks liquidity and burns the remainder. Otherwise contributors can recover their deposits.

The docs say the sale escrow is Meteora Presale Vault in first-come mode and the pool is DAMM v2. They also describe per-wallet caps, an allowlist window, a disclosed creator buy-in at the sale price, and no treasury cut.

Differences from Launch Commitments:

- **Venue and pricing.** Blank sells at a presale price and opens a DAMM v2 pool at a multiple of it (its table shows 1x to 3x). Launch Commitments buys the first segment of a DBC curve.
- **Who acts.** Blank's docs say settlement runs automatically and that Blank completes it. Presale Vault's design lets the vault creator withdraw raised funds after a successful sale. The docs do not say which key performs the withdraw-and-seed step or whether it is one transaction. We did not inspect it.

Blank advertises mainnet availability, caps and allowlists, and builds on first-party Meteora escrow. For a team that wants a presale followed by a locked DAMM v2 pool, it already exists.

### Launch Commitments

A community funds a launch on published terms. After the funding window closes, anyone can send one transaction that creates the token, creates the DBC pool, hands the pool creator role to the published beneficiary and spends exactly the target on the first purchase. Contributors then claim tokens and excess SOL pro rata. If the round is underfunded at close, or funded but not launched by its expiry, each contributor refunds their own principal. The refund does not call DBC.

## What Launch Commitments guarantees, and where that stops

These hold for the reviewed program build as long as it is not replaced (see authority below). They are enforced by the program, not by the app.

- Contributed SOL can leave a campaign vault in four ways only: withdrawal by its contributor before close, the first DBC purchase of exactly the target, a contributor's excess after launch, or a contributor's refund of a failed launch.
- The organizer has no instruction that moves contributed SOL and is not needed for launch, claim or refund.
- The launch is one transaction. If any step fails, including a first purchase that returns fewer tokens than the published minimum, nothing changes.
- The DBC configuration is bound by hash at creation and re-checked at launch.

It does not guarantee any of the following:

- **Anything after launch.** Contributors hold a token that can go to zero. The refund covers a launch that did not happen, not a price.
- **A fair price against later buyers.** The pooled purchase can obtain an earlier and lower average entry price than later public buyers. It is a disclosed initial allocation, not equal pricing for all market participants.
- **A short wait.** A funded campaign that nobody launches is refundable only at its expiry. The program puts no upper limit on the expiry an organizer sets; the app uses ten minutes after close.
- **Equal shares.** There is no per-wallet cap or allowlist. A large late contribution reduces earlier contributors’ proportional token shares. Any excess SOL is returned proportionally, not as a fixed compensation for dilution.
- **Recovery of a lost key.** Only the contributor's own key can claim or refund.
- **Token quality.** One preset is validated: 1% fee, plain SPL token, fixed supply, immutable metadata, 100% of migrated liquidity permanently locked, at most 0.1% of supply outside the curve and pool. Curve shape, valuation and fee recipients are the organizer's choice and are only bound by hash.

## Fees and costs

| Who | Pays | Recoverable |
|---|---|---|
| Organizer | About 0.11 SOL per campaign through the app: a 0.1 SOL setup budget plus config, campaign and vault rent | No, in this version. This includes a campaign that fails to fund |
| Contributor | Receipt rent, returned on claim, refund or full withdrawal. Token account rent on first claim. Network fees | Receipt rent only |
| The pooled purchase | DBC's trading fee, fixed at 1% by the preset. Per Meteora's docs, 20% of that goes to the Meteora protocol and the rest to the config's partner and creator recipients. In the app preset the creator share is 100% and the creator is the campaign's beneficiary | No |
| Migration, later | The preset sets partner and creator migration fees to 0%. Meteora's docs describe a fixed 0.2% protocol fee on migrated liquidity, which this project does not control | No |
| Launch Commitments itself | The program takes no fee | — |

The organizer, as beneficiary and fee recipient in the app's preset, earns DBC creator fees from the pooled purchase and from all later trading. That is a standing incentive and is shown in the app.

Rounding dust, donations sent to program accounts, the unspent setup budget and the vault's rent stay locked permanently. There is no sweep.

## Authority and status

- **Upgradeable.** The devnet program [`4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD`](https://explorer.solana.com/address/4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD?cluster=devnet) has an upgrade authority, `BuJR5G8kdNrkvHVPJ5R4ozub2ydkY8jAc6zadAGk1AFV`, held by the build team. Whoever holds that key can replace the program and take or freeze every vault. The guarantees above are therefore guarantees against the organizer and the website, not against the key holder.
- **Not audited.** The program was reviewed only by the two agents that built it.
- **Devnet only.** There is no mainnet deployment. The devnet preset scales the curve's SOL amounts by 0.01.
- **Upstream dependence.** DBC and Metaplex are upgradeable programs run by others. Their instruction layouts are hard-coded here. If they change, launches fail; refunds do not depend on them.
- **Evidence.** The devnet run uses test wallets created and funded by the build team. See [PUBLIC-DEMO.md](PUBLIC-DEMO.md), the original launch/refund proof manifest and the follow-up migration manifest for the paths executed on public devnet. None of it is usage or demand.

## Why DBC, given the alternatives

The honest answer is narrow. With Alpha Vault or Blank's Pre-Raise, someone seeds a pool and sets an opening price. For a DBC launch, the organizer still chooses the starting price and curve shape. Quote reserves accumulate through purchases rather than a separate creator-funded quote deposit before trading; the pooled purchase takes the first segment, and later trading can continue on that curve. Launch Commitments is the commitment stage for that venue, which Alpha Vault does not list as supported.

That is a design difference, not evidence that anyone needs it. Meteora's own framing is that a bonding curve already works like a presale with price movement, so a team must have a reason to commit funds before the curve exists. Two candidate reasons are that no token is created unless the round funds, and that every contributor gets one shared price. Neither has been tested with a real organizer.

## What this comparison does not establish

- That any listed product is safe, audited, or works as documented.
- That contributors to ProofLaunch or Blank have lost funds or want to switch.
- That organizers prefer program-enforced execution to a platform they already use.
- Any usage, volume or demand for Launch Commitments.
