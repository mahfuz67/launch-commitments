// HTTP integration test for runtime/devnet-server.cjs against a LOCAL validator.
// It never contacts a public cluster. Wallets are throwaway keypairs generated in memory
// and funded by the local validator's faucet through the server's /api/faucet route.
//
// Needs a running local validator with the launch-commitments, DBC, DAMM v2 and Metaplex
// programs loaded. Defaults match the one Codex started:
//   LAUNCH_RPC_URL=http://127.0.0.1:18899
//   DEVNET_PROGRAM_ID=4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD
// Run from work/launch-commitments:  node tests/devnet-api.cjs
// Takes a little over a minute: it waits for a real one-minute funding window to close.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Keypair, Transaction } = require('@solana/web3.js');

const RPC = process.env.LAUNCH_RPC_URL || 'http://127.0.0.1:18899';
const PROGRAM = process.env.DEVNET_PROGRAM_ID || Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require('node:fs').readFileSync('program/build/launch_commitments-keypair.json')))).publicKey.toBase58();
const PORT = Number(process.env.TEST_API_PORT || 19190);
const GUARD_PORT = PORT + 2;
const SERVER = path.resolve(__dirname, '../runtime/devnet-server.cjs');
const API = `http://127.0.0.1:${PORT}`;
const SOL = 1_000_000_000n;

if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(RPC)) { console.error('This test only runs against a loopback validator.'); process.exit(1); }

const children = [];
function start(env, port) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, DEVNET_PROGRAM_ID: PROGRAM, LAUNCH_RPC_URL: RPC, LAUNCH_API_PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  children.push(child);
  return child;
}
async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return await fetch(url); } catch { if (Date.now() > end) throw new Error('Server did not start: ' + url); await new Promise((r) => setTimeout(r, 200)); }
  }
}
async function call(method, route, body, headers = {}) {
  const res = await fetch(API + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, json, text, headers: res.headers };
}
const get = (route, headers) => call('GET', route, null, headers);
const post = (route, body, headers) => call('POST', route, body, headers);
async function ok(promise, what) { const r = await promise; assert.equal(r.status, 200, `${what}: HTTP ${r.status} ${r.text}`); return r.json; }

function sign(base64, ...signers) {
  const tx = Transaction.from(Buffer.from(base64, 'base64'));
  tx.partialSign(...signers);
  return tx.serialize().toString('base64');
}
/** prepare -> sign with the wallet -> send, and require a confirmed result. */
async function act(wallet, body, what) {
  const prepared = await ok(post('/api/prepare', { wallet: wallet.publicKey.toBase58(), ...body }), `prepare ${what}`);
  assert.ok(prepared.bytes <= 1232);
  const sent = await ok(post('/api/send', { transaction: sign(prepared.transaction, wallet) }), `send ${what}`);
  assert.equal(sent.ok, true); assert.equal(sent.error, null);
  assert.ok(['confirmed', 'finalized'].includes(sent.status), `${what} status ${sent.status}`);
  return { prepared, sent };
}
async function campaignFor(wallet, address) {
  const s = await ok(get('/api/state?wallet=' + wallet.publicKey.toBase58()), 'state');
  const c = s.campaigns.find((x) => x.address === address);
  assert.ok(c, 'campaign listed');
  return { state: s, c, mine: c.positions[wallet.publicKey.toBase58()] || null };
}

async function main() {
  const evidence = {};

  // ---- guards that need no cluster traffic beyond the local validator
  const refused = spawnSync(process.execPath, [SERVER], { env: { ...process.env, DEVNET_PROGRAM_ID: PROGRAM, LAUNCH_NETWORK: 'validator', LAUNCH_RPC_URL: 'https://api.devnet.solana.com', LAUNCH_API_PORT: String(GUARD_PORT) }, encoding: 'utf8', timeout: 10000 });
  assert.equal(refused.status, 1, 'validator mode with a public URL must refuse to start');
  assert.match(refused.stderr, /loopback/);
  const noProgram = spawnSync(process.execPath, [SERVER], { env: { ...process.env, DEVNET_PROGRAM_ID: '', LAUNCH_RPC_URL: RPC }, encoding: 'utf8', timeout: 10000 });
  assert.equal(noProgram.status, 1); assert.match(noProgram.stderr, /DEVNET_PROGRAM_ID/);

  // devnet mode pointed at a node that is not devnet: every route refuses
  start({ LAUNCH_NETWORK: 'devnet' }, GUARD_PORT);
  const guarded = await waitFor(`http://127.0.0.1:${GUARD_PORT}/api/state`);
  assert.equal(guarded.status, 503);
  assert.match((await guarded.json()).error, /not Solana devnet/);
  const guardedPrepare = await fetch(`http://127.0.0.1:${GUARD_PORT}/api/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(guardedPrepare.status, 503);
  evidence.genesisGuard = 'devnet mode refused a non-devnet node with 503 on state and prepare';

  // ---- the server under test, in validator mode
  start({ LAUNCH_NETWORK: 'validator' }, PORT);
  await waitFor(API + '/api/environment');
  const env = await ok(get('/api/environment'), 'environment');
  assert.equal(env.network, 'validator'); assert.equal(env.programId, PROGRAM);
  assert.equal(env.holdsWalletKeys, false); assert.equal(env.hasTimeControls, false);
  assert.ok(!JSON.stringify(env).includes('18899/'), 'only the RPC host is exposed');
  evidence.environment = { genesisHash: env.genesisHash, rpcHost: env.rpcHost, preset: env.preset };

  // origins
  assert.equal((await get('/api/environment', { Origin: 'http://evil.example' })).status, 403);
  const allowed = await get('/api/environment', { Origin: 'http://127.0.0.1:5181' });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5181');
  assert.equal((await get('/api/environment', { Origin: 'http://localhost:5181' })).status, 200);
  assert.equal((await post('/api/advance', { campaign: PROGRAM })).status, 404, 'no time controls');
  assert.equal((await get('/api/nope')).status, 404);

  const organizer = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate(), carol = Keypair.generate();
  for (const k of [organizer, alice, bob, carol]) await ok(post('/api/faucet', { wallet: k.publicKey.toBase58() }), 'faucet');
  const me = organizer.publicKey.toBase58();

  // ---- create: config + campaign in one transaction, wallet-signed
  const bad = await post('/api/prepare', { wallet: me, action: 'create', target: '0', minutes: 1, name: 'x', symbol: 'x' });
  assert.equal(bad.status, 400);
  assert.equal((await post('/api/prepare', { wallet: me, action: 'create', target: '1', minutes: 0, name: 'x', symbol: 'x' })).status, 400);
  assert.equal((await post('/api/prepare', { wallet: me, action: 'create', target: '1000', minutes: 1, name: 'x', symbol: 'x' })).status, 400, 'target above threshold');
  assert.equal((await post('/api/prepare', { wallet: 'not-a-key', action: 'create', target: '1', minutes: 1, name: 'x', symbol: 'x' })).status, 400);

  const before = (await ok(get('/api/state?wallet=' + me), 'state')).balance;
  const createA = await ok(post('/api/prepare', { wallet: me, action: 'create', target: '1', minutes: 1, name: 'HTTP test launch', symbol: 'HTTP' }), 'prepare create');
  assert.equal(createA.signaturesRequired, 2, 'wallet plus the new config address');
  assert.ok(createA.bytes <= 1232, `create is ${createA.bytes} bytes`);
  const unsignedTx = Transaction.from(Buffer.from(createA.transaction, 'base64'));
  assert.equal(unsignedTx.feePayer.toBase58(), me);
  assert.equal(unsignedTx.signatures[0].signature, null, 'the server did not sign for the wallet');
  assert.ok(unsignedTx.signatures[1].signature, 'the throwaway config address co-signed');
  assert.equal(unsignedTx.signatures[1].publicKey.toBase58(), createA.createdConfig);
  assert.ok(BigInt(createA.costs.totalLamports) > 100_000_000n);

  // sending it without the wallet signature is refused before any broadcast
  const unsigned = await post('/api/send', { transaction: createA.transaction });
  assert.equal(unsigned.status, 400); assert.match(unsigned.json.error, /missing a signature/);
  // a signature from the wrong key fails verification in simulation
  const forged = Transaction.from(Buffer.from(createA.transaction, 'base64'));
  forged.signatures[0].signature = Buffer.alloc(64, 7);
  const forgedRes = await post('/api/send', { transaction: forged.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') });
  assert.equal(forgedRes.status, 400);
  assert.equal((await post('/api/send', { transaction: Buffer.alloc(1233).toString('base64') })).status, 400);
  assert.equal((await post('/api/send', { transaction: Buffer.from('junk').toString('base64') })).status, 400);

  const sentA = await ok(post('/api/send', { transaction: sign(createA.transaction, organizer) }), 'send create');
  assert.equal(sentA.ok, true); assert.ok(['confirmed', 'finalized'].includes(sentA.status));
  const A = createA.createdCampaign;
  const after = (await ok(get('/api/state?wallet=' + me), 'state')).balance;
  assert.equal(BigInt(before) - BigInt(after), BigInt(createA.costs.totalLamports), 'disclosed creation cost equals what the wallet paid');
  evidence.create = { bytes: createA.bytes, computeSimulated: sentA.compute, costLamports: createA.costs.totalLamports, quote: createA.quoteDetails };

  let { c } = await campaignFor(organizer, A);
  assert.equal(c.status, 'funding'); assert.equal(c.name, 'HTTP test launch'); assert.equal(c.symbol, 'HTTP');
  assert.equal(c.target, SOL.toString()); assert.equal(c.total, '0');
  assert.equal(c.organizer, me); assert.equal(c.beneficiary, me); assert.equal(c.partnerFeeRecipient, me); assert.equal(c.leftoverReceiver, me);
  assert.equal(c.config, createA.createdConfig); assert.equal(c.configMatches, true); assert.equal(c.presetOk, true);
  assert.equal(c.decimals, env.preset.decimals); assert.equal(c.supply, env.preset.supply);
  assert.equal(c.migrationThreshold, env.preset.migrationThreshold); assert.equal(c.creatorTradingFeePercentage, env.preset.creatorTradingFeePercentage);
  assert.equal(c.minTokens, createA.quoteDetails.minimumTokens);
  assert.equal(BigInt(c.expiry) - BigInt(c.closeTime), 600n, 'ten-minute settlement window');
  assert.match(c.configHash, /^[0-9a-f]{64}$/);

  // a second campaign that will stay underfunded
  const createB = await act(organizer, { action: 'create', target: '5', minutes: 1, name: 'Underfunded', symbol: 'UNDER' }, 'create B');
  const B = createB.prepared.createdCampaign;
  assert.notEqual(createB.prepared.createdConfig, createA.createdConfig, 'each campaign gets its own config');

  // ---- contribute, withdraw, and the failures a user can hit
  await act(alice, { action: 'contribute', campaign: A, amount: '0.8' }, 'alice contributes');
  await act(bob, { action: 'contribute', campaign: A, amount: '0.6' }, 'bob contributes');
  await act(bob, { action: 'contribute', campaign: B, amount: '0.3' }, 'bob contributes to B');
  let view = await campaignFor(alice, A);
  assert.equal(view.c.total, (14n * SOL / 10n).toString()); assert.equal(view.mine.contribution, (8n * SOL / 10n).toString());
  assert.equal(view.c.canContribute, true); assert.equal(view.c.canSettle, false);
  await act(bob, { action: 'withdraw', campaign: A, amount: '0.1' }, 'bob partial withdraw');
  view = await campaignFor(bob, A);
  assert.equal(view.mine.contribution, (5n * SOL / 10n).toString()); assert.equal(view.c.total, (13n * SOL / 10n).toString());
  assert.equal((await campaignFor(carol, A)).mine, null, 'no position for a wallet that did not contribute');

  assert.equal((await post('/api/prepare', { wallet: carol.publicKey.toBase58(), action: 'withdraw', campaign: A })).status, 409);
  assert.equal((await post('/api/prepare', { wallet: me, action: 'contribute', campaign: A, amount: '-1' })).status, 400);
  assert.equal((await post('/api/prepare', { wallet: me, action: 'contribute', campaign: me, amount: '1' })).status, 404);
  assert.equal((await post('/api/prepare', { wallet: me, action: 'explode', campaign: A })).status, 400);
  // launching early: the program refuses in simulation, nothing is broadcast, the reason is named
  const early = await ok(post('/api/prepare', { wallet: carol.publicKey.toBase58(), action: 'settle', campaign: A }), 'prepare early settle');
  const earlyRes = await post('/api/send', { transaction: sign(early.transaction, carol) });
  assert.equal(earlyRes.status, 400); assert.match(earlyRes.json.error, /FundingStillOpen/); assert.equal(earlyRes.json.status, 'rejected');
  const earlyRefund = await ok(post('/api/prepare', { wallet: bob.publicKey.toBase58(), action: 'refund', campaign: B }), 'prepare early refund');
  assert.match((await post('/api/send', { transaction: sign(earlyRefund.transaction, bob) })).json.error, /RefundNotAvailable/);
  evidence.fundingChecks = 'create, contribute, partial withdraw, state and failure cases passed';

  // ---- wait for the real funding window to close
  const closeTime = BigInt(view.c.closeTime);
  const waitStart = Date.now();
  for (;;) {
    const s = await ok(get('/api/state'), 'state');
    if (BigInt(s.now) >= closeTime + 1n) break;
    assert.ok(Date.now() - waitStart < 120000, 'funding window did not close in time');
    await new Promise((r) => setTimeout(r, 2000));
  }
  evidence.waitedSeconds = Math.round((Date.now() - waitStart) / 1000);
  assert.equal((await campaignFor(alice, A)).c.status, 'settleable');
  assert.equal((await campaignFor(bob, B)).c.status, 'refundable');
  const late = await ok(post('/api/prepare', { wallet: alice.publicKey.toBase58(), action: 'contribute', campaign: A, amount: '0.1' }), 'prepare late contribute');
  assert.match((await post('/api/send', { transaction: sign(late.transaction, alice) })).json.error, /FundingClosed/);

  // ---- launch by a stranger, claims, a public trade, and the refund
  const settled = await act(carol, { action: 'settle', campaign: A }, 'settle');
  evidence.settle = { bytes: settled.prepared.bytes, computeSimulated: settled.sent.compute };
  view = await campaignFor(alice, A);
  assert.equal(view.c.status, 'settled'); assert.equal(view.c.venue, 'DBC bonding curve'); assert.equal(view.c.canMigrate, false);
  assert.ok(BigInt(view.c.tokensBought) >= BigInt(view.c.minTokens));
  const total = 13n * SOL / 10n, bought = BigInt(view.c.tokensBought);
  assert.equal(view.mine.tokens, ((8n * SOL / 10n) * bought / total).toString());
  assert.equal(view.mine.excess, ((8n * SOL / 10n) * (total - SOL) / total).toString());
  await act(alice, { action: 'claim', campaign: A }, 'alice claims');
  view = await campaignFor(alice, A);
  assert.equal(view.mine, null, 'receipt closed after claim');
  assert.equal(view.c.walletTokenBalance, ((8n * SOL / 10n) * bought / total).toString(), 'tokens are in the wallet');
  const again = await ok(post('/api/prepare', { wallet: alice.publicKey.toBase58(), action: 'claim', campaign: A }), 'prepare second claim');
  assert.equal((await post('/api/send', { transaction: sign(again.transaction, alice) })).status, 400, 'a second claim is refused');
  await act(bob, { action: 'claim', campaign: A }, 'bob claims');

  const trade = await act(carol, { action: 'trade', campaign: A, direction: 'buy', amount: '0.2' }, 'public buy on the curve');
  assert.ok(BigInt(trade.prepared.quoteDetails.minimumReceived) > 0n); assert.equal(trade.prepared.quoteDetails.venue, 'DBC bonding curve');
  assert.ok(BigInt((await campaignFor(carol, A)).c.walletTokenBalance) >= BigInt(trade.prepared.quoteDetails.minimumReceived));
  const notReady = await ok(post('/api/prepare', { wallet: carol.publicKey.toBase58(), action: 'migrate', campaign: A }), 'prepare migrate');
  assert.equal(notReady.signaturesRequired, 3, 'wallet plus two position NFT addresses');
  assert.equal((await post('/api/send', { transaction: sign(notReady.transaction, carol) })).status, 400, 'migration before the curve completes is refused');

  // ---- graduation, migration with co-signed position addresses, then a DAMM v2 trade
  // Local validator only: top up the trader and DBC's pool authority, which pays migration rent.
  await ok(post('/api/faucet', { wallet: carol.publicKey.toBase58() }), 'faucet');
  await ok(post('/api/faucet', { wallet: 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM' }), 'faucet pool authority');
  await act(carol, { action: 'trade', campaign: A, direction: 'buy', amount: '11' }, 'buy through the migration threshold');
  view = await campaignFor(carol, A);
  assert.equal(view.c.venue, 'Awaiting DAMM v2 migration'); assert.equal(view.c.canMigrate, true);
  assert.equal((await post('/api/prepare', { wallet: carol.publicKey.toBase58(), action: 'trade', campaign: A, direction: 'buy', amount: '0.1' })).status, 409, 'no trading between completion and migration');
  const migrated = await act(carol, { action: 'migrate', campaign: A }, 'migrate');
  assert.equal(migrated.prepared.signaturesRequired, 3);
  view = await campaignFor(alice, A);
  assert.equal(view.c.venue, 'DAMM v2'); assert.equal(view.c.canMigrate, false);
  const sale = await act(alice, { action: 'trade', campaign: A, direction: 'sell', amount: '1000' }, 'sell on DAMM v2');
  assert.equal(sale.prepared.quoteDetails.venue, 'DAMM v2'); assert.equal(sale.prepared.quoteDetails.symbol, 'SOL');
  assert.ok(BigInt(sale.prepared.quoteDetails.minimumReceived) > 0n);
  assert.equal(BigInt(view.c.walletTokenBalance) - BigInt((await campaignFor(alice, A)).c.walletTokenBalance), 1000n * 1_000_000n, 'exactly the sold amount left the wallet');
  evidence.migration = { bytes: migrated.prepared.bytes, computeSimulated: migrated.sent.compute, dammSaleBytes: sale.prepared.bytes };

  const bobBefore = BigInt((await campaignFor(bob, B)).state.balance);
  const refund = await act(bob, { action: 'refund', campaign: B }, 'bob refunds');
  const bobAfter = BigInt((await campaignFor(bob, B)).state.balance);
  assert.ok(bobAfter - bobBefore >= 3n * SOL / 10n - BigInt(refund.prepared.fee), 'principal returned, plus receipt rent, less the network fee');
  assert.equal((await campaignFor(bob, B)).mine, null);
  evidence.lifecycle = 'settle by a stranger, two claims, a DBC buy, graduation, migration, a DAMM v2 sale and an underfunded refund all confirmed over HTTP';

  console.log(JSON.stringify({ passed: true, network: 'local validator only', rpc: new URL(RPC).host, programId: PROGRAM, ...evidence }, null, 2));
}

main().then(
  () => { children.forEach((c) => c.kill()); },
  (e) => { console.error(e.stack || e); for (const c of children) { console.error('--- server output\n' + c.output); c.kill(); } process.exitCode = 1; },
);
