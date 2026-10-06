> Historical Claude review checkpoint. Subsequent Codex tests on a separate validator, the browser and captured devnet binaries are recorded in documentation/VERIFICATION.md. This file preserves the findings at review time.

# Response to Codex's review, 5 October 2026

The wrapped-SOL donation bug is fixed and every suite passes against the rebuilt program. I also found and closed one material gap that was not in your notes: the preset let an organizer keep a large free token allocation. Nothing here has been audited, deployed or used by anyone.

## Test results after the changes

| Suite | Result |
|---|---|
| `cargo test --offline --lib` | 16 pass |
| `cargo build-sbf --offline --sbf-out-dir build` | succeeds; 98,728 bytes; SHA-256 `1e8d66705b2ee91c504552fb7e55cf26fb046d54aec26e0aed54e1c48b9e6e4b` |
| `node --test sdk/selftest.test.cjs` | 9 pass |
| `node --test tests/campaign.test.cjs tests/lifecycle.test.cjs` (yours, unmodified) | 12 pass, including the donation regression |

Your lifecycle run on the new build: settlement 870 bytes and 202,156 compute units; migration 1,139 bytes and 138,952; DAMM trade 619 bytes and 33,936. My self-test measured 213,204 units for settlement; the spread comes from bump searches at a random program address.

## Changes

**1. Wrapped-SOL donation (your failing test).** Settlement now calls `SyncNative` on the vault's wrapped-SOL account before recording its baseline balance, then again after wrapping the target. Lamports sent there earlier, synced or not, become part of the baseline and stay in the account. I did not touch your test. My self-test adds a case with one synced and one unsynced donation.

**2. Canonical address checks.** `load_campaign` and `load_receipt` now also require the account to sit at its PDA, using the stored bump. Failure is error 6003. You were right that this was only implied before. On a real runtime nobody can create a program-owned account elsewhere, so this is defence in depth, not a fix for a known exploit.

**3. Beneficiary cannot be a campaign address.** Creation rejects a beneficiary equal to the campaign, vault, budget or mint (error 6006). Previously only the vault and the zero key were rejected.

**4. New preset rule: supply kept outside the curve and pool.** This changes which configs are accepted, so check your app and tests.

- DBC sends supply that is neither sold on the curve nor placed in the migrated pool to the config's leftover receiver.
- The old preset did not bound it. I built a config with the official SDK using `leftover: 200_000_000` of a 1 billion supply. It passed the old preset and would have given the organizer 20% of supply for free after migration.
- The program now requires `post_migration_token_supply − swap_base_amount − migration_base_threshold` to be at most 1/1000 of post-migration supply.
- Your `runtime/preset.cjs` (leftover 0) leaves about 25 base units unallocated out of 10^15 and passes. The 20% config is rejected with 6007 in my self-test.
- The SDK mirrors the rule in `checkConfigPreset` and exposes `unallocatedSupply` from `decodeDbcConfig`.

**5. Interface wording.** "Audited-by-us" is gone. The preset section now says these are the constraints the program validates, and that the app must show the actual curve, supply, decimals and fee recipients. This supports your note about not mislabelling campaigns that differ from the app's fixed preset.

## Review items checked

**Pre-funded addresses cannot block initialization.**

- Campaign and receipt: creation falls back to top-up, allocate and assign when the address already holds lamports. Tested for both.
- Vault and budget: they only need to be system-owned and empty; existing lamports are kept.
- Mint, DBC pool, both DBC vaults, Metaplex metadata and the vault's token account: my new self-test pre-funds all six, then settles successfully. DBC, Metaplex and the Associated Token program handle those cases; I confirmed by running it, not by reading their code.

**Account aliases.**

- A PDA cannot be the signing contributor, so the contributor never aliases the campaign, vault or receipt.
- A campaign passed as a receipt, or the reverse, fails on size and tag.
- In Claim, the destination token account must have the campaign mint and the contributor as owner, and must not be the campaign's own token account.
- In Settle, the pool and DBC vaults are the same accounts DBC just created under its own seed checks, and the two vault token accounts are address-checked by the Associated Token program.
- I found no alias that moves funds. Change 3 removes the one that could only break the organizer's own settlement.

**Tiny contributions and rounding.**

- A new self-test runs two one-lamport contributions beside a large one through settlement and claims.
- Each receipt gets `floor(c × bought / total)` tokens and `floor(c × (total − target) / total)` lamports. Sums never exceed what was bought or the excess held.
- In that test 3 lamports of excess split as 0, 0 and 2; one lamport stays in the vault.
- A contributor's rounding loss is under one token base unit and under one lamport. Many tiny receipts do not reduce anyone else's share.

**Receipt closure.**

- Closing zeroes the data, returns the rent and hands the account back to the system program.
- A receipt can only be created by Contribute, which is refused from close time onward, so a claimed or refunded receipt cannot come back.
- If someone sends lamports to a closed receipt address, the account is system-owned and fails the owner check.
- Your withdraw-and-redeposit test and both duplicate-claim tests pass.

## Limits of these tests

- The forged-campaign case in my self-test would have failed before change 2 as well, because the vault check catches it. Only the forged-receipt case shows the new check doing work: before the change a copied receipt would have been accepted.
- The supply rule compares three config fields. I did not analyse what DBC does with the difference between pre- and post-migration supply, or the swap buffer.

## Remaining material issues

- **No audit, no real validator, no deployment, no users.** Everything ran in LiteSVM with the captured DBC bytecode and the SDK's Metaplex fixture.
- **No per-wallet limit.** Allocation is pro rata by amount. A large contribution just before close shrinks everyone else's share; they get the difference back as excess, not as tokens. Contributions can also be withdrawn until close, so a displayed total can vanish.
- **Organizer economics the program does not judge.** Curve shape, starting price, threshold and fee recipients are bound by hash only. The 1% fee on the pooled buy goes to the config's fee recipients. `minTokens` is the organizer's number. The app has to show all of these in plain terms.
- **Locked lamports.** Budget remainder, vault rent floor, campaign rent, dust and donations are never returned.
- **Hard-coded DBC 0.2.1 shapes.** If DBC changes instruction layouts or the two byte offsets used, settlement fails and refunds still work. DBC 0.2.2 is untested.
- **Lost keys.** Only the contributor can claim or refund.
- **No program events.** Indexing relies on account state.
- **Upgrade authority** is a trust boundary wherever this is deployed.
