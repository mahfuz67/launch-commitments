# What the program enforces

Moved from the repository README. [INTERFACE.md](../INTERFACE.md) is the wire contract; [COMPARISON.md](COMPARISON.md) sets these rules beside existing options.

## Rules

1. At creation, the program commits to the organizer, beneficiary, token metadata, target, minimum token output, close time, expiry and exact DBC configuration hash.
2. Contributions enter a principal vault. A separate organizer-funded budget pays settlement account rent. Contributors may withdraw before close.
3. At close, an adequately funded campaign is permissionlessly settleable until expiry. Settlement creates the token and pool, transfers creator rights to the published beneficiary, and spends exactly the target on the first DBC purchase. All operations roll back if any fails.
4. Claims pay `floor(contribution × tokensBought / finalTotal)` tokens and `floor(contribution × (finalTotal − target) / finalTotal)` lamports. Closing the receipt prevents a repeat claim. Sub-unit rounding dust remains locked.
5. An underfunded campaign is refundable at close; an unexecuted funded campaign is refundable at expiry. Refund does not invoke DBC.
6. The supported constraints require a fixed 1% DBC fee, ordinary SPL/SOL, immutable metadata, fixed supply, no extraction fee at migration and 100% permanently locked migrated liquidity. The unallocated-supply allowance is at most 0.1%; the app preset requests zero leftover. Curve shape, valuation, beneficiary and fee recipients remain economic choices, not certifications of asset quality.

## App preset

The app uses one economic preset: 1 billion tokens, 6 decimals, creator fee share 100%, creator locked-liquidity share 100%, no requested leftover. The local demonstration has a 2 SOL default target and approximately 10.4132 SOL graduation threshold. Public **devnet test mode scales the curve's SOL amounts by 0.01**: default target 0.02 test SOL and approximately 0.104132267 test SOL graduation threshold. These are test configurations, not valuations or investment recommendations.

The shared first purchase can obtain a lower average price than later public buyers. This is disclosed; there is no claim of equal prices, identity fairness or protection from trading losses. Late large contributors can dilute earlier contributors' token shares, with excess refunded proportionally.

## Limits

The program is not audited. Setup-budget remainder, campaign/vault rent, dust and donations remain locked. Lost contributor keys cannot be recovered by an administrator. Program upgrade authority is a trust boundary wherever deployed. Dependency inspection still reports 14 affected packages including transitive propagation; see [DEPENDENCIES.md](DEPENDENCIES.md). External wallet extension testing, independent review and real demand evidence remain release work.

The SDK interface and captured bytecode are version-sensitive. Changes upstream can prevent settlement; the separate expiry-refund path remains available. The two-agent review found and fixed an unsynchronized wrapped-SOL donation denial of service and an excessive-leftover-supply configuration gap. Passing tests do not turn that review into an audit.
