// Launch commitments SDK. Builds unsigned transactions and decodes program accounts.
// No key management: every builder takes public keys and returns instructions only.
// Layouts and rules are specified in ../INTERFACE.md.
const crypto = require('node:crypto');
const { PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} = require('@solana/spl-token');
const dbc = require('@meteora-ag/dynamic-bonding-curve-sdk');

const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const TAG = Object.freeze({ CreateCampaign: 0, Contribute: 1, Withdraw: 2, Settle: 3, Claim: 4, Refund: 5 });
const STATE = Object.freeze({ Open: 1, Settled: 2 });
const CAMPAIGN_TAG = Buffer.from('LCCAMP01');
const RECEIPT_TAG = Buffer.from('LCRCPT01');
const CAMPAIGN_SIZE = 568;
const RECEIPT_SIZE = 88;
const CONFIG_SIZE = 1048;
const MIN_SETUP_BUDGET_LAMPORTS = 50_000_000n;
const DEFAULT_SETTLE_COMPUTE_UNITS = 400_000;
const POOL_CONFIG_DISCRIMINATOR = Buffer.from([26, 108, 14, 123, 116, 230, 129, 43]);
const REQUIRED_CLIFF_FEE_NUMERATOR = 10_000_000n;
const MAX_UNALLOCATED_SUPPLY_DIVISOR = 1_000n;

const ERRORS = Object.freeze({
  6000: 'InvalidInstructionData', 6001: 'MissingSignature', 6002: 'InvalidProgramId', 6003: 'InvalidPda',
  6004: 'InvalidAccountOwner', 6005: 'InvalidAccountData', 6006: 'InvalidTerms', 6007: 'ConfigNotSupported',
  6008: 'ConfigHashMismatch', 6009: 'FundingClosed', 6010: 'FundingStillOpen', 6011: 'TargetNotReached',
  6012: 'SettlementExpired', 6013: 'WrongState', 6014: 'RefundNotAvailable', 6015: 'InsufficientReceiptBalance',
  6016: 'MathOverflow', 6017: 'MinTokensNotMet', 6018: 'QuoteSpendMismatch', 6019: 'InvalidTokenAccount',
  6020: 'BudgetTooSmall', 6021: 'ZeroAmount', 6022: 'VaultInvariant',
});

// ---------------------------------------------------------------- argument checks

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

function key(v, name) {
  if (v instanceof PublicKey) return v;
  if (typeof v === 'string') return new PublicKey(v);
  throw new TypeError(`${name} must be a PublicKey or base58 string`);
}
function u64(v, name) {
  if (typeof v !== 'bigint') throw new TypeError(`${name} must be a bigint`);
  if (v < 0n || v > U64_MAX) throw new RangeError(`${name} is out of u64 range`);
  return v;
}
function i64(v, name) {
  if (typeof v !== 'bigint') throw new TypeError(`${name} must be a bigint`);
  if (v < -I64_MAX - 1n || v > I64_MAX) throw new RangeError(`${name} is out of i64 range`);
  return v;
}
function text(v, max, name) {
  if (typeof v !== 'string') throw new TypeError(`${name} must be a string`);
  const b = Buffer.from(v, 'utf8');
  if (b.length === 0 || b.length > max) throw new RangeError(`${name} must be 1..${max} bytes of UTF-8`);
  return b;
}
function u64le(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }
function i64le(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; }

// ---------------------------------------------------------------- derivation

function deriveCampaign(programId, organizer, nonce) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('campaign'), key(organizer, 'organizer').toBuffer(), u64le(u64(nonce, 'nonce'))],
    key(programId, 'programId'),
  );
}
function deriveVault(programId, campaign) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), key(campaign, 'campaign').toBuffer()], key(programId, 'programId'));
}
function deriveBudget(programId, campaign) {
  return PublicKey.findProgramAddressSync([Buffer.from('budget'), key(campaign, 'campaign').toBuffer()], key(programId, 'programId'));
}
function deriveMint(programId, campaign) {
  return PublicKey.findProgramAddressSync([Buffer.from('mint'), key(campaign, 'campaign').toBuffer()], key(programId, 'programId'));
}
function deriveReceipt(programId, campaign, contributor) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('receipt'), key(campaign, 'campaign').toBuffer(), key(contributor, 'contributor').toBuffer()],
    key(programId, 'programId'),
  );
}

/** Every address the Settle instruction needs, derived from the campaign and its config. */
function deriveSettlementAccounts(programId, campaign, config) {
  programId = key(programId, 'programId'); campaign = key(campaign, 'campaign'); config = key(config, 'config');
  const [vault] = deriveVault(programId, campaign);
  const [budget] = deriveBudget(programId, campaign);
  const [mint] = deriveMint(programId, campaign);
  const pool = dbc.deriveDbcPoolAddress(WSOL_MINT, mint, config);
  return {
    campaign, vault, budget, mint, config,
    poolAuthority: dbc.deriveDbcPoolAuthority(),
    pool,
    baseVault: dbc.deriveDbcTokenVaultAddress(pool, mint),
    quoteVault: dbc.deriveDbcTokenVaultAddress(pool, WSOL_MINT),
    metadata: dbc.deriveMintMetadata(mint),
    wsolMint: WSOL_MINT,
    vaultWsolAccount: getAssociatedTokenAddressSync(WSOL_MINT, vault, true),
    vaultTokenAccount: getAssociatedTokenAddressSync(mint, vault, true),
    eventAuthority: dbc.deriveDbcEventAuthority(),
    dbcProgram: DBC_PROGRAM_ID,
    metadataProgram: METADATA_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

// ---------------------------------------------------------------- decoding

function decodeCampaign(data) {
  data = Buffer.from(data);
  if (data.length !== CAMPAIGN_SIZE || !data.subarray(0, 8).equals(CAMPAIGN_TAG) || data[8] !== 1) {
    throw new Error('Not a launch-commitments campaign account');
  }
  const pk = (o) => new PublicKey(data.subarray(o, o + 32));
  const nameLen = data[14], symbolLen = data[15], uriLen = data[16];
  return {
    version: data[8],
    state: data[9],
    bumps: { campaign: data[10], vault: data[11], budget: data[12], mint: data[13] },
    organizer: pk(24),
    nonce: data.readBigUInt64LE(56),
    beneficiary: pk(64),
    config: pk(96),
    configHash: data.subarray(128, 160).toString('hex'),
    mint: pk(160),
    tokenAccount: pk(192),
    target: data.readBigUInt64LE(224),
    minTokens: data.readBigUInt64LE(232),
    closeTime: data.readBigInt64LE(240),
    expiry: data.readBigInt64LE(248),
    totalContributed: data.readBigUInt64LE(256),
    receiptCount: data.readBigUInt64LE(264),
    tokensBought: data.readBigUInt64LE(272),
    settledAt: data.readBigInt64LE(280),
    tokensClaimed: data.readBigUInt64LE(288),
    excessPaid: data.readBigUInt64LE(296),
    refunded: data.readBigUInt64LE(304),
    createdAt: data.readBigInt64LE(312),
    name: data.subarray(320, 320 + nameLen).toString('utf8'),
    symbol: data.subarray(352, 352 + symbolLen).toString('utf8'),
    uri: data.subarray(362, 362 + uriLen).toString('utf8'),
  };
}

function decodeReceipt(data) {
  data = Buffer.from(data);
  if (data.length !== RECEIPT_SIZE || !data.subarray(0, 8).equals(RECEIPT_TAG)) {
    throw new Error('Not a launch-commitments receipt account');
  }
  return {
    campaign: new PublicKey(data.subarray(8, 40)),
    contributor: new PublicKey(data.subarray(40, 72)),
    amount: data.readBigUInt64LE(72),
    bump: data[80],
  };
}

/** The DBC PoolConfig fields the preset constrains or the app must disclose. */
function decodeDbcConfig(data) {
  data = Buffer.from(data);
  if (data.length !== CONFIG_SIZE) throw new Error(`DBC config must be ${CONFIG_SIZE} bytes`);
  const pk = (o) => new PublicKey(data.subarray(o, o + 32));
  return {
    discriminator: data.subarray(0, 8).toString('hex'),
    quoteMint: pk(8),
    feeClaimer: pk(40),
    leftoverReceiver: pk(72),
    cliffFeeNumerator: data.readBigUInt64LE(104),
    secondFactor: data.readBigUInt64LE(112),
    thirdFactor: data.readBigUInt64LE(120),
    firstFactor: data.readUInt16LE(128),
    baseFeeMode: data[130],
    dynamicFeeInitialized: data[136],
    lpVestingZero: data.subarray(184, 216).every((b) => b === 0),
    collectFeeMode: data[232],
    migrationOption: data[233],
    activationType: data[234],
    tokenDecimal: data[235],
    tokenType: data[237],
    quoteTokenFlag: data[238],
    partnerPermanentLockedLiquidityPercentage: data[239],
    partnerLiquidityPercentage: data[240],
    creatorPermanentLockedLiquidityPercentage: data[241],
    creatorLiquidityPercentage: data[242],
    migrationFeeOption: data[243],
    fixedTokenSupplyFlag: data[244],
    creatorTradingFeePercentage: data[245],
    tokenUpdateAuthority: data[246],
    migrationFeePercentage: data[247],
    creatorMigrationFeePercentage: data[248],
    swapBaseAmount: data.readBigUInt64LE(256),
    migrationQuoteThreshold: data.readBigUInt64LE(264),
    migrationBaseThreshold: data.readBigUInt64LE(272),
    lockedVestingZero: data.subarray(296, 344).every((b) => b === 0),
    preMigrationTokenSupply: data.readBigUInt64LE(344),
    postMigrationTokenSupply: data.readBigUInt64LE(352),
    enableFirstSwapWithMinFee: data[365],
    poolCreationFee: data.readBigUInt64LE(368),
    // post-migration supply that is neither sold on the curve nor placed in the migrated
    // pool; DBC sends it to leftoverReceiver. Never negative here.
    unallocatedSupply: (() => {
      const rest = data.readBigUInt64LE(352) - data.readBigUInt64LE(256) - data.readBigUInt64LE(272);
      return rest > 0n ? rest : 0n;
    })(),
  };
}

/** Mirrors the on-chain preset check. The program remains the authority. */
function checkConfigPreset(data, target) {
  u64(target, 'target');
  data = Buffer.from(data);
  const violations = [];
  if (data.length !== CONFIG_SIZE) return { ok: false, violations: [`data length is ${data.length}, expected ${CONFIG_SIZE}`] };
  const c = decodeDbcConfig(data);
  const need = (cond, msg) => { if (!cond) violations.push(msg); };
  need(data.subarray(0, 8).equals(POOL_CONFIG_DISCRIMINATOR), 'not a plain PoolConfig account');
  need(c.quoteMint.equals(WSOL_MINT), 'quote mint must be wrapped SOL');
  need(c.cliffFeeNumerator === REQUIRED_CLIFF_FEE_NUMERATOR, 'trading fee must be exactly 1%');
  need(c.secondFactor === 0n && c.thirdFactor === 0n && c.firstFactor === 0, 'fee schedule must be flat');
  need(c.baseFeeMode === 0, 'base fee mode must be 0');
  need(c.dynamicFeeInitialized === 0, 'dynamic fee must be off');
  need(c.lpVestingZero, 'liquidity vesting must be unset');
  need(c.collectFeeMode === 0, 'fees must be collected in the quote token');
  need(c.migrationOption === 1, 'migration target must be DAMM v2');
  need(c.tokenType === 0, 'token must be a plain SPL token');
  need(c.quoteTokenFlag === 0, 'quote token must be a plain SPL token');
  need(c.partnerLiquidityPercentage === 0 && c.creatorLiquidityPercentage === 0, 'no unlocked migrated liquidity');
  need(c.partnerPermanentLockedLiquidityPercentage + c.creatorPermanentLockedLiquidityPercentage === 100, 'all migrated liquidity must be permanently locked');
  need(c.migrationFeeOption <= 5, 'migrated pool fee must be a fixed tier');
  need(c.fixedTokenSupplyFlag === 1, 'token supply must be fixed');
  need(c.tokenUpdateAuthority === 1, 'token metadata must be immutable');
  need(c.migrationFeePercentage === 0 && c.creatorMigrationFeePercentage === 0, 'migration fee must be 0%');
  need(c.lockedVestingZero, 'token vesting must be unset');
  need(c.enableFirstSwapWithMinFee === 0, 'first-swap fee discount must be off');
  need(c.poolCreationFee === 0n, 'pool creation fee must be 0');
  need(c.postMigrationTokenSupply > 0n && c.swapBaseAmount + c.migrationBaseThreshold > 0n, 'supply fields must be set');
  need(c.unallocatedSupply <= c.postMigrationTokenSupply / MAX_UNALLOCATED_SUPPLY_DIVISOR, 'more than 0.1% of supply is kept outside the curve and the migrated pool');
  need(c.migrationQuoteThreshold > target, 'target must be below the migration threshold');
  return { ok: violations.length === 0, violations };
}

function hashConfig(data) {
  return crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
}

/** 'funding' | 'settleable' | 'refundable' | 'settled', from a decoded campaign and a unix time. */
function phase(campaign, now) {
  i64(now, 'now');
  if (campaign.state === STATE.Settled) return 'settled';
  if (now < campaign.closeTime) return 'funding';
  if (now >= campaign.expiry || campaign.totalContributed < campaign.target) return 'refundable';
  return 'settleable';
}

/** Tokens and excess lamports owed to one receipt after settlement. Same arithmetic as the program. */
function allocation({ contribution, total, target, bought }) {
  u64(contribution, 'contribution'); u64(total, 'total'); u64(target, 'target'); u64(bought, 'bought');
  if (total < target || contribution > total || total === 0n) throw new RangeError('inconsistent allocation inputs');
  return { tokens: (contribution * bought) / total, excess: (contribution * (total - target)) / total };
}

// ---------------------------------------------------------------- instructions

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

const instructions = {
  createCampaign({ programId, organizer, campaign, vault, budget, beneficiary, config, nonce, target, minTokens, closeTime, expiry, budgetLamports, name, symbol, uri }) {
    const n = text(name, 32, 'name'), s = text(symbol, 10, 'symbol'), u = text(uri, 200, 'uri');
    const data = Buffer.concat([
      Buffer.from([TAG.CreateCampaign]),
      u64le(u64(nonce, 'nonce')), u64le(u64(target, 'target')), u64le(u64(minTokens, 'minTokens')),
      i64le(i64(closeTime, 'closeTime')), i64le(i64(expiry, 'expiry')), u64le(u64(budgetLamports, 'budgetLamports')),
      Buffer.from([n.length]), n, Buffer.from([s.length]), s, Buffer.from([u.length]), u,
    ]);
    return new TransactionInstruction({
      programId: key(programId, 'programId'),
      keys: [
        meta(key(organizer, 'organizer'), true, true),
        meta(key(campaign, 'campaign'), false, true),
        meta(key(vault, 'vault'), false, true),
        meta(key(budget, 'budget'), false, true),
        meta(key(beneficiary, 'beneficiary'), false, false),
        meta(key(config, 'config'), false, false),
        meta(SystemProgram.programId, false, false),
      ],
      data,
    });
  },

  contribute({ programId, contributor, campaign, vault, receipt, amount }) {
    return new TransactionInstruction({
      programId: key(programId, 'programId'),
      keys: fundingKeys(contributor, campaign, vault, receipt),
      data: Buffer.concat([Buffer.from([TAG.Contribute]), u64le(u64(amount, 'amount'))]),
    });
  },

  withdraw({ programId, contributor, campaign, vault, receipt, amount }) {
    return new TransactionInstruction({
      programId: key(programId, 'programId'),
      keys: fundingKeys(contributor, campaign, vault, receipt),
      data: Buffer.concat([Buffer.from([TAG.Withdraw]), u64le(u64(amount, 'amount'))]),
    });
  },

  /** `accounts` is the object returned by deriveSettlementAccounts, plus `beneficiary`. */
  settle({ programId, accounts: a, beneficiary }) {
    return new TransactionInstruction({
      programId: key(programId, 'programId'),
      keys: [
        meta(a.campaign, false, true),
        meta(a.vault, false, true),
        meta(a.budget, false, true),
        meta(a.mint, false, true),
        meta(key(beneficiary, 'beneficiary'), false, false),
        meta(a.config, false, false),
        meta(a.poolAuthority, false, false),
        meta(a.pool, false, true),
        meta(a.baseVault, false, true),
        meta(a.quoteVault, false, true),
        meta(a.metadata, false, true),
        meta(a.wsolMint, false, false),
        meta(a.vaultWsolAccount, false, true),
        meta(a.vaultTokenAccount, false, true),
        meta(a.eventAuthority, false, false),
        meta(a.dbcProgram, false, false),
        meta(a.metadataProgram, false, false),
        meta(a.tokenProgram, false, false),
        meta(a.associatedTokenProgram, false, false),
        meta(a.systemProgram, false, false),
      ],
      data: Buffer.from([TAG.Settle]),
    });
  },

  claim({ programId, contributor, campaign, vault, receipt, campaignTokenAccount, contributorTokenAccount }) {
    return new TransactionInstruction({
      programId: key(programId, 'programId'),
      keys: [
        meta(key(contributor, 'contributor'), true, true),
        meta(key(campaign, 'campaign'), false, true),
        meta(key(vault, 'vault'), false, true),
        meta(key(receipt, 'receipt'), false, true),
        meta(key(campaignTokenAccount, 'campaignTokenAccount'), false, true),
        meta(key(contributorTokenAccount, 'contributorTokenAccount'), false, true),
        meta(TOKEN_PROGRAM_ID, false, false),
        meta(SystemProgram.programId, false, false),
      ],
      data: Buffer.from([TAG.Claim]),
    });
  },

  refund({ programId, contributor, campaign, vault, receipt }) {
    return new TransactionInstruction({
      programId: key(programId, 'programId'),
      keys: fundingKeys(contributor, campaign, vault, receipt),
      data: Buffer.from([TAG.Refund]),
    });
  },
};

function fundingKeys(contributor, campaign, vault, receipt) {
  return [
    meta(key(contributor, 'contributor'), true, true),
    meta(key(campaign, 'campaign'), false, true),
    meta(key(vault, 'vault'), false, true),
    meta(key(receipt, 'receipt'), false, true),
    meta(SystemProgram.programId, false, false),
  ];
}

// ---------------------------------------------------------------- transaction builders

async function createCampaign({ programId, organizer, nonce, beneficiary, config, target, minTokens, closeTime, expiry, budgetLamports = MIN_SETUP_BUDGET_LAMPORTS, name, symbol, uri }) {
  programId = key(programId, 'programId'); organizer = key(organizer, 'organizer');
  const [campaign] = deriveCampaign(programId, organizer, nonce);
  const [vault] = deriveVault(programId, campaign);
  const [budget] = deriveBudget(programId, campaign);
  const [mint] = deriveMint(programId, campaign);
  if (u64(budgetLamports, 'budgetLamports') < MIN_SETUP_BUDGET_LAMPORTS) throw new RangeError('budgetLamports is below MIN_SETUP_BUDGET_LAMPORTS');
  const transaction = new Transaction().add(instructions.createCampaign({
    programId, organizer, campaign, vault, budget, beneficiary, config, nonce, target, minTokens, closeTime, expiry, budgetLamports, name, symbol, uri,
  }));
  return { transaction, campaign, vault, budget, mint };
}

async function contribute({ programId, campaign, contributor, amount }) {
  programId = key(programId, 'programId'); campaign = key(campaign, 'campaign'); contributor = key(contributor, 'contributor');
  const [vault] = deriveVault(programId, campaign);
  const [receipt] = deriveReceipt(programId, campaign, contributor);
  return { transaction: new Transaction().add(instructions.contribute({ programId, contributor, campaign, vault, receipt, amount })), receipt };
}

async function withdraw({ programId, campaign, contributor, amount }) {
  programId = key(programId, 'programId'); campaign = key(campaign, 'campaign'); contributor = key(contributor, 'contributor');
  const [vault] = deriveVault(programId, campaign);
  const [receipt] = deriveReceipt(programId, campaign, contributor);
  return { transaction: new Transaction().add(instructions.withdraw({ programId, contributor, campaign, vault, receipt, amount })), receipt };
}

async function settle({ connection, programId, campaign, config, beneficiary, computeUnitLimit = DEFAULT_SETTLE_COMPUTE_UNITS }) {
  programId = key(programId, 'programId'); campaign = key(campaign, 'campaign');
  if (!config || !beneficiary) {
    if (!connection) throw new TypeError('settle needs either {config, beneficiary} or a connection to read the campaign');
    const info = await connection.getAccountInfo(campaign);
    if (!info || !info.owner.equals(programId)) throw new Error('Campaign account not found for this program');
    const decoded = decodeCampaign(info.data);
    config = decoded.config; beneficiary = decoded.beneficiary;
  }
  const accounts = deriveSettlementAccounts(programId, campaign, key(config, 'config'));
  const transaction = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }))
    .add(instructions.settle({ programId, accounts, beneficiary }));
  return { transaction, accounts };
}

async function claim({ programId, campaign, contributor, createTokenAccount = true }) {
  programId = key(programId, 'programId'); campaign = key(campaign, 'campaign'); contributor = key(contributor, 'contributor');
  const [vault] = deriveVault(programId, campaign);
  const [mint] = deriveMint(programId, campaign);
  const [receipt] = deriveReceipt(programId, campaign, contributor);
  const campaignTokenAccount = getAssociatedTokenAddressSync(mint, vault, true);
  const tokenAccount = getAssociatedTokenAddressSync(mint, contributor, true);
  const transaction = new Transaction();
  if (createTokenAccount) transaction.add(createAssociatedTokenAccountIdempotentInstruction(contributor, tokenAccount, contributor, mint));
  transaction.add(instructions.claim({ programId, contributor, campaign, vault, receipt, campaignTokenAccount, contributorTokenAccount: tokenAccount }));
  return { transaction, tokenAccount };
}

async function refund({ programId, campaign, contributor }) {
  programId = key(programId, 'programId'); campaign = key(campaign, 'campaign'); contributor = key(contributor, 'contributor');
  const [vault] = deriveVault(programId, campaign);
  const [receipt] = deriveReceipt(programId, campaign, contributor);
  return { transaction: new Transaction().add(instructions.refund({ programId, contributor, campaign, vault, receipt })), receipt };
}

module.exports = {
  TAG, STATE, ERRORS, CAMPAIGN_SIZE, RECEIPT_SIZE, CONFIG_SIZE, MIN_SETUP_BUDGET_LAMPORTS,
  DBC_PROGRAM_ID, METADATA_PROGRAM_ID, WSOL_MINT,
  deriveCampaign, deriveVault, deriveBudget, deriveMint, deriveReceipt, deriveSettlementAccounts,
  decodeCampaign, decodeReceipt, decodeDbcConfig, checkConfigPreset, hashConfig, phase, allocation,
  instructions,
  createCampaign, contribute, withdraw, settle, claim, refund,
};
