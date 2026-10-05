# Launch commitments: program and SDK interface (v1)

Owner: Claude (`program/**`, `sdk/**`, this file). Consumers: Codex tests, runtime and app.
Implements `work/product-decision/build-contract.md`. No audit has been done. Local and devnet only.

All amounts are raw units: lamports for SOL, base units for tokens. The SDK takes and returns `bigint` for every amount and timestamp.

## What the program enforces

- Contributions sit in a program-controlled vault until the funding window closes.
- Before close, a contributor can withdraw any part of their own contribution.
- If the round reaches its target, anyone can settle between close and expiry. Settlement creates the token and DBC pool, transfers the pool creator role to the published beneficiary, and buys with exactly `target` lamports. All of this happens in one instruction or not at all.
- After settlement each contributor claims `floor(contribution * bought / total)` tokens and `floor(contribution * (total - target) / total)` lamports of excess.
- If the round is underfunded at close, or unsettled at expiry, each contributor refunds exactly their contribution. Refund never calls DBC.

It does not enforce token quality, organiser honesty about anything off chain, or any outcome of trading after launch.

## Supported preset (the only one)

A campaign can only bind a DBC `PoolConfig` that passes every rule below. These are the constraints the program validates, not a claim that every passing config is safe. The curve shape, total supply, decimals, migration threshold and fee recipients are not constrained; they are bound by hash and the app must show the actual values to contributors.

| Field (byte offset, incl. 8-byte discriminator) | Rule |
|---|---|
| account owner | DBC program |
| data length | 1048 |
| discriminator (0) | `PoolConfig` = `1a 6c 0e 7b 74 e6 81 2b` |
| `quote_mint` (8) | wrapped SOL |
| `pool_fees.base_fee.cliff_fee_numerator` (104, u64) | 10,000,000 (1%) |
| `second_factor` (112), `third_factor` (120), `first_factor` (128, u16) | 0 (no fee schedule) |
| `base_fee_mode` (130) | 0 |
| `dynamic_fee.initialized` (136) | 0 |
| partner and creator LP vesting info (184..216) | all zero |
| `collect_fee_mode` (232) | 0 (quote token) |
| `migration_option` (233) | 1 (DAMM v2) |
| `token_type` (237) | 0 (SPL Token) |
| `quote_token_flag` (238) | 0 |
| `partner_permanent_locked_liquidity_percentage` (239) + `creator_permanent_locked_liquidity_percentage` (241) | sum is 100 |
| `partner_liquidity_percentage` (240), `creator_liquidity_percentage` (242) | 0 |
| `migration_fee_option` (243) | 0..=5 (fixed tiers; not customizable) |
| `fixed_token_supply_flag` (244) | 1 |
| `token_update_authority` (246) | 1 (immutable) |
| `migration_fee_percentage` (247), `creator_migration_fee_percentage` (248) | 0 |
| `migration_quote_threshold` (264, u64) | strictly greater than `target` |
| `post_migration_token_supply` (352) minus `swap_base_amount` (256) minus `migration_base_threshold` (272) | at most 1/1000 of `post_migration_token_supply`; both sums non-zero |
| `locked_vesting_config` (296..344) | all zero |
| `enable_first_swap_with_min_fee` (365) | 0 |
| `pool_creation_fee` (368, u64) | 0 |

The supply rule exists because DBC sends any supply that is neither sold on the curve nor placed in the migrated pool to the config's leftover receiver. Without it an organizer could keep a large free allocation.

Disclosed, not constrained: `fee_claimer` (40), `leftover_receiver` (72), `creator_trading_fee_percentage` (245), `token_decimal` (235), `activation_type` (234), total supply, curve. The 1% fee on the pooled buy is paid to the config's fee recipients like any other trade.

The config's full account data is hashed with SHA-256 at campaign creation and re-checked at settlement.

## Program IDs used

| Name | Address |
|---|---|
| DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| DBC pool authority | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Associated Token | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| System | `11111111111111111111111111111111` |
| Wrapped SOL mint | `So11111111111111111111111111111111111111112` |

The launch-commitments program ID is whatever address the `.so` is loaded at. The program derives every PDA from the ID passed to its entrypoint.

## PDAs

Seeds are raw bytes. `nonce` is a u64, little-endian.

| Account | Seeds | Notes |
|---|---|---|
| campaign | `"campaign"`, organizer, nonce | Program-owned data account, 568 bytes |
| vault | `"vault"`, campaign | System-owned, no data. Holds principal plus a rent floor. Signs as pool creator, buyer and token owner |
| budget | `"budget"`, campaign | System-owned, no data. Pays all settlement rent. Never holds principal |
| mint | `"mint"`, campaign | Becomes the SPL mint at settlement |
| receipt | `"receipt"`, campaign, contributor | Program-owned, 88 bytes. Closed on full withdrawal, claim and refund |

Derived by other programs: DBC pool, base vault, quote vault, Metaplex metadata, and the vault's two associated token accounts (wrapped SOL and the launch token).

## Account layouts (little-endian)

### Campaign, 568 bytes

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | tag `"LCCAMP01"` |
| 8 | 1 | version = 1 |
| 9 | 1 | state: 1 = Open, 2 = Settled |
| 10 | 1 | campaign bump |
| 11 | 1 | vault bump |
| 12 | 1 | budget bump |
| 13 | 1 | mint bump |
| 14 | 1 | name length |
| 15 | 1 | symbol length |
| 16 | 1 | uri length |
| 17 | 7 | zero padding |
| 24 | 32 | organizer |
| 56 | 8 | nonce (u64) |
| 64 | 32 | beneficiary (receives the pool creator role) |
| 96 | 32 | DBC config |
| 128 | 32 | SHA-256 of config account data |
| 160 | 32 | mint |
| 192 | 32 | campaign token account (zero until settled) |
| 224 | 8 | target (u64 lamports) |
| 232 | 8 | minTokens (u64) |
| 240 | 8 | closeTime (i64 unix seconds) |
| 248 | 8 | expiry (i64) |
| 256 | 8 | totalContributed (u64). Changes only while funding is open |
| 264 | 8 | receiptCount (u64). Live receipts |
| 272 | 8 | tokensBought (u64) |
| 280 | 8 | settledAt (i64) |
| 288 | 8 | tokensClaimed (u64) |
| 296 | 8 | excessPaid (u64) |
| 304 | 8 | refunded (u64). Failed-launch principal returned |
| 312 | 8 | createdAt (i64) |
| 320 | 32 | name, zero padded |
| 352 | 10 | symbol, zero padded |
| 362 | 200 | uri, zero padded |
| 562 | 6 | zero padding |

Phase is derived from state and time; there is no stored "failed" state.

| Phase | Condition |
|---|---|
| Funding | state Open and `now < closeTime` |
| Settleable | state Open and `closeTime <= now < expiry` and `totalContributed >= target` |
| Refundable | state Open and (`now >= closeTime` and `totalContributed < target`, or `now >= expiry`) |
| Settled | state Settled |

### Receipt, 88 bytes

| Offset | Size | Field |
|---|---|---|
| 0 | 8 | tag `"LCRCPT01"` |
| 8 | 32 | campaign |
| 40 | 32 | contributor |
| 72 | 8 | amount (u64 lamports) |
| 80 | 1 | bump |
| 81 | 7 | zero padding |

Every instruction that reads a campaign or receipt checks the program owner, the tag, and that the account sits at its canonical PDA (error 6003 otherwise).

A missing receipt means nothing is owed: either never contributed, fully withdrawn, claimed or refunded. A receipt cannot be recreated after `closeTime`, because only Contribute creates one.

## Instructions

First data byte is the tag. `s` = signer, `w` = writable.

### 0 CreateCampaign

Data: `0 | nonce u64 | target u64 | minTokens u64 | closeTime i64 | expiry i64 | budgetLamports u64 | nameLen u8 | name | symbolLen u8 | symbol | uriLen u8 | uri`

| # | Account | Flags |
|---|---|---|
| 0 | organizer | s w |
| 1 | campaign | w |
| 2 | vault | w |
| 3 | budget | w |
| 4 | beneficiary | |
| 5 | DBC config | |
| 6 | system program | |

Requires `target > 0`, `minTokens > 0`, `closeTime > now`, `expiry > closeTime`, name 1..=32 bytes, symbol 1..=10, uri 1..=200, beneficiary not the zero key and not the campaign, vault, budget or mint address, config passes the preset, `budgetLamports >= MIN_SETUP_BUDGET_LAMPORTS`. The organizer pays campaign rent, the vault rent floor and the budget. None of that is recoverable in v1.

### 1 Contribute

Data: `1 | amount u64`

| # | Account | Flags |
|---|---|---|
| 0 | contributor | s w |
| 1 | campaign | w |
| 2 | vault | w |
| 3 | receipt | w |
| 4 | system program | |

Only while Funding. `amount > 0`. Creates the receipt if absent (contributor pays its rent).

### 2 Withdraw

Data: `2 | amount u64`. Same accounts as Contribute.

Only while Funding. `0 < amount <= receipt.amount`. A receipt that reaches zero is closed and its rent returned to the contributor.

### 3 Settle

Data: `3`. No signer is required by the program; any fee payer can submit it.

| # | Account | Flags |
|---|---|---|
| 0 | campaign | w |
| 1 | vault | w |
| 2 | budget | w |
| 3 | mint | w |
| 4 | beneficiary | |
| 5 | DBC config | |
| 6 | DBC pool authority | |
| 7 | DBC pool | w |
| 8 | DBC base vault | w |
| 9 | DBC quote vault | w |
| 10 | Metaplex metadata | w |
| 11 | wrapped SOL mint | |
| 12 | vault wrapped-SOL token account (ATA) | w |
| 13 | vault launch-token account (ATA) | w |
| 14 | DBC event authority | |
| 15 | DBC program | |
| 16 | Metaplex program | |
| 17 | SPL Token program | |
| 18 | Associated Token program | |
| 19 | system program | |

Only while Settleable. Fixed sequence, built inside the program:

1. DBC `initialize_virtual_pool_with_spl_token` (creator = vault, payer = budget, mint signs by seeds).
2. DBC `transfer_pool_creator` to the beneficiary.
3. Associated Token `CreateIdempotent` for both vault token accounts (payer = budget).
4. `SyncNative` on the wrapped-SOL account, then record its balance. Lamports someone sent there earlier become part of the baseline.
5. Transfer exactly `target` lamports from vault to that account; `SyncNative` again.
6. DBC `swap2`, exact-in `target`, minimum out `minTokens`.
7. Check the wrapped-SOL balance equals the step 4 baseline, and the token balance rose by at least `minTokens`.

Then `tokensBought`, `settledAt`, the token account and state are recorded. A failure at any step reverts the whole instruction.

### 4 Claim

Data: `4`

| # | Account | Flags |
|---|---|---|
| 0 | contributor | s w |
| 1 | campaign | w |
| 2 | vault | w |
| 3 | receipt | w |
| 4 | campaign token account | w |
| 5 | contributor token account (mint = campaign mint, owner = contributor) | w |
| 6 | SPL Token program | |
| 7 | system program | |

Only when Settled. Pays tokens and excess lamports, then closes the receipt and returns its rent.

### 5 Refund

Data: `5`

| # | Account | Flags |
|---|---|---|
| 0 | contributor | s w |
| 1 | campaign | w |
| 2 | vault | w |
| 3 | receipt | w |
| 4 | system program | |

Only while Refundable. Pays exactly `receipt.amount`, then closes the receipt and returns its rent. Touches no DBC account.

## Allocation arithmetic

With `c` = receipt amount, `T` = `totalContributed`, `G` = `target`, `B` = `tokensBought`, all as u128 intermediates:

- tokens = `floor(c * B / T)`
- excess = `floor(c * (T - G) / T)`

Sums of floors never exceed `B` and `T - G`. Remainders stay in the campaign token account and vault permanently. There is no sweep.

## Custom error codes

| Code | Name |
|---|---|
| 6000 | InvalidInstructionData |
| 6001 | MissingSignature |
| 6002 | InvalidProgramId |
| 6003 | InvalidPda |
| 6004 | InvalidAccountOwner |
| 6005 | InvalidAccountData |
| 6006 | InvalidTerms |
| 6007 | ConfigNotSupported |
| 6008 | ConfigHashMismatch |
| 6009 | FundingClosed |
| 6010 | FundingStillOpen |
| 6011 | TargetNotReached |
| 6012 | SettlementExpired |
| 6013 | WrongState |
| 6014 | RefundNotAvailable |
| 6015 | InsufficientReceiptBalance |
| 6016 | MathOverflow |
| 6017 | MinTokensNotMet |
| 6018 | QuoteSpendMismatch |
| 6019 | InvalidTokenAccount |
| 6020 | BudgetTooSmall |
| 6021 | ZeroAmount |
| 6022 | VaultInvariant |

## SDK (`sdk/index.cjs`, CommonJS)

No key management. Builders return unsigned `@solana/web3.js` `Transaction` objects containing instructions only; the caller sets `feePayer` and `recentBlockhash` and signs. Every builder takes `programId` and explicit public keys.

```js
const lc = require('./sdk/index.cjs');
```

### Constants

`TAG`, `STATE`, `CAMPAIGN_SIZE`, `RECEIPT_SIZE`, `MIN_SETUP_BUDGET_LAMPORTS` (bigint, 50,000,000), `ERRORS` (code to name), `DBC_PROGRAM_ID`, `METADATA_PROGRAM_ID`, `WSOL_MINT`, `CONFIG_SIZE`.

One local settlement spent 29,077,360 lamports of the budget, in an 870-byte legacy transaction using 202,156 to 213,204 compute units across runs. No lookup table is needed.

### Derivation

| Function | Returns |
|---|---|
| `deriveCampaign(programId, organizer, nonce)` | `[PublicKey, bump]` |
| `deriveVault(programId, campaign)` | `[PublicKey, bump]` |
| `deriveBudget(programId, campaign)` | `[PublicKey, bump]` |
| `deriveMint(programId, campaign)` | `[PublicKey, bump]` |
| `deriveReceipt(programId, campaign, contributor)` | `[PublicKey, bump]` |
| `deriveSettlementAccounts(programId, campaign, config)` | every address Settle needs, by name |

### Decoding

| Function | Returns |
|---|---|
| `decodeCampaign(data)` | object with the fields above; amounts and times as bigint; keys as `PublicKey`; `configHash` as hex |
| `decodeReceipt(data)` | `{campaign, contributor, amount, bump}` |
| `decodeDbcConfig(data)` | the config fields listed in the preset table plus disclosed fields, and `unallocatedSupply` |
| `checkConfigPreset(data, target)` | `{ok, violations: string[]}`; mirrors the program |
| `hashConfig(data)` | hex SHA-256 |
| `phase(campaign, now)` | `'funding' \| 'settleable' \| 'refundable' \| 'settled'` |
| `allocation({contribution, total, target, bought})` | `{tokens, excess}` |

### Transaction builders (all async)

| Function | Arguments | Returns |
|---|---|---|
| `createCampaign` | `{programId, organizer, nonce, beneficiary, config, target, minTokens, closeTime, expiry, budgetLamports, name, symbol, uri}` | `{transaction, campaign, vault, budget, mint}` |
| `contribute` | `{programId, campaign, contributor, amount}` | `{transaction, receipt}` |
| `withdraw` | `{programId, campaign, contributor, amount}` | `{transaction, receipt}` |
| `settle` | `{programId, campaign, config, beneficiary, computeUnitLimit?}` or `{connection, programId, campaign}` | `{transaction, accounts}` |
| `claim` | `{programId, campaign, contributor, createTokenAccount?}` | `{transaction, tokenAccount}` |
| `refund` | `{programId, campaign, contributor}` | `{transaction, receipt}` |

`settle` prepends a compute-unit limit (default 400,000). When `config` or `beneficiary` is omitted it reads the campaign through `connection`. `claim` prepends an idempotent creation of the contributor's associated token account unless `createTokenAccount` is `false`.

`instructions.*` exposes the same six as synchronous `TransactionInstruction` builders with fully explicit accounts.

## Known limits

- One preset; plain SPL token; SOL quote.
- No per-wallet limit. Allocation is pro rata by amount, so a large late contribution reduces everyone else's share (they get the difference back as excess). Contributions can also be withdrawn until close.
- The setup budget and the vault rent floor are never returned. Anyone can top up the budget with a plain transfer if rent rises.
- Lamports or tokens sent directly to program accounts are not counted and cannot be recovered.
- The program has an upgrade authority wherever it is deployed. That is a trust boundary until removed.
- DBC and Metaplex are upstream dependencies. If either changes, settlement can fail; refunds still work.
