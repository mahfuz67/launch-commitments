// Local end-to-end check of the program and SDK. Everything executes inside LiteSVM
// against the captured deployed DBC bytecode in ../fixtures. No network, no real funds;
// keypairs are generated in memory and discarded.
//
// Run from work/launch-commitments:  node --test sdk/selftest.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BN = require('bn.js');
const { Keypair, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } = require('@solana/spl-token');
const dbc = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { createEnvironment } = require('../runtime/vm.cjs');
const { preset } = require('../runtime/preset.cjs');
const lc = require('./index.cjs');

const SOL = 1_000_000_000n;
const PROGRAM_SO = path.resolve(__dirname, '../program/build/launch_commitments.so');
const programId = Keypair.generate().publicKey;
const env = createEnvironment({ programId, programPath: PROGRAM_SO });
const client = new dbc.DynamicBondingCurveClient(env.connection, 'confirmed');

const organizer = Keypair.generate();
const beneficiary = Keypair.generate().publicKey;
const settler = Keypair.generate();
const alice = Keypair.generate(), bob = Keypair.generate(), carol = Keypair.generate();
for (const k of [organizer, settler, alice, bob, carol]) env.fund(k.publicKey, 100n * SOL);

const configKey = Keypair.generate();
const presetParams = preset();
const measurements = {};

const nowTs = () => env.vm.getClock().unixTimestamp;
const lamports = (k) => env.vm.getBalance(k.toBase58()) ?? 0n;
const tokenAmount = (k) => { const a = env.account(k.toBase58()); return a ? a.data.readBigUInt64LE(64) : null; };
const campaignState = (k) => lc.decodeCampaign(env.account(k.toBase58()).data);
const RENT_FLOOR = env.vm.minimumBalanceForRentExemption(0n);

async function run(built, signers) { return env.execute(built.transaction ?? built, signers); }

/** The transaction must fail with exactly this launch-commitments error code. */
async function expectError(promise, code) {
  const hex = '0x' + code.toString(16);
  await assert.rejects(promise, (e) => {
    const logs = (e.logs || []).join('\n');
    assert.ok(logs.includes(`custom program error: ${hex}`), `expected ${lc.ERRORS[code]} (${hex}), got:\n${e.message}\n${logs}`);
    return true;
  });
}

async function newCampaign(nonce, { target = SOL, closeIn = 100n, expireIn = 200n, config = configKey.publicKey, budgetLamports } = {}) {
  const quote = client.pool.getQuoteFromInputAmount({ config: presetParams, swapBaseForQuote: false, amountIn: new BN(target.toString()), slippageBps: 50 });
  const minTokens = BigInt(quote.minimumAmountOut.toString());
  const built = await lc.createCampaign({
    programId, organizer: organizer.publicKey, nonce, beneficiary, config, target, minTokens,
    closeTime: nowTs() + closeIn, expiry: nowTs() + expireIn, budgetLamports,
    name: 'Selftest launch', symbol: 'SELF', uri: 'https://example.invalid/selftest.json',
  });
  await run(built, [organizer]);
  return { ...built, minTokens, target };
}

test('DBC preset config: created by the official SDK, decoded identically, accepted', async () => {
  const tx = await client.partner.createConfig({
    config: configKey.publicKey, feeClaimer: organizer.publicKey, leftoverReceiver: organizer.publicKey,
    payer: organizer.publicKey, quoteMint: lc.WSOL_MINT, ...presetParams,
  });
  await env.execute(tx, [organizer, configKey]);
  const info = env.account(configKey.publicKey.toBase58());
  assert.equal(info.data.length, lc.CONFIG_SIZE);
  assert.ok(info.owner.equals(lc.DBC_PROGRAM_ID));

  // our fixed offsets against the official decoder
  const mine = lc.decodeDbcConfig(info.data);
  const theirs = await client.state.getPoolConfig(configKey.publicKey);
  assert.ok(mine.quoteMint.equals(theirs.quoteMint));
  assert.ok(mine.feeClaimer.equals(theirs.feeClaimer));
  assert.ok(mine.leftoverReceiver.equals(theirs.leftoverReceiver));
  assert.equal(mine.cliffFeeNumerator.toString(), theirs.poolFees.baseFee.cliffFeeNumerator.toString());
  assert.equal(mine.secondFactor.toString(), theirs.poolFees.baseFee.secondFactor.toString());
  assert.equal(mine.thirdFactor.toString(), theirs.poolFees.baseFee.thirdFactor.toString());
  assert.equal(mine.firstFactor, theirs.poolFees.baseFee.firstFactor);
  assert.equal(mine.baseFeeMode, theirs.poolFees.baseFee.baseFeeMode);
  assert.equal(mine.dynamicFeeInitialized, theirs.poolFees.dynamicFee.initialized);
  for (const f of ['collectFeeMode', 'migrationOption', 'activationType', 'tokenDecimal', 'tokenType', 'quoteTokenFlag',
    'partnerPermanentLockedLiquidityPercentage', 'partnerLiquidityPercentage', 'creatorPermanentLockedLiquidityPercentage',
    'creatorLiquidityPercentage', 'migrationFeeOption', 'fixedTokenSupplyFlag', 'creatorTradingFeePercentage',
    'tokenUpdateAuthority', 'migrationFeePercentage', 'creatorMigrationFeePercentage', 'enableFirstSwapWithMinFee']) {
    assert.equal(mine[f], theirs[f], f);
  }
  for (const f of ['swapBaseAmount', 'migrationQuoteThreshold', 'migrationBaseThreshold', 'preMigrationTokenSupply', 'postMigrationTokenSupply', 'poolCreationFee']) {
    assert.equal(mine[f].toString(), theirs[f].toString(), f);
  }
  assert.deepEqual(lc.checkConfigPreset(info.data, SOL), { ok: true, violations: [] });
  measurements.migrationQuoteThreshold = mine.migrationQuoteThreshold.toString();
});

test('funded and oversubscribed: settle once, claim pro rata, nothing left owed', async () => {
  const c = await newCampaign(1n);
  let s = campaignState(c.campaign);
  assert.equal(s.state, lc.STATE.Open);
  assert.equal(s.configHash, lc.hashConfig(env.account(configKey.publicKey.toBase58()).data));
  assert.ok(s.mint.equals(c.mint));
  assert.equal(lamports(c.vault), RENT_FLOOR);
  assert.equal(lamports(c.budget), lc.MIN_SETUP_BUDGET_LAMPORTS);

  const put = { alice: 600_000_000n, bob: 500_000_000n, carol: 400_000_000n };
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: alice.publicKey, amount: put.alice }), [alice]);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: bob.publicKey, amount: 200_000_000n }), [bob]);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: bob.publicKey, amount: 300_000_000n }), [bob]);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: carol.publicKey, amount: 500_000_000n }), [carol]);
  await run(await lc.withdraw({ programId, campaign: c.campaign, contributor: carol.publicKey, amount: 100_000_000n }), [carol]);
  await expectError(run(await lc.withdraw({ programId, campaign: c.campaign, contributor: carol.publicKey, amount: put.carol + 1n }), [carol]), 6015);
  await expectError(run(await lc.contribute({ programId, campaign: c.campaign, contributor: carol.publicKey, amount: 0n }), [carol]), 6021);

  const total = put.alice + put.bob + put.carol;
  s = campaignState(c.campaign);
  assert.equal(s.totalContributed, total);
  assert.equal(s.receiptCount, 3n);
  assert.equal(lamports(c.vault), RENT_FLOOR + total);
  assert.equal(lc.phase(s, nowTs()), 'funding');

  // a donation straight to the vault is not a contribution
  await env.execute(new Transaction().add(SystemProgram.transfer({ fromPubkey: settler.publicKey, toPubkey: c.vault, lamports: 12_345 })), [settler]);
  assert.equal(campaignState(c.campaign).totalContributed, total);

  // too early
  await expectError(run(await lc.settle({ connection: env.connection, programId, campaign: c.campaign }), [settler]), 6010);
  await expectError(run(await lc.refund({ programId, campaign: c.campaign, contributor: alice.publicKey }), [alice]), 6014);

  env.advance(100); // exactly closeTime
  assert.equal(lc.phase(campaignState(c.campaign), nowTs()), 'settleable');
  await expectError(run(await lc.contribute({ programId, campaign: c.campaign, contributor: alice.publicKey, amount: 1n }), [alice]), 6009);
  await expectError(run(await lc.withdraw({ programId, campaign: c.campaign, contributor: alice.publicKey, amount: 1n }), [alice]), 6009);
  await expectError(run(await lc.refund({ programId, campaign: c.campaign, contributor: alice.publicKey }), [alice]), 6014);

  const budgetBefore = lamports(c.budget);
  const built = await lc.settle({ connection: env.connection, programId, campaign: c.campaign });
  const res = await run(built, [settler]);
  measurements.settle = { bytes: res.bytes, computeUnits: res.compute, budgetSpentLamports: (budgetBefore - lamports(c.budget)).toString() };

  s = campaignState(c.campaign);
  assert.equal(s.state, lc.STATE.Settled);
  assert.ok(s.tokensBought >= c.minTokens);
  assert.ok(s.tokenAccount.equals(built.accounts.vaultTokenAccount));
  assert.equal(tokenAmount(built.accounts.vaultTokenAccount), s.tokensBought);
  assert.equal(tokenAmount(built.accounts.vaultWsolAccount), 0n);
  assert.equal(lamports(c.vault), RENT_FLOOR + 12_345n + (total - c.target));
  const pool = await client.state.getPool(built.accounts.pool);
  assert.ok(pool.poolState.creator.equals(beneficiary), 'pool creator is the published beneficiary');
  assert.equal(pool.poolState.quoteReserve.toString(), ((c.target * 99n) / 100n).toString(), 'exactly target, less the 1% fee, reached the curve');
  measurements.settle.tokensBought = s.tokensBought.toString();
  measurements.settle.minTokens = c.minTokens.toString();

  // settled is final
  await expectError(run(await lc.settle({ connection: env.connection, programId, campaign: c.campaign }), [settler]), 6013);
  await expectError(run(await lc.refund({ programId, campaign: c.campaign, contributor: alice.publicKey }), [alice]), 6013);

  // a claim cannot be redirected to someone else's token account
  const bobAta = getAssociatedTokenAddressSync(c.mint, bob.publicKey);
  await env.execute(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(bob.publicKey, bobAta, bob.publicKey, c.mint)), [bob]);
  const [aliceReceipt] = lc.deriveReceipt(programId, c.campaign, alice.publicKey);
  await expectError(env.execute(new Transaction().add(lc.instructions.claim({
    programId, contributor: alice.publicKey, campaign: c.campaign, vault: c.vault, receipt: aliceReceipt,
    campaignTokenAccount: built.accounts.vaultTokenAccount, contributorTokenAccount: bobAta,
  })), [alice]), 6019);
  // nor can one contributor use another's receipt
  await expectError(env.execute(new Transaction().add(lc.instructions.claim({
    programId, contributor: bob.publicKey, campaign: c.campaign, vault: c.vault, receipt: aliceReceipt,
    campaignTokenAccount: built.accounts.vaultTokenAccount, contributorTokenAccount: bobAta,
  })), [bob]), 6005);

  let tokensOut = 0n, excessOut = 0n;
  for (const [who, kp] of [['alice', alice], ['bob', bob], ['carol', carol]]) {
    const want = lc.allocation({ contribution: put[who], total, target: c.target, bought: s.tokensBought });
    const vaultBefore = lamports(c.vault);
    const claimed = await lc.claim({ programId, campaign: c.campaign, contributor: kp.publicKey });
    await run(claimed, [kp]);
    assert.equal(tokenAmount(claimed.tokenAccount), want.tokens, `${who} tokens`);
    assert.equal(vaultBefore - lamports(c.vault), want.excess, `${who} excess`);
    tokensOut += want.tokens; excessOut += want.excess;
    const [receipt] = lc.deriveReceipt(programId, c.campaign, kp.publicKey);
    assert.equal(env.account(receipt.toBase58()), null, 'receipt closed');
    // second claim has nothing to act on
    await expectError(run(await lc.claim({ programId, campaign: c.campaign, contributor: kp.publicKey }), [kp]), 6004);
  }
  s = campaignState(c.campaign);
  assert.equal(s.tokensClaimed, tokensOut);
  assert.equal(s.excessPaid, excessOut);
  assert.equal(s.receiptCount, 0n);
  assert.ok(tokensOut <= s.tokensBought && s.tokensBought - tokensOut < 3n);
  assert.ok(excessOut <= total - c.target && (total - c.target) - excessOut < 3n);
  assert.equal(tokenAmount(built.accounts.vaultTokenAccount), s.tokensBought - tokensOut);
  assert.equal(lamports(c.vault), RENT_FLOOR + 12_345n + (total - c.target) - excessOut);
});

test('underfunded: no settlement, every contributor refunds exactly their principal', async () => {
  const c = await newCampaign(2n);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: alice.publicKey, amount: 300_000_000n }), [alice]);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: bob.publicKey, amount: 699_999_999n }), [bob]);
  env.advance(99);
  await expectError(run(await lc.refund({ programId, campaign: c.campaign, contributor: alice.publicKey }), [alice]), 6014);
  env.advance(1);
  assert.equal(lc.phase(campaignState(c.campaign), nowTs()), 'refundable');
  await expectError(run(await lc.settle({ connection: env.connection, programId, campaign: c.campaign }), [settler]), 6011);

  for (const [kp, amount] of [[alice, 300_000_000n], [bob, 699_999_999n]]) {
    const before = lamports(c.vault);
    await run(await lc.refund({ programId, campaign: c.campaign, contributor: kp.publicKey }), [kp]);
    assert.equal(before - lamports(c.vault), amount);
    await expectError(run(await lc.refund({ programId, campaign: c.campaign, contributor: kp.publicKey }), [kp]), 6004);
  }
  const s = campaignState(c.campaign);
  assert.equal(s.refunded, 999_999_999n);
  assert.equal(s.receiptCount, 0n);
  assert.equal(lamports(c.vault), RENT_FLOOR);
  assert.equal(env.account(c.mint.toBase58()), null, 'no token was ever created');
});

test('funded but not settled before expiry: settlement closes, refunds open', async () => {
  const c = await newCampaign(3n);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: carol.publicKey, amount: 2n * SOL }), [carol]);
  env.advance(199);
  await expectError(run(await lc.refund({ programId, campaign: c.campaign, contributor: carol.publicKey }), [carol]), 6014);
  env.advance(1); // exactly expiry
  await expectError(run(await lc.settle({ connection: env.connection, programId, campaign: c.campaign }), [settler]), 6012);
  const before = lamports(c.vault);
  await run(await lc.refund({ programId, campaign: c.campaign, contributor: carol.publicKey }), [carol]);
  assert.equal(before - lamports(c.vault), 2n * SOL);
  assert.equal(lamports(c.vault), RENT_FLOOR);
});

test('settlement refuses substituted programs and accounts, then still works; pre-funded addresses do not block', async () => {
  // someone sends lamports to the campaign and receipt addresses before they exist
  const [futureCampaign] = lc.deriveCampaign(programId, organizer.publicKey, 4n);
  const [futureReceipt] = lc.deriveReceipt(programId, futureCampaign, alice.publicKey);
  for (const k of [futureCampaign, futureReceipt]) {
    await env.execute(new Transaction().add(SystemProgram.transfer({ fromPubkey: settler.publicKey, toPubkey: k, lamports: 1_000_000 })), [settler]);
  }
  const c = await newCampaign(4n);
  assert.ok(c.campaign.equals(futureCampaign));
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: alice.publicKey, amount: SOL }), [alice]);
  assert.equal(lc.decodeReceipt(env.account(futureReceipt.toBase58()).data).amount, SOL);
  env.advance(100);

  const other = await newCampaign(5n); // a second campaign whose PDAs are valid but foreign
  const good = lc.deriveSettlementAccounts(programId, c.campaign, configKey.publicKey);
  const attempt = (overrides, who = beneficiary) => env.execute(new Transaction().add(
    lc.instructions.settle({ programId, accounts: { ...good, ...overrides }, beneficiary: who })), [settler]);
  // any program the PDAs would sign for must be the real one
  await expectError(attempt({ dbcProgram: programId }), 6002);
  await expectError(attempt({ tokenProgram: programId }), 6002);
  await expectError(attempt({ associatedTokenProgram: programId }), 6002);
  await expectError(attempt({ metadataProgram: programId }), 6002);
  await expectError(attempt({ systemProgram: programId }), 6002);
  // foreign PDAs, a different beneficiary, a different quote mint
  await expectError(attempt({ vault: other.vault }), 6003);
  await expectError(attempt({ budget: other.budget }), 6003);
  await expectError(attempt({ mint: other.mint }), 6003);
  await expectError(attempt({}, alice.publicKey), 6005);
  await expectError(attempt({ wsolMint: c.mint }), 6005);
  await expectError(attempt({ poolAuthority: alice.publicKey }), 6005);
  // a campaign account that is not ours
  await expectError(attempt({ campaign: alice.publicKey }), 6004);
  assert.equal(campaignState(c.campaign).state, lc.STATE.Open, 'failed attempts changed nothing');
  assert.equal(lamports(c.vault), RENT_FLOOR + SOL);
  assert.equal(env.account(c.mint.toBase58()), null);

  // the honest settlement still goes through; total == target, so no excess
  await run(await lc.settle({ programId, campaign: c.campaign, config: configKey.publicKey, beneficiary }), [settler]);
  const s = campaignState(c.campaign);
  assert.equal(s.state, lc.STATE.Settled);
  assert.equal(lamports(c.vault), RENT_FLOOR);
  const claimed = await lc.claim({ programId, campaign: c.campaign, contributor: alice.publicKey });
  await run(claimed, [alice]);
  assert.equal(tokenAmount(claimed.tokenAccount), s.tokensBought, 'sole contributor receives every token');
  assert.equal(lamports(c.vault), RENT_FLOOR);
});

test('lamports sent early to settlement addresses, synced or not, do not block settlement', async () => {
  const c = await newCampaign(6n);
  const a = lc.deriveSettlementAccounts(programId, c.campaign, configKey.publicKey);
  const send = (to, amount) => SystemProgram.transfer({ fromPubkey: settler.publicKey, toPubkey: to, lamports: amount });
  // every account settlement will create, pre-funded by a stranger
  await env.execute(new Transaction().add(
    send(a.mint, 2_000_000), send(a.pool, 5_000_000), send(a.baseVault, 3_000_000), send(a.quoteVault, 3_000_000),
    send(a.metadata, 20_000_000), send(a.vaultTokenAccount, 3_000_000), send(c.budget, 1), send(c.vault, 7),
  ), [settler]);
  // the wrapped-SOL account created early, then given both a synced and an unsynced donation
  const syncNative = { programId: a.tokenProgram, keys: [{ pubkey: a.vaultWsolAccount, isSigner: false, isWritable: true }], data: Buffer.from([17]) };
  await env.execute(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(settler.publicKey, a.vaultWsolAccount, c.vault, lc.WSOL_MINT),
    send(a.vaultWsolAccount, 400_000), syncNative, send(a.vaultWsolAccount, 600_000),
  ), [settler]);
  assert.equal(tokenAmount(a.vaultWsolAccount), 400_000n, 'the second donation is not yet reflected');

  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: bob.publicKey, amount: 3n * SOL }), [bob]);
  env.advance(100);
  await run(await lc.settle({ programId, campaign: c.campaign, config: configKey.publicKey, beneficiary }), [settler]);
  const s = campaignState(c.campaign);
  assert.equal(s.state, lc.STATE.Settled);
  assert.ok(s.tokensBought >= c.minTokens);
  assert.equal(tokenAmount(a.vaultWsolAccount), 1_000_000n, 'donations remain; exactly the target was spent');
  assert.equal(lamports(c.vault), RENT_FLOOR + 7n + 2n * SOL);
  const pool = await client.state.getPool(a.pool);
  assert.equal(pool.poolState.quoteReserve.toString(), ((c.target * 99n) / 100n).toString());
});

test('forged program-owned accounts at non-canonical addresses are refused', async () => {
  const c = await newCampaign(7n);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: alice.publicKey, amount: SOL }), [alice]);
  const [receipt] = lc.deriveReceipt(programId, c.campaign, alice.publicKey);
  // The runtime never lets this happen; the local VM can. Copy real account bytes to
  // fresh addresses under the program's ownership.
  const forge = (from) => {
    const src = env.vm.getAccount(from.toBase58()), to = Keypair.generate().publicKey;
    env.vm.setAccount({ ...src, address: to.toBase58() });
    return to;
  };
  const fakeCampaign = forge(c.campaign), fakeReceipt = forge(receipt);
  assert.ok(env.account(fakeCampaign.toBase58()).owner.equals(programId));
  // a copied campaign, with the real vault
  await expectError(env.execute(new Transaction().add(lc.instructions.contribute({
    programId, contributor: alice.publicKey, campaign: fakeCampaign, vault: c.vault, receipt, amount: 1n,
  })), [alice]), 6003);
  // a copied receipt carrying a real balance
  await expectError(env.execute(new Transaction().add(lc.instructions.withdraw({
    programId, contributor: alice.publicKey, campaign: c.campaign, vault: c.vault, receipt: fakeReceipt, amount: 1n,
  })), [alice]), 6003);
  env.advance(100);
  env.advance(100);
  await expectError(env.execute(new Transaction().add(lc.instructions.refund({
    programId, contributor: alice.publicKey, campaign: c.campaign, vault: c.vault, receipt: fakeReceipt,
  })), [alice]), 6003);
  // the genuine receipt still refunds, once
  const before = lamports(c.vault);
  await run(await lc.refund({ programId, campaign: c.campaign, contributor: alice.publicKey }), [alice]);
  assert.equal(before - lamports(c.vault), SOL);
});

test('one-lamport contributions: allocated by the same floor rule, never more than owed', async () => {
  const c = await newCampaign(8n);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: alice.publicKey, amount: 1n }), [alice]);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: bob.publicKey, amount: 1n }), [bob]);
  await run(await lc.contribute({ programId, campaign: c.campaign, contributor: carol.publicKey, amount: SOL + 1n }), [carol]);
  env.advance(100);
  await run(await lc.settle({ programId, campaign: c.campaign, config: configKey.publicKey, beneficiary }), [settler]);
  const s = campaignState(c.campaign), total = SOL + 3n;
  let tokens = 0n, excess = 0n;
  for (const [kp, put] of [[alice, 1n], [bob, 1n], [carol, SOL + 1n]]) {
    const want = lc.allocation({ contribution: put, total, target: c.target, bought: s.tokensBought });
    const before = lamports(c.vault);
    const claimed = await lc.claim({ programId, campaign: c.campaign, contributor: kp.publicKey });
    await run(claimed, [kp]);
    assert.equal(tokenAmount(claimed.tokenAccount), want.tokens);
    assert.equal(before - lamports(c.vault), want.excess);
    tokens += want.tokens; excess += want.excess;
  }
  // 3 lamports of excess split 1 : 1 : 1e9+1 floors to 0 + 0 + 2; one lamport stays as dust
  assert.equal(excess, 2n);
  assert.equal(lamports(c.vault), RENT_FLOOR + 1n);
  assert.ok(s.tokensBought - tokens < 3n);
  assert.equal(tokenAmount(s.tokenAccount), s.tokensBought - tokens);
});

test('creation rejects unsupported terms', async () => {
  // a real DBC config that breaks the preset: half of migrated liquidity left unlocked
  const badKey = Keypair.generate();
  const bad = preset();
  bad.creatorPermanentLockedLiquidityPercentage = 50;
  bad.creatorLiquidityPercentage = 50;
  await env.execute(await client.partner.createConfig({
    config: badKey.publicKey, feeClaimer: organizer.publicKey, leftoverReceiver: organizer.publicKey,
    payer: organizer.publicKey, quoteMint: lc.WSOL_MINT, ...bad,
  }), [organizer, badKey]);
  const check = lc.checkConfigPreset(env.account(badKey.publicKey.toBase58()).data, SOL);
  assert.equal(check.ok, false);
  await expectError(newCampaign(10n, { config: badKey.publicKey }), 6007);

  // a real DBC config that hands 20% of supply to the leftover receiver
  const leftoverKey = Keypair.generate();
  const withLeftover = dbc.buildCurveWithMarketCap({
    token: { tokenType: 0, tokenBaseDecimal: 6, tokenQuoteDecimal: 9, tokenAuthorityOption: 1, totalTokenSupply: 1e9, leftover: 200_000_000 },
    fee: { baseFeeParams: { baseFeeMode: 0, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: 0, creatorTradingFeePercentage: 100, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: 1, migrationFeeOption: 2, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 100 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: 1, initialMarketCap: 3, migrationMarketCap: 55,
  });
  await env.execute(await client.partner.createConfig({
    config: leftoverKey.publicKey, feeClaimer: organizer.publicKey, leftoverReceiver: organizer.publicKey,
    payer: organizer.publicKey, quoteMint: lc.WSOL_MINT, ...withLeftover,
  }), [organizer, leftoverKey]);
  const leftoverData = env.account(leftoverKey.publicKey.toBase58()).data;
  const decodedLeftover = lc.decodeDbcConfig(leftoverData);
  assert.ok(decodedLeftover.unallocatedSupply * 5n >= decodedLeftover.postMigrationTokenSupply, 'about a fifth of supply is outside curve and pool');
  assert.equal(lc.checkConfigPreset(leftoverData, SOL).ok, false);
  await expectError(newCampaign(17n, { config: leftoverKey.publicKey }), 6007);

  // target at the migration threshold would end public trading before it starts
  const threshold = BigInt(measurements.migrationQuoteThreshold);
  const base = { programId, organizer: organizer.publicKey, beneficiary, config: configKey.publicKey, minTokens: 1n,
    closeTime: nowTs() + 10n, expiry: nowTs() + 20n, name: 'x', symbol: 'x', uri: 'x' };
  await expectError(run(await lc.createCampaign({ ...base, nonce: 11n, target: threshold }), [organizer]), 6007);
  // a wallet that is not a DBC config
  await expectError(run(await lc.createCampaign({ ...base, nonce: 12n, target: SOL, config: alice.publicKey }), [organizer]), 6004);
  // bad times and amounts
  await expectError(run(await lc.createCampaign({ ...base, nonce: 13n, target: SOL, closeTime: nowTs() }), [organizer]), 6006);
  await expectError(run(await lc.createCampaign({ ...base, nonce: 14n, target: SOL, expiry: base.closeTime }), [organizer]), 6006);
  await expectError(run(await lc.createCampaign({ ...base, nonce: 15n, target: 0n }), [organizer]), 6006);
  // the beneficiary cannot be one of the campaign's own addresses
  for (const nonce of [18n]) {
    const [campaign] = lc.deriveCampaign(programId, organizer.publicKey, nonce);
    for (const own of [campaign, lc.deriveVault(programId, campaign)[0], lc.deriveBudget(programId, campaign)[0], lc.deriveMint(programId, campaign)[0], PublicKey.default]) {
      await expectError(run(await lc.createCampaign({ ...base, nonce, target: SOL, beneficiary: own }), [organizer]), 6006);
    }
  }
  // under-funded setup budget, sent with the raw instruction because the builder refuses it
  const [campaign] = lc.deriveCampaign(programId, organizer.publicKey, 16n);
  const [vault] = lc.deriveVault(programId, campaign), [budget] = lc.deriveBudget(programId, campaign);
  await expectError(env.execute(new Transaction().add(lc.instructions.createCampaign({
    ...base, nonce: 16n, target: SOL, campaign, vault, budget, budgetLamports: lc.MIN_SETUP_BUDGET_LAMPORTS - 1n,
  })), [organizer]), 6020);
  // the same campaign address cannot be created twice
  await expectError(newCampaign(1n), 6005);
});

test.after(() => {
  fs.writeFileSync(path.resolve(__dirname, '../program/selftest-result.json'), JSON.stringify({
    scope: 'LiteSVM only; captured deployed DBC bytecode from ../fixtures; in-memory throwaway keys; no network',
    programSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(PROGRAM_SO)).digest('hex'),
    rentFloorLamports: RENT_FLOOR.toString(),
    minSetupBudgetLamports: lc.MIN_SETUP_BUDGET_LAMPORTS.toString(),
    ...measurements,
  }, null, 2) + '\n');
});
