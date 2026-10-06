// Browser port of ../runtime/devnet-server.cjs: the same routes, checks and response
// shapes, with the HTTP layer removed. Every account is read from an RPC node and every
// wallet transaction is prepared unsigned here, signed by the wallet, then simulated and
// sent from this page. Loaded on demand by devnet-api.mjs.
//
// This module never holds a wallet key and never signs for a user. The only keypairs it
// creates are throwaway address keys that an instruction requires as co-signers (the new
// DBC config account, the two DAMM v2 position NFT mints). They are generated per request,
// used for one partial signature and dropped. They control no funds.
import './buffer-global.mjs'; // keep first: the packages below read a global Buffer while loading
import { Buffer } from 'buffer';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, SendTransactionError } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import * as dbc from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import * as lc from './lc-browser.mjs';
import { deploymentInfo } from './deployment-browser.mjs';

// ---------------------------------------------------------------- configuration

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PUBLIC_GENESES = new Set([
  DEVNET_GENESIS,
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', // mainnet-beta
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', // testnet
]);
const MAX_PACKET = 1232;
const SETUP_BUDGET_LAMPORTS = 100_000_000n;
const SETTLEMENT_WINDOW_SECONDS = 600n;
const LAMPORTS_PER_SIGNATURE = 5000;
const PLACEHOLDER_URI = 'https://example.invalid/devnet-campaign.json';

export class ApiError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/** Same curve as ../runtime/preset.cjs. */
export function preset({ scale = 1 } = {}) {
  if (![1, 0.01].includes(scale)) throw Error('Unsupported test scale');
  return dbc.buildCurveWithMarketCap({
    token: { tokenType: 0, tokenBaseDecimal: 6, tokenQuoteDecimal: 9, tokenAuthorityOption: 1, totalTokenSupply: 1e9, leftover: 0 },
    fee: { baseFeeParams: { baseFeeMode: 0, feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 } }, dynamicFeeEnabled: false, collectFeeMode: 0, creatorTradingFeePercentage: 100, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: 1, migrationFeeOption: 2, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 100 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: 1, initialMarketCap: 3 * scale, migrationMarketCap: 55 * scale,
  });
}

/**
 * @param {object} config
 * @param {'devnet'|'validator'} config.network
 * @param {string} config.rpcUrl      https, or http on loopback. Anything in it is public in a static site.
 * @param {string} config.programId   the deployed launch-commitments program
 * @param {Function} [config.fetch]   transport override; defaults to the global fetch
 * @param {number} [config.stateDeploymentCacheMs] reuse a passed bytecode check for `state`
 *   and `environment` for this long. 0 (default) re-verifies on every call, as the server
 *   does. `prepare` and `send` always re-verify.
 */
export function createCore({
  network = 'devnet', rpcUrl, programId, fetch: transport,
  rpcTimeoutMs = 20_000, routeTimeoutMs = 30_000, confirmTimeoutMs = 60_000, pollIntervalMs = 600,
  stateDeploymentCacheMs = 0,
} = {}) {
  if (!['devnet', 'validator'].includes(network)) throw new ApiError(500, 'network must be "devnet" or "validator".');
  if (!programId) throw new ApiError(500, 'programId is required: the deployed launch-commitments program address.');
  let pid;
  try { pid = new PublicKey(programId); } catch { throw new ApiError(500, 'programId is not a valid address.'); }
  let rpcHost;
  try {
    const u = new URL(rpcUrl);
    rpcHost = u.host; // never echo the full URL: it can carry an API key
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (network === 'validator' && !loopback) throw new ApiError(500, 'network "validator" is only allowed with a loopback RPC URL.');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new ApiError(500, 'The RPC URL must use https.');
  } catch (e) { throw e instanceof ApiError ? e : new ApiError(500, 'rpcUrl is not a valid URL.'); }

  const request = transport || ((input, init) => globalThis.fetch(input, init));
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    fetch: (input, init) => request(input, { ...init, signal: AbortSignal.timeout(rpcTimeoutMs) }),
  });
  const dc = new dbc.DynamicBondingCurveClient(connection, 'confirmed');
  const cp = new CpAmm(connection);
  const scale = network === 'devnet' ? 0.01 : 1;

  // ---------------------------------------------------------------- cluster guard

  let cluster = null; // { genesisHash } once verified
  let lastDeployment = null; // { info, at } from the latest bytecode check that passed

  async function verifyDeployment(maxAgeMs) {
    if (maxAgeMs > 0 && lastDeployment && Date.now() - lastDeployment.at < maxAgeMs) return lastDeployment.info;
    lastDeployment = null;
    let info;
    try { info = await deploymentInfo(connection, pid); } catch (e) { throw new ApiError(503, e.message); }
    lastDeployment = { info, at: Date.now() };
    return info;
  }

  /** Refuse to do anything until the RPC node is the intended cluster and runs the reviewed program. */
  async function ensureCluster(maxAgeMs = 0) {
    if (!cluster) {
      let genesisHash;
      try { genesisHash = await connection.getGenesisHash(); } catch (e) { throw new ApiError(503, `RPC node unreachable: ${e.message}`); }
      if (network === 'devnet' && genesisHash !== DEVNET_GENESIS) {
        throw new ApiError(503, 'The RPC node is not Solana devnet. Refusing to serve requests.', { genesisHash });
      }
      if (network === 'validator' && PUBLIC_GENESES.has(genesisHash)) {
        throw new ApiError(503, 'network "validator" points at a public cluster. Refusing to serve requests.', { genesisHash });
      }
      const deployment = await verifyDeployment(0);
      cluster = { genesisHash };
      return { ...cluster, deployment };
    }
    return { ...cluster, deployment: await verifyDeployment(maxAgeMs) };
  }

  /** Chain time from the latest confirmed block; the Clock sysvar is the fallback. */
  async function chainClock() {
    const slot = await connection.getSlot('confirmed');
    for (let s = slot; s > slot - 4 && s >= 0; s--) {
      try { const t = await connection.getBlockTime(s); if (t) return { slot, now: BigInt(t) }; } catch { /* skipped or pruned slot */ }
    }
    const sysvar = await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'));
    if (!sysvar) throw new ApiError(503, 'Could not read chain time.');
    return { slot, now: sysvar.data.readBigInt64LE(32) };
  }

  // ---------------------------------------------------------------- helpers

  function parseAmount(value, decimals = 9) {
    if (typeof value !== 'string' || !new RegExp('^[0-9]+(?:\\.[0-9]{1,' + decimals + '})?$').test(value)) {
      throw new ApiError(400, 'Enter a positive decimal amount with at most ' + decimals + ' decimal places.');
    }
    const [a, b = ''] = value.split('.');
    const n = BigInt(a) * 10n ** BigInt(decimals) + BigInt(b.padEnd(decimals, '0'));
    if (n <= 0n || n > 18446744073709551615n) throw new ApiError(400, 'Amount is out of range.');
    return n;
  }
  function parseKey(value, name) {
    try { return new PublicKey(value); } catch { throw new ApiError(400, `${name} is not a valid address.`); }
  }
  function utf8Length(s) { return Buffer.byteLength(s, 'utf8'); }
  function sol(lamports) { const s = lamports.toString().padStart(10, '0'); return `${s.slice(0, -9)}.${s.slice(-9)}`.replace(/\.?0+$/, '') || '0'; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function manyAccounts(keys) {
    const out = [];
    for (let i = 0; i < keys.length; i += 100) out.push(...await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), 'confirmed'));
    return out;
  }

  async function readCampaign(campaign) {
    const info = await connection.getAccountInfo(campaign, 'confirmed');
    if (!info || !info.owner.equals(pid) || info.data.length !== lc.CAMPAIGN_SIZE) throw new ApiError(404, 'Campaign not found.');
    return lc.decodeCampaign(info.data);
  }

  // DBC virtual pool: is_migrated (u8) at 305 and finish_curve_timestamp (u64) at 344,
  // counted from the start of account data (state/virtual_pool.rs, program 0.2.1).
  function venueOf(poolInfo) {
    if (!poolInfo || !poolInfo.owner.equals(lc.DBC_PROGRAM_ID) || poolInfo.data.length < 352) return { venue: 'Unknown', canMigrate: false };
    if (poolInfo.data[305] === 1) return { venue: 'DAMM v2', canMigrate: false };
    if (poolInfo.data.readBigUInt64LE(344) > 0n) return { venue: 'Awaiting DAMM v2 migration', canMigrate: true };
    return { venue: 'DBC bonding curve', canMigrate: false };
  }

  // ---------------------------------------------------------------- state

  async function state(walletParam, deployment) {
    const person = walletParam ? parseKey(walletParam, 'wallet') : null;
    const { now } = await chainClock();
    const found = await connection.getProgramAccounts(pid, { commitment: 'confirmed', filters: [{ dataSize: lc.CAMPAIGN_SIZE }] });
    const decoded = [];
    for (const { pubkey, account } of found) {
      try { decoded.push({ address: pubkey, c: lc.decodeCampaign(account.data) }); } catch { /* not a campaign */ }
    }
    // one batched read for everything the list needs: config, pool, receipt, wallet token account
    const keys = [];
    for (const { address, c } of decoded) {
      keys.push(c.config, dbc.deriveDbcPoolAddress(lc.WSOL_MINT, c.mint, c.config));
      keys.push(person ? lc.deriveReceipt(pid, address, person)[0] : PublicKey.default);
      keys.push(person ? getAssociatedTokenAddressSync(c.mint, person, true) : PublicKey.default);
    }
    const infos = keys.length ? await manyAccounts(keys) : [];

    const campaigns = await Promise.all(decoded.map(async ({ address, c }, i) => {
      const [configInfo, poolInfo, receiptInfo, tokenInfo] = infos.slice(i * 4, i * 4 + 4);
      const phase = lc.phase(c, now);
      // the bound config: show what is on chain now, and whether it still matches the hash
      let cfg = null, configMatches = false, presetOk = false;
      if (configInfo && configInfo.owner.equals(lc.DBC_PROGRAM_ID) && configInfo.data.length === lc.CONFIG_SIZE) {
        cfg = lc.decodeDbcConfig(configInfo.data);
        configMatches = await lc.hashConfig(configInfo.data) === c.configHash;
        presetOk = lc.checkConfigPreset(configInfo.data, c.target).ok;
      }
      let receipt = null;
      if (person && receiptInfo && receiptInfo.owner.equals(pid)) { try { receipt = lc.decodeReceipt(receiptInfo.data); } catch { /* ignore */ } }
      const position = receipt ? { contribution: receipt.amount, tokens: 0n, excess: 0n } : null;
      if (position && phase === 'settled') {
        Object.assign(position, lc.allocation({ contribution: receipt.amount, total: c.totalContributed, target: c.target, bought: c.tokensBought }));
      }
      const { venue, canMigrate } = phase === 'settled' ? venueOf(poolInfo) : { venue: 'DBC bonding curve', canMigrate: false };
      const tokenOk = tokenInfo && tokenInfo.data.length === 165;
      return {
        address: address.toBase58(), name: c.name, symbol: c.symbol, uri: c.uri, organizer: c.organizer.toBase58(),
        target: c.target, total: c.totalContributed, closeTime: c.closeTime, expiry: c.expiry,
        progress: Number(c.totalContributed) * 100 / Number(c.target),
        status: phase,
        statusLabel: { funding: 'Funding open', settleable: 'Ready to launch', refundable: 'Refunds available', settled: 'Launched' }[phase],
        canContribute: phase === 'funding', canWithdraw: phase === 'funding', canSettle: phase === 'settleable', canRefund: phase === 'refundable',
        venue, canMigrate,
        positions: person && position ? { [person.toBase58()]: position } : {},
        walletTokenBalance: tokenOk ? tokenInfo.data.readBigUInt64LE(64) : 0n,
        tokensBought: c.tokensBought, tokensClaimed: c.tokensClaimed, receiptCount: c.receiptCount,
        config: c.config.toBase58(), configHash: c.configHash, configMatches, presetOk,
        mint: c.mint.toBase58(), beneficiary: c.beneficiary.toBase58(), minTokens: c.minTokens,
        decimals: cfg ? cfg.tokenDecimal : null,
        supply: cfg ? cfg.preMigrationTokenSupply : null,
        migrationThreshold: cfg ? cfg.migrationQuoteThreshold : null,
        creatorTradingFeePercentage: cfg ? cfg.creatorTradingFeePercentage : null,
        partnerFeeRecipient: cfg ? cfg.feeClaimer.toBase58() : null,
        leftoverReceiver: cfg ? cfg.leftoverReceiver.toBase58() : null,
        creatorLockedLiquidity: cfg ? cfg.creatorPermanentLockedLiquidityPercentage : null,
        partnerLockedLiquidity: cfg ? cfg.partnerPermanentLockedLiquidityPercentage : null,
      };
    }));
    campaigns.sort((a, b) => (a.closeTime < b.closeTime ? 1 : a.closeTime > b.closeTime ? -1 : 0));
    return {
      network, programId: pid.toBase58(),
      balance: person ? await connection.getBalance(person, 'confirmed') : 0,
      now, campaigns, deployment,
    };
  }

  async function environment({ genesisHash, deployment }) {
    const { slot, now } = await chainClock();
    const p = preset({ scale });
    return {
      network, rpcHost, genesisHash, programId: pid.toBase58(), slot, now, deployment,
      holdsWalletKeys: false, hasFaucet: network === 'validator', hasTimeControls: false,
      maxTransactionBytes: MAX_PACKET,
      preset: {
        decimals: p.tokenDecimal, supply: p.tokenSupply ? p.tokenSupply.preMigrationTokenSupply.toString() : null,
        migrationThreshold: p.migrationQuoteThreshold.toString(), creatorTradingFeePercentage: p.creatorTradingFeePercentage,
        setupBudgetLamports: SETUP_BUDGET_LAMPORTS, settlementWindowSeconds: SETTLEMENT_WINDOW_SECONDS,
      },
    };
  }

  // ---------------------------------------------------------------- prepare

  async function prepareCreate(data, wallet) {
    const target = parseAmount(data.target);
    const minutes = Number(data.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new ApiError(400, 'Choose a funding window from 1 to 1,440 minutes.');
    if (typeof data.name !== 'string' || utf8Length(data.name) < 1 || utf8Length(data.name) > 32) throw new ApiError(400, 'Name must be 1 to 32 bytes.');
    if (typeof data.symbol !== 'string' || utf8Length(data.symbol) < 1 || utf8Length(data.symbol) > 10) throw new ApiError(400, 'Symbol must be 1 to 10 bytes.');
    const uri = data.uri === undefined ? PLACEHOLDER_URI : data.uri;
    if (typeof uri !== 'string' || !/^https:\/\//.test(uri) || utf8Length(uri) > 200) throw new ApiError(400, 'Metadata link must be an https URL of at most 200 bytes.');

    const p = preset({ scale });
    if (target >= BigInt(p.migrationQuoteThreshold.toString())) throw new ApiError(400, 'The target must be below the preset’s migration threshold. Use a target below the displayed threshold.');
    const q = dc.pool.getQuoteFromInputAmount({ config: p, swapBaseForQuote: false, swapMode: 0, amountIn: new BN(target.toString()), slippageBps: 1 });
    const minTokens = BigInt(q.minimumAmountOut.toString());

    // The wallet is fee recipient, leftover receiver and beneficiary; it pays for everything.
    const configKey = Keypair.generate();
    const configTx = await dc.partner.createConfig({
      config: configKey.publicKey, feeClaimer: wallet, leftoverReceiver: wallet, payer: wallet, quoteMint: lc.WSOL_MINT, ...p,
    });
    let nonce, campaign;
    for (let i = 0; i < 4; i++) { // a random nonce collides only if this wallet already used it
      nonce = new DataView(globalThis.crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);
      campaign = lc.deriveCampaign(pid, wallet, nonce)[0];
      if (!await connection.getAccountInfo(campaign, 'confirmed')) break;
      campaign = null;
    }
    if (!campaign) throw new ApiError(503, 'Could not pick an unused campaign address. Try again.');
    const { now } = await chainClock();
    const built = await lc.createCampaign({
      programId: pid, organizer: wallet, beneficiary: wallet, config: configKey.publicKey, nonce, target, minTokens,
      closeTime: now + BigInt(minutes * 60), expiry: now + BigInt(minutes * 60) + SETTLEMENT_WINDOW_SECONDS,
      budgetLamports: SETUP_BUDGET_LAMPORTS, name: data.name, symbol: data.symbol, uri,
    });
    const transaction = new Transaction().add(...configTx.instructions, ...built.transaction.instructions);

    const [configRent, campaignRent, vaultFloor] = await Promise.all([
      connection.getMinimumBalanceForRentExemption(lc.CONFIG_SIZE),
      connection.getMinimumBalanceForRentExemption(lc.CAMPAIGN_SIZE),
      connection.getMinimumBalanceForRentExemption(0),
    ]);
    const networkFee = 2 * LAMPORTS_PER_SIGNATURE;
    const costs = {
      setupBudgetLamports: SETUP_BUDGET_LAMPORTS, configRentLamports: BigInt(configRent), campaignRentLamports: BigInt(campaignRent),
      vaultRentFloorLamports: BigInt(vaultFloor), networkFeeLamports: BigInt(networkFee),
    };
    costs.totalLamports = Object.values(costs).reduce((a, b) => a + b, 0n);
    return {
      transaction, extraSigners: [configKey], createdCampaign: campaign.toBase58(), createdConfig: configKey.publicKey.toBase58(), costs,
      title: 'Create campaign',
      summary: `Publish the launch terms and create this campaign’s own DBC configuration in one transaction. You pay about ${sol(costs.totalLamports)} SOL: a ${sol(SETUP_BUDGET_LAMPORTS)} SOL setup budget, ${sol(costs.configRentLamports + costs.campaignRentLamports + costs.vaultRentFloorLamports)} SOL of account rent and the network fee. None of it is recoverable in this version. You become the fee recipient and the pool creator.`,
      quoteDetails: { expectedTokens: (q.amountOut ?? q.outputAmount ?? q.minimumAmountOut).toString(), minimumTokens: q.minimumAmountOut.toString(), decimals: p.tokenDecimal },
    };
  }

  async function prepareTrade(data, wallet, c, now, slot) {
    const sell = data.direction === 'sell';
    if (!sell && data.direction !== 'buy') throw new ApiError(400, 'Direction must be "buy" or "sell".');
    const cfg = await dc.state.getPoolConfig(c.config);
    const decimals = cfg.tokenDecimal;
    const amount = parseAmount(data.amount, sell ? decimals : 9);
    const pool = dbc.deriveDbcPoolAddress(lc.WSOL_MINT, c.mint, c.config);
    const vp = await dc.state.getPool(pool);
    if (!vp) throw new ApiError(409, 'This campaign has not launched a pool yet.');
    const out = { decimals: sell ? 9 : decimals, symbol: sell ? 'SOL' : c.symbol };
    let transaction, quoteDetails;
    if (vp.poolState.isMigrated) {
      const dammConfig = dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption];
      const dp = dbc.deriveDammV2PoolAddress(dammConfig, c.mint, lc.WSOL_MINT);
      const ps = await cp.fetchPoolState(dp);
      const input = sell ? c.mint : lc.WSOL_MINT, output = sell ? lc.WSOL_MINT : c.mint;
      const q = cp.getQuote({ inAmount: new BN(amount.toString()), inputTokenMint: input, slippage: 0.5, poolState: ps, currentTime: Number(now), currentSlot: slot, tokenADecimal: decimals, tokenBDecimal: 9, hasReferral: false });
      quoteDetails = { minimumReceived: q.minSwapOutAmount.toString(), venue: 'DAMM v2', ...out };
      transaction = await cp.swap2({
        payer: wallet, pool: dp, inputTokenMint: input, outputTokenMint: output, tokenAMint: ps.tokenAMint, tokenBMint: ps.tokenBMint,
        tokenAVault: ps.tokenAVault, tokenBVault: ps.tokenBVault, tokenAProgram: getTokenProgram(ps.tokenAFlag), tokenBProgram: getTokenProgram(ps.tokenBFlag),
        poolState: ps, referralTokenAccount: null, swapMode: 0, amountIn: new BN(amount.toString()), minimumAmountOut: q.minSwapOutAmount,
      });
    } else {
      if (vp.poolState.finishCurveTimestamp.gt(new BN(0))) throw new ApiError(409, 'The curve is complete. Finish migration before trading.');
      const q = dc.pool.swapQuote2({ virtualPool: vp, config: cfg, swapBaseForQuote: sell, swapMode: 1, amountIn: new BN(amount.toString()), slippageBps: 50, hasReferral: false, currentPoint: new BN(now.toString()) });
      quoteDetails = { minimumReceived: q.minimumAmountOut.toString(), venue: 'DBC bonding curve', ...out };
      transaction = await dc.pool.swap2({ owner: wallet, pool, swapBaseForQuote: sell, swapMode: 1, amountIn: new BN(amount.toString()), minimumAmountOut: q.minimumAmountOut, referralTokenAccount: null });
    }
    return {
      transaction, quoteDetails, title: sell ? 'Sell tokens' : 'Buy tokens',
      summary: `Trade up to ${data.amount} ${sell ? c.symbol : 'SOL'} with a 0.5% slippage limit. This trade is outside the contribution round and can lose value.`,
    };
  }

  async function prepare(data) {
    if (!data || typeof data !== 'object') throw new ApiError(400, 'JSON request required.');
    const wallet = parseKey(data.wallet, 'wallet');
    let built;
    if (data.action === 'create') {
      built = await prepareCreate(data, wallet);
    } else {
      if (!data.campaign) throw new ApiError(400, 'Select a campaign first.');
      const campaign = parseKey(data.campaign, 'campaign');
      const c = await readCampaign(campaign);
      const common = { programId: pid, campaign, contributor: wallet };
      switch (data.action) {
        case 'contribute': {
          const amount = parseAmount(data.amount);
          built = { ...await lc.contribute({ ...common, amount }), title: 'Contribute SOL', summary: `Commit ${data.amount} SOL. You can withdraw before funding closes. Your final share depends on all contributions at close.` };
          break;
        }
        case 'withdraw': {
          const info = await connection.getAccountInfo(lc.deriveReceipt(pid, campaign, wallet)[0], 'confirmed');
          if (!info || !info.owner.equals(pid)) throw new ApiError(409, 'No contribution to withdraw.');
          const amount = data.amount === undefined ? lc.decodeReceipt(info.data).amount : parseAmount(data.amount);
          built = { ...await lc.withdraw({ ...common, amount }), title: 'Withdraw contribution', summary: 'Return your contribution before the funding window closes. A full withdrawal also returns the receipt rent.' };
          break;
        }
        case 'settle':
          built = { ...await lc.settle({ programId: pid, campaign, config: c.config, beneficiary: c.beneficiary }), title: 'Execute the launch', summary: 'Create the token and DBC pool, then spend exactly the published target. Contributors’ tokens and excess SOL become claimable. You pay only the network fee; the organizer’s separate budget pays setup rent.' };
          break;
        case 'claim':
          built = { ...await lc.claim(common), title: 'Claim allocation and excess', summary: 'Receive your proportional token allocation and any excess SOL. The program closes your contribution receipt, returns its rent and cannot pay it twice. If you have no token account for this token yet, you pay its rent.' };
          break;
        case 'refund':
          built = { ...await lc.refund(common), title: 'Recover contribution', summary: 'Return your full recorded contribution and receipt rent. Network fees paid for earlier transactions are not refundable. This action does not call Meteora.' };
          break;
        case 'migrate': {
          const pool = dbc.deriveDbcPoolAddress(lc.WSOL_MINT, c.mint, c.config);
          const cfg = await dc.state.getPoolConfig(c.config);
          const m = await dc.migration.migrateToDammV2({ pool, dammConfig: dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption], payer: wallet });
          built = { transaction: m.transaction, extraSigners: [m.firstPositionNftKeypair, m.secondPositionNftKeypair], title: 'Migrate to DAMM v2', summary: 'Create the successor liquidity pool using the published configuration. This caller pays migration account rent in addition to the network fee.' };
          break;
        }
        case 'trade': {
          const { now, slot } = await chainClock();
          built = await prepareTrade(data, wallet, c, now, slot);
          break;
        }
        default:
          throw new ApiError(400, 'Unknown action.');
      }
    }

    const tx = built.transaction;
    const extra = built.extraSigners || [];
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.feePayer = wallet;
    tx.recentBlockhash = blockhash;
    if (extra.length) tx.partialSign(...extra); // address co-signers only; the wallet signs after review
    // serialised with every signature slot present, so this is the real packet size
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    if (wire.length > MAX_PACKET) throw new ApiError(400, `Transaction is ${wire.length} bytes, over the ${MAX_PACKET}-byte packet limit. No funds were moved.`);
    return {
      transaction: wire.toString('base64'), title: built.title, summary: built.summary,
      note: `Sign with your own wallet on ${network === 'devnet' ? 'Solana devnet' : 'the local validator'}. This page never holds your key and has no server: the transaction is prepared in your browser and sent straight to the RPC node. Network fees and setup costs are separate from contributed principal.`,
      quoteDetails: built.quoteDetails, createdCampaign: built.createdCampaign, createdConfig: built.createdConfig, costs: built.costs,
      fee: LAMPORTS_PER_SIGNATURE * tx.signatures.length, bytes: wire.length, signaturesRequired: tx.signatures.length,
      blockhash, lastValidBlockHeight,
    };
  }

  // ---------------------------------------------------------------- send

  function programErrorName(logs) {
    const code = (logs || []).map((x) => x.match(/custom program error: 0x([0-9a-f]+)/)?.[1]).filter(Boolean).at(-1);
    return code ? lc.ERRORS[parseInt(code, 16)] || null : null;
  }

  /** Everything up to the broadcast call. A failure here means nothing left this page. */
  async function checkBeforeSending(data) {
    if (!data || typeof data.transaction !== 'string') throw new ApiError(400, 'A base64 signed transaction is required.');
    const bytes = Buffer.from(data.transaction, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_PACKET) throw new ApiError(400, `Transaction must be 1 to ${MAX_PACKET} bytes.`);
    let tx;
    try { tx = VersionedTransaction.deserialize(bytes); } catch { throw new ApiError(400, 'Not a valid Solana transaction.'); }
    if (tx.signatures.length === 0) throw new ApiError(400, 'Not a valid Solana transaction.');
    if (tx.signatures.some((s) => s.every((b) => b === 0))) throw new ApiError(400, 'The transaction is missing a signature. Sign it in your wallet first.');
    const signature = bs58.encode(tx.signatures[0]);

    await ensureCluster();
    const sim = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
    if (sim.value.err) {
      const logs = sim.value.logs || [];
      const name = programErrorName(logs);
      throw new ApiError(400, `${name ? name + ': ' : ''}Simulation failed, nothing was sent (${JSON.stringify(sim.value.err)}).`, { logs });
    }
    return { bytes, signature, sim };
  }

  /** Simulate, broadcast, then report only what the cluster actually says about the signature. */
  async function send(data) {
    let checked;
    try { checked = await checkBeforeSending(data); } catch (e) {
      if (e instanceof ApiError) { e.extra = { ...e.extra, status: 'rejected' }; throw e; }
      throw new ApiError(503, `Could not check the transaction, so nothing was sent: ${e.message}`, { status: 'rejected' });
    }
    const { bytes, signature, sim } = checked;

    // From here the transaction may be on its way. Only a status read from the cluster
    // can say how it ended; a lost reply is not a failure and not a success.
    let unacknowledged = false;
    try {
      await connection.sendRawTransaction(bytes, { skipPreflight: true, maxRetries: 3 });
    } catch (e) {
      if (e instanceof SendTransactionError) {
        // the node answered with an error instead of accepting the transaction
        throw new ApiError(400, `The RPC node refused the transaction and did not broadcast it (${e.transactionMessage || e.message}).`, { signature, status: 'rejected' });
      }
      unacknowledged = true; // no usable reply: the node may or may not have received it
    }
    const deadline = Date.now() + confirmTimeoutMs;
    while (Date.now() < deadline) {
      let st = null;
      try { st = (await connection.getSignatureStatuses([signature])).value[0]; } catch { /* keep asking until the deadline */ }
      if (st && st.err) {
        throw new ApiError(400, `The transaction landed and failed (${JSON.stringify(st.err)}).`, { signature, status: 'failed', slot: st.slot });
      }
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
        return { signature, ok: true, status: st.confirmationStatus, error: null, slot: st.slot, bytes: bytes.length, logs: sim.value.logs || [], compute: sim.value.unitsConsumed ?? null, simulated: { logs: true, compute: true } };
      }
      await sleep(pollIntervalMs);
    }
    // Not seen as confirmed and not seen as failed: say exactly that.
    return {
      signature, ok: false, status: 'unknown',
      error: `${unacknowledged ? 'The RPC node did not acknowledge the transaction, and it was not' : 'Not'} confirmed within the wait time. It may still land or expire; check the signature before retrying.`,
      bytes: bytes.length, logs: [], compute: null,
    };
  }

  async function faucet(data) {
    if (network !== 'validator') throw new ApiError(400, 'This page holds no funds. Get devnet SOL for your wallet from a devnet faucet, for example https://faucet.solana.com.');
    const wallet = parseKey(data.wallet, 'wallet');
    const signature = await connection.requestAirdrop(wallet, 10_000_000_000);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { value } = await connection.getSignatureStatuses([signature]);
      if (value[0]?.err) throw new ApiError(502, 'Local faucet transfer failed.');
      if (value[0] && ['confirmed', 'finalized'].includes(value[0].confirmationStatus)) return { ok: true, signature };
      await sleep(400);
    }
    throw new ApiError(504, 'Local faucet transfer was not confirmed.');
  }

  // ---------------------------------------------------------------- routes

  /** Reads and unsigned preparation have no side effects, so they can simply be given up on. */
  function bounded(work) {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new ApiError(504, 'The RPC node did not answer in time. Nothing was sent.')), routeTimeoutMs); });
    return Promise.race([work(), late]).finally(() => clearTimeout(timer));
  }

  /** `path` and `data` as the app passes them to its /api helper: GET without data, POST with. */
  async function handle(path, data) {
    const [route, query = ''] = String(path).split('?');
    const posted = data !== undefined && data !== null;
    if (!posted && route === 'state') {
      return bounded(async () => state(new URLSearchParams(query).get('wallet'), (await ensureCluster(stateDeploymentCacheMs)).deployment));
    }
    if (!posted && route === 'environment') return bounded(async () => environment(await ensureCluster(stateDeploymentCacheMs)));
    if (!['prepare', 'send', 'faucet', 'advance'].includes(route)) throw new ApiError(404, 'Route not found.');
    if (!posted || typeof data !== 'object') throw new ApiError(400, 'JSON request required.');
    if (route === 'send') return send(data); // bounded by its own confirmation wait; never abandoned
    if (route === 'advance') throw new ApiError(404, 'There are no time controls on a real cluster. Wait for the funding window to close.');
    if (route === 'faucet') { await ensureCluster(); return faucet(data); } // has its own confirmation wait
    return bounded(async () => { await ensureCluster(); return prepare(data); });
  }

  return { handle, network, programId: pid.toBase58(), rpcHost };
}
