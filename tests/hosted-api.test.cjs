// The browser adapter (app/devnet-api.mjs) driven end to end against the real program
// bytecode in LiteSVM, through the JSON-RPC wire protocol. Wallets are throwaway test
// keys that exist only in this process; the adapter itself never sees one. The lifecycle
// test also runs runtime/devnet-server.cjs on the same chain and requires both to answer
// identically. Nothing here contacts a public cluster.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Keypair, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const { createRpc } = require('./hosted-rpc.cjs');

const SOL = 1_000_000_000n;
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (rpc, method) => rpc.calls.filter((m) => m === method).length;

async function boot({ rpc: rpcOptions, ...options } = {}) {
  const rpc = createRpc(rpcOptions);
  const { createDevnetApi } = await import('../app/devnet-api.mjs');
  const api = createDevnetApi({ programId: rpc.programId, fetch: rpc.fetch, confirmTimeoutMs: 400, pollIntervalMs: 10, ...options });
  return { rpc, api };
}
function sign(base64, ...signers) {
  const tx = Transaction.from(Buffer.from(base64, 'base64'));
  tx.partialSign(...signers);
  return tx.serialize().toString('base64');
}
/** prepare -> sign with the test wallet -> send, and require a confirmed result. */
async function act(api, wallet, body, what) {
  const prepared = await api('prepare', { wallet: wallet.publicKey.toBase58(), ...body });
  assert.ok(prepared.bytes <= 1232, what);
  const sent = await api('send', { transaction: sign(prepared.transaction, wallet) });
  assert.equal(sent.ok, true, what); assert.equal(sent.error, null);
  assert.equal(sent.status, 'confirmed', what);
  return { prepared, sent };
}
/** The call must throw the app-facing error: a message, an HTTP-like status and a JSON body. */
async function refused(promise, pattern, status) {
  let error;
  try { await promise; } catch (e) { error = e; }
  assert.ok(error, `expected a refusal matching ${pattern}`);
  assert.match(error.message, pattern);
  if (status) assert.equal(error.status, status, error.message);
  assert.equal(error.result.error, error.message);
  assert.ok(Array.isArray(error.result.logs));
  assert.deepEqual(JSON.parse(JSON.stringify(error.result)), error.result);
  return error;
}
async function campaignFor(api, wallet, address) {
  const state = await api('state?wallet=' + wallet.publicKey.toBase58());
  const c = state.campaigns.find((x) => x.address === address);
  assert.ok(c, 'campaign listed');
  return { state, c, mine: c.positions[wallet.publicKey.toBase58()] || null };
}
/** A funded campaign and a signed contribution that has not been sent yet. */
async function readyToSend(options) {
  const { rpc, api } = await boot(options);
  const organizer = rpc.fund(Keypair.generate()), alice = rpc.fund(Keypair.generate());
  const { prepared } = await act(api, organizer, { action: 'create', target: '0.02', minutes: '1', name: 'Confirm', symbol: 'CNF' }, 'create');
  const campaign = prepared.createdCampaign;
  const contribution = await api('prepare', { wallet: alice.publicKey.toBase58(), action: 'contribute', campaign, amount: '0.01' });
  const transaction = sign(contribution.transaction, alice);
  const signature = bs58.encode(Transaction.from(Buffer.from(transaction, 'base64')).signature);
  rpc.calls.length = 0;
  return { rpc, api, organizer, alice, campaign, transaction, signature };
}

// ---------------------------------------------------------------- the server, for comparison

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function startServer(rpcUrl, programId) {
  const port = await freePort(), base = `http://127.0.0.1:${port}/api/`;
  const child = spawn(process.execPath, [path.resolve(__dirname, '../runtime/devnet-server.cjs')], {
    env: { ...process.env, DEVNET_PROGRAM_ID: programId, LAUNCH_NETWORK: 'devnet', LAUNCH_RPC_URL: rpcUrl, LAUNCH_API_PORT: String(port) }, stdio: 'ignore',
  });
  for (let i = 0; ; i++) {
    try { await fetch(base + 'environment'); break; } catch (e) { if (i > 100) { child.kill(); throw new Error('devnet-server did not start'); } await sleep(100); }
  }
  return {
    stop: () => child.kill(),
    async call(route, data) {
      const r = await fetch(base + route, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
      return { status: r.status, body: await r.json() };
    },
  };
}

// ---------------------------------------------------------------- lifecycle and parity

test('full lifecycle through the browser adapter, answering exactly as the server does', async (t) => {
  const rpc = createRpc();
  const node = await rpc.listen();
  const server = await startServer(node.url, rpc.programId);
  t.after(() => { server.stop(); node.close(); });
  // the adapter reaches the same node over real HTTP with the default transport
  const { createDevnetApi } = await import('../app/devnet-api.mjs');
  const api = createDevnetApi({ programId: rpc.programId, rpcUrl: node.url, confirmTimeoutMs: 5000, pollIntervalMs: 10 });

  const organizer = rpc.fund(Keypair.generate()), alice = rpc.fund(Keypair.generate()), bob = rpc.fund(Keypair.generate()), carol = rpc.fund(Keypair.generate());
  const me = organizer.publicKey.toBase58(), addressOf = (k) => k.publicKey.toBase58();
  let compared = 0;
  /** Same request to the server and to the adapter: same status, same JSON. */
  async function agree(route, data, strip = (x) => x) {
    const fromServer = await server.call(route, data);
    let fromPage;
    try { fromPage = { status: 200, body: await api(route, data) }; } catch (e) { fromPage = { status: e.status, body: e.result }; }
    assert.deepEqual(strip(fromPage.body), strip(fromServer.body), `${route} ${JSON.stringify(data || '')}`);
    assert.equal(fromPage.status, fromServer.status, route);
    compared++;
    return fromPage;
  }
  const withoutCheckTime = (x) => ({ ...x, deployment: { ...x.deployment, checkedAt: null } });
  const withoutNote = ({ note, ...x }) => { assert.ok(!x.error || !note); return x; };
  const withoutNewKeys = ({ note, transaction, createdCampaign, createdConfig, ...x }) => x;
  async function checkpoint() {
    await agree('state', null, withoutCheckTime);
    for (const k of [organizer, alice, bob, carol]) await agree('state?wallet=' + addressOf(k), null, withoutCheckTime);
  }

  const env = (await agree('environment', null, withoutCheckTime)).body;
  assert.equal(env.network, 'devnet'); assert.equal(env.programId, rpc.programId);
  assert.equal(env.holdsWalletKeys, false); assert.equal(env.hasFaucet, false); assert.equal(env.hasTimeControls, false);
  assert.equal(env.deployment.sha256, '1e8d66705b2ee91c504552fb7e55cf26fb046d54aec26e0aed54e1c48b9e6e4b');
  assert.equal(env.rpcHost, new URL(node.url).host);
  await checkpoint();

  // ---- create: config + campaign in one transaction, signed only by the wallet
  const create = { wallet: me, action: 'create', target: '0.02', minutes: '1', name: 'Hosted test launch', symbol: 'HOST', uri: 'https://example.invalid/hosted.json', amount: '1' };
  for (const bad of [{ target: '0' }, { target: '1.0000000001' }, { minutes: '0' }, { minutes: '1.5' }, { minutes: '1441' }, { target: '1000' }, { wallet: 'not-a-key' }, { name: '' }, { name: 'x'.repeat(33) }, { symbol: 'x'.repeat(11) }, { uri: 'http://example.invalid/x.json' }, { uri: 'https://example.invalid/' + 'x'.repeat(200) }]) {
    assert.equal((await agree('prepare', { ...create, ...bad })).status, 400, JSON.stringify(bad));
  }
  await agree('prepare', create, withoutNewKeys);
  const before = BigInt((await api('state?wallet=' + me)).balance);
  const createA = await api('prepare', create);
  assert.equal(createA.signaturesRequired, 2, 'wallet plus the new config address');
  const unsignedTx = Transaction.from(Buffer.from(createA.transaction, 'base64'));
  assert.equal(unsignedTx.feePayer.toBase58(), me);
  assert.equal(unsignedTx.signatures[0].signature, null, 'the adapter did not sign for the wallet');
  assert.ok(unsignedTx.signatures[1].signature, 'the throwaway config address co-signed');
  assert.equal(unsignedTx.signatures[1].publicKey.toBase58(), createA.createdConfig);
  assert.equal(JSON.stringify(createA).includes('secret'), false);
  assert.match(createA.note, /never holds your key/);
  assert.ok(BigInt(createA.costs.totalLamports) > 100_000_000n);

  // without the wallet signature, or with a forged one, nothing reaches the cluster
  const sends = count(rpc, 'sendTransaction');
  let e = await refused(api('send', { transaction: createA.transaction }), /missing a signature/, 400);
  assert.equal(e.result.status, 'rejected');
  const forged = Transaction.from(Buffer.from(createA.transaction, 'base64'));
  forged.signatures[0].signature = Buffer.alloc(64, 7);
  e = await refused(api('send', { transaction: forged.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }), /nothing was sent.*signature verification/);
  assert.equal(e.result.status, 'rejected');
  assert.equal((await refused(api('send', { transaction: Buffer.alloc(1233).toString('base64') }), /1 to 1232 bytes/, 400)).result.status, 'rejected');
  assert.equal((await refused(api('send', { transaction: Buffer.from('junk').toString('base64') }), /Not a valid Solana transaction/, 400)).result.status, 'rejected');
  assert.equal((await refused(api('send', {}), /base64 signed transaction is required/, 400)).result.status, 'rejected');
  assert.equal(count(rpc, 'sendTransaction'), sends, 'no refused transaction was broadcast');

  const sentA = await api('send', { transaction: sign(createA.transaction, organizer) });
  assert.equal(sentA.ok, true); assert.equal(sentA.status, 'confirmed');
  assert.deepEqual(sentA.simulated, { logs: true, compute: true });
  assert.ok(sentA.compute > 0 && sentA.logs.length > 0 && sentA.bytes === createA.bytes);
  assert.equal(sentA.signature, bs58.encode(Transaction.from(Buffer.from(sign(createA.transaction, organizer), 'base64')).signature));
  const A = createA.createdCampaign;
  assert.equal(before - BigInt((await api('state?wallet=' + me)).balance), BigInt(createA.costs.totalLamports), 'disclosed creation cost equals what the wallet paid');

  let { c } = await campaignFor(api, organizer, A);
  assert.equal(c.status, 'funding'); assert.equal(c.name, 'Hosted test launch'); assert.equal(c.symbol, 'HOST'); assert.equal(c.uri, create.uri);
  assert.equal(c.target, (SOL / 50n).toString()); assert.equal(c.total, '0'); assert.equal(c.progress, 0);
  assert.equal(c.organizer, me); assert.equal(c.beneficiary, me); assert.equal(c.partnerFeeRecipient, me); assert.equal(c.leftoverReceiver, me);
  assert.equal(c.config, createA.createdConfig); assert.equal(c.configMatches, true); assert.equal(c.presetOk, true);
  assert.equal(c.decimals, env.preset.decimals); assert.equal(c.supply, env.preset.supply);
  assert.equal(c.migrationThreshold, env.preset.migrationThreshold); assert.equal(c.creatorTradingFeePercentage, env.preset.creatorTradingFeePercentage);
  assert.equal(c.minTokens, createA.quoteDetails.minimumTokens);
  assert.equal(BigInt(c.expiry) - BigInt(c.closeTime), 600n, 'ten-minute settlement window');
  assert.match(c.configHash, /^[0-9a-f]{64}$/);

  // a second campaign that will stay underfunded; the metadata link may be omitted
  const { uri, ...createB } = { ...create, target: '0.05', name: 'Underfunded', symbol: 'UNDER' };
  const B = (await act(api, organizer, createB, 'create B')).prepared.createdCampaign;
  assert.notEqual((await campaignFor(api, organizer, B)).c.config, c.config, 'each campaign gets its own config');

  // ---- contribute, withdraw, and the failures a user can hit
  await act(api, alice, { action: 'contribute', campaign: A, amount: '0.016' }, 'alice contributes');
  await act(api, bob, { action: 'contribute', campaign: A, amount: '0.012' }, 'bob contributes');
  await act(api, bob, { action: 'contribute', campaign: B, amount: '0.003' }, 'bob contributes to B');
  await act(api, bob, { action: 'withdraw', campaign: A, amount: '0.002' }, 'bob partial withdraw');
  let view = await campaignFor(api, bob, A);
  assert.equal(view.mine.contribution, (SOL / 100n).toString()); assert.equal(view.c.total, (26n * SOL / 1000n).toString());
  assert.equal(view.c.progress, 130); assert.equal(view.c.canContribute, true); assert.equal(view.c.canSettle, false);
  assert.equal((await campaignFor(api, carol, A)).mine, null, 'no position for a wallet that did not contribute');
  await checkpoint();

  const funding = (wallet, body) => ({ wallet: addressOf(wallet), campaign: A, ...body });
  for (const [request, status] of [
    [funding(carol, { action: 'withdraw' }), 409], [funding(alice, { action: 'contribute', amount: '-1' }), 400], [funding(alice, { action: 'contribute', amount: 1 }), 400],
    [{ wallet: me, action: 'contribute', campaign: me, amount: '1' }, 404], [funding(alice, { action: 'explode' }), 400], [{ wallet: me, action: 'contribute', amount: '1' }, 400],
    [funding(alice, { action: 'trade', direction: 'up', amount: '1' }), 400], [funding(alice, { action: 'trade', direction: 'buy', amount: '0.001' }), 409],
  ]) assert.equal((await agree('prepare', request)).status, status, JSON.stringify(request));
  for (const [who, action, amount] of [[alice, 'contribute', '0.001'], [alice, 'withdraw'], [bob, 'withdraw', '0.001'], [carol, 'settle'], [alice, 'claim'], [bob, 'refund']]) {
    const same = await agree('prepare', funding(who, { action, amount }), withoutNote);
    assert.equal(same.status, 200, action); // identical unsigned bytes, fee, size and blockhash from both
  }

  // launching early: the program refuses in simulation, nothing is broadcast, the reason is named
  const early = sign((await api('prepare', funding(carol, { action: 'settle' }))).transaction, carol);
  e = await refused(api('send', { transaction: early }), /FundingStillOpen: Simulation failed, nothing was sent/, 400);
  assert.equal(e.result.status, 'rejected'); assert.ok(e.result.logs.some((l) => l.includes('custom program error')));
  assert.equal((await agree('send', { transaction: early })).status, 400);
  const earlyRefund = sign((await api('prepare', { wallet: addressOf(bob), action: 'refund', campaign: B })).transaction, bob);
  await refused(api('send', { transaction: earlyRefund }), /RefundNotAvailable/, 400);

  // ---- the funding window closes
  rpc.advance(61);
  assert.equal((await campaignFor(api, alice, A)).c.status, 'settleable');
  assert.equal((await campaignFor(api, bob, B)).c.status, 'refundable');
  await checkpoint();
  const late = sign((await api('prepare', funding(alice, { action: 'contribute', amount: '0.001' }))).transaction, alice);
  await refused(api('send', { transaction: late }), /FundingClosed/, 400);

  // ---- launch by a stranger, claims, a public trade
  const settled = await act(api, carol, { action: 'settle', campaign: A }, 'settle');
  assert.equal(settled.prepared.signaturesRequired, 1);
  view = await campaignFor(api, alice, A);
  assert.equal(view.c.status, 'settled'); assert.equal(view.c.venue, 'DBC bonding curve'); assert.equal(view.c.canMigrate, false);
  assert.ok(BigInt(view.c.tokensBought) >= BigInt(view.c.minTokens));
  const total = 26n * SOL / 1000n, target = SOL / 50n, mine = 16n * SOL / 1000n, bought = BigInt(view.c.tokensBought);
  assert.equal(view.mine.tokens, (mine * bought / total).toString());
  assert.equal(view.mine.excess, (mine * (total - target) / total).toString());
  await checkpoint();
  await agree('prepare', funding(alice, { action: 'claim' }), withoutNote);
  await act(api, alice, { action: 'claim', campaign: A }, 'alice claims');
  view = await campaignFor(api, alice, A);
  assert.equal(view.mine, null, 'receipt closed after claim');
  assert.equal(view.c.walletTokenBalance, (mine * bought / total).toString(), 'tokens are in the wallet');
  const again = sign((await api('prepare', funding(alice, { action: 'claim' }))).transaction, alice);
  assert.equal((await refused(api('send', { transaction: again }), /Simulation failed/, 400)).result.status, 'rejected');
  await act(api, bob, { action: 'claim', campaign: A }, 'bob claims');

  for (const direction of ['buy', 'sell']) await agree('prepare', funding(alice, { action: 'trade', direction, amount: '0.002' }), withoutNote);
  const trade = await act(api, carol, { action: 'trade', campaign: A, direction: 'buy', amount: '0.002' }, 'public buy on the curve');
  assert.ok(BigInt(trade.prepared.quoteDetails.minimumReceived) > 0n); assert.equal(trade.prepared.quoteDetails.venue, 'DBC bonding curve');
  assert.equal(trade.prepared.quoteDetails.symbol, 'HOST'); assert.equal(trade.prepared.quoteDetails.decimals, 6);
  assert.ok(BigInt((await campaignFor(api, carol, A)).c.walletTokenBalance) >= BigInt(trade.prepared.quoteDetails.minimumReceived));
  const notReady = await api('prepare', funding(carol, { action: 'migrate' }));
  assert.equal(notReady.signaturesRequired, 3, 'wallet plus two position NFT addresses');
  await refused(api('send', { transaction: sign(notReady.transaction, carol) }), /Simulation failed/, 400);

  // ---- graduation, migration with co-signed position addresses, then a DAMM v2 trade
  await act(api, carol, { action: 'trade', campaign: A, direction: 'buy', amount: '0.2' }, 'buy through the migration threshold');
  view = await campaignFor(api, carol, A);
  assert.equal(view.c.venue, 'Awaiting DAMM v2 migration'); assert.equal(view.c.canMigrate, true);
  assert.equal((await agree('prepare', funding(carol, { action: 'trade', direction: 'buy', amount: '0.001' }))).status, 409, 'no trading between completion and migration');
  await checkpoint();
  await agree('prepare', funding(carol, { action: 'migrate' }), withoutNewKeys);
  const migration = await api('prepare', funding(carol, { action: 'migrate' }));
  const migrationTx = Transaction.from(Buffer.from(migration.transaction, 'base64'));
  assert.equal(migrationTx.signatures[0].signature, null, 'the wallet has not signed yet');
  assert.ok(migrationTx.signatures[1].signature && migrationTx.signatures[2].signature, 'both position addresses co-signed');
  assert.equal((await api('send', { transaction: sign(migration.transaction, carol) })).status, 'confirmed');
  view = await campaignFor(api, alice, A);
  assert.equal(view.c.venue, 'DAMM v2'); assert.equal(view.c.canMigrate, false);
  await checkpoint();
  for (const direction of ['buy', 'sell']) await agree('prepare', funding(alice, { action: 'trade', direction, amount: '0.5' }), withoutNote);
  const sale = await act(api, alice, { action: 'trade', campaign: A, direction: 'sell', amount: '1000' }, 'sell on DAMM v2');
  assert.equal(sale.prepared.quoteDetails.venue, 'DAMM v2'); assert.equal(sale.prepared.quoteDetails.symbol, 'SOL'); assert.equal(sale.prepared.quoteDetails.decimals, 9);
  assert.ok(BigInt(sale.prepared.quoteDetails.minimumReceived) > 0n);
  assert.equal(BigInt(view.c.walletTokenBalance) - BigInt((await campaignFor(api, alice, A)).c.walletTokenBalance), 1000n * 1_000_000n, 'exactly the sold amount left the wallet');

  // ---- the underfunded campaign refunds
  const bobBefore = BigInt((await campaignFor(api, bob, B)).state.balance);
  const refund = await act(api, bob, { action: 'refund', campaign: B }, 'bob refunds');
  const bobAfter = BigInt((await campaignFor(api, bob, B)).state.balance);
  assert.ok(bobAfter - bobBefore >= 3n * SOL / 1000n - BigInt(refund.prepared.fee), 'principal returned, plus receipt rent, less the network fee');
  assert.equal((await campaignFor(api, bob, B)).mine, null);
  await checkpoint();

  // a send through the server and one through the adapter report the same fields
  const viaServer = await server.call('send', { transaction: sign((await api('prepare', { wallet: addressOf(carol), action: 'trade', campaign: A, direction: 'buy', amount: '0.001' })).transaction, carol) });
  const viaPage = (await act(api, carol, { action: 'trade', campaign: A, direction: 'buy', amount: '0.001' }, 'DAMM buy')).sent;
  assert.equal(viaServer.status, 200);
  assert.deepEqual(Object.keys(viaPage).sort(), Object.keys(viaServer.body).sort());
  for (const name of ['ok', 'status', 'error', 'simulated']) assert.deepEqual(viaPage[name], viaServer.body[name], name);

  // routes that exist only for the local rehearsal answer as the server does
  assert.equal((await agree('advance', { campaign: A, to: 'close' })).status, 404);
  assert.equal((await agree('nope', {})).status, 404);
  assert.equal((await agree('prepare', null)).status, 400, 'a GET to a POST route');
  assert.ok(compared > 70, `${compared} responses compared with the server`);
});

// ---------------------------------------------------------------- honest confirmation

test('a transaction the cluster never reports is returned as unknown, not confirmed and not failed', async () => {
  const { rpc, api, alice, campaign, transaction, signature } = await readyToSend();
  rpc.fault('getSignatureStatuses', () => ({ result: rpc.withContext([null]) }));
  const r = await api('send', { transaction });
  assert.deepEqual({ ok: r.ok, status: r.status, signature: r.signature, compute: r.compute, logs: r.logs }, { ok: false, status: 'unknown', signature, compute: null, logs: [] });
  assert.match(r.error, /^Not confirmed within the wait time\. It may still land or expire/);
  assert.equal(count(rpc, 'sendTransaction'), 1, 'broadcast once, never resubmitted by the adapter');
  assert.ok(count(rpc, 'getSignatureStatuses') > 3, 'kept asking until the deadline');
  rpc.fault('getSignatureStatuses');
  assert.equal((await campaignFor(api, alice, campaign)).mine.contribution, '10000000', 'it had in fact landed: unknown was the only honest answer');
});

test('a transaction that lands and fails is reported as failed with its signature', async () => {
  const { rpc, api, organizer, campaign } = await readyToSend();
  const early = sign((await api('prepare', { wallet: organizer.publicKey.toBase58(), action: 'settle', campaign })).transaction, organizer);
  // a node whose simulation wrongly passes: only the landed result may decide the outcome
  rpc.fault('simulateTransaction', () => ({ result: rpc.withContext({ err: null, logs: ['simulated'], accounts: null, unitsConsumed: 1, returnData: null }) }));
  const e = await refused(api('send', { transaction: early }), /The transaction landed and failed/, 400);
  assert.equal(e.result.status, 'failed');
  assert.equal(e.result.signature, bs58.encode(Transaction.from(Buffer.from(early, 'base64')).signature));
  assert.equal(typeof e.result.slot, 'number');
});

test('a lost reply to the broadcast is resolved by the cluster status, whichever way it went', async () => {
  let run = await readyToSend();
  run.rpc.fault('sendTransaction', () => ({ drop: true, deliver: true })); // received, reply lost
  let r = await run.api('send', { transaction: run.transaction });
  assert.equal(r.status, 'confirmed'); assert.equal(r.ok, true); assert.equal(r.signature, run.signature);

  run = await readyToSend();
  run.rpc.fault('sendTransaction', () => ({ drop: true })); // never received
  r = await run.api('send', { transaction: run.transaction });
  assert.equal(r.status, 'unknown'); assert.equal(r.ok, false); assert.equal(r.signature, run.signature);
  assert.match(r.error, /did not acknowledge the transaction/);
  assert.equal((await campaignFor(run.api, run.alice, run.campaign)).mine, null);
});

test('a node that refuses the broadcast, or cannot simulate, means nothing was sent', async () => {
  let run = await readyToSend();
  run.rpc.fault('sendTransaction', () => ({ error: { code: -32005, message: 'Node is behind by 400 slots' } }));
  let e = await refused(run.api('send', { transaction: run.transaction }), /refused the transaction and did not broadcast it \(Node is behind by 400 slots\)/, 400);
  assert.equal(e.result.status, 'rejected'); assert.equal(e.result.signature, run.signature);
  assert.equal(count(run.rpc, 'getSignatureStatuses'), 0);

  run = await readyToSend();
  run.rpc.fault('simulateTransaction', () => ({ drop: true }));
  e = await refused(run.api('send', { transaction: run.transaction }), /nothing was sent/, 503);
  assert.equal(e.result.status, 'rejected');
  assert.equal(count(run.rpc, 'sendTransaction'), 0);
});

test('status errors while waiting do not turn into a result; the next answer does', async () => {
  const { rpc, api, transaction } = await readyToSend();
  let failures = 3;
  rpc.fault('getSignatureStatuses', () => (failures-- > 0 ? { drop: true } : undefined));
  assert.equal((await api('send', { transaction })).status, 'confirmed');
  assert.ok(count(rpc, 'getSignatureStatuses') >= 4);
});

test('reads give up after the route timeout; a send is never abandoned', async () => {
  const { rpc, api, transaction } = await readyToSend({ routeTimeoutMs: 60 });
  rpc.fault('getSlot', async () => { await sleep(200); });
  await refused(api('state'), /did not answer in time/, 504);
  rpc.fault('getSlot');
  rpc.fault('getSignatureStatuses', async () => { await sleep(100); });
  assert.equal((await api('send', { transaction })).status, 'confirmed');
});

// ---------------------------------------------------------------- cluster and bytecode guards

test('every route refuses a node that is not devnet, before asking it anything else', async () => {
  const { rpc, api } = await boot({ rpc: { genesisHash: MAINNET_GENESIS } });
  const wallet = Keypair.generate().publicKey.toBase58();
  for (const [route, data] of [['state?wallet=' + wallet], ['environment'], ['prepare', { wallet, action: 'create', target: '0.02', minutes: '1', name: 'x', symbol: 'x' }], ['faucet', { wallet }]]) {
    const e = await refused(api(route, data), /The RPC node is not Solana devnet/, 503);
    assert.equal(e.result.genesisHash, MAINNET_GENESIS);
  }
  const e = await refused(api('send', { transaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 1), Buffer.alloc(40)]).toString('base64') }), /not Solana devnet|Not a valid/);
  assert.equal(e.result.status, 'rejected');
  assert.deepEqual([...new Set(rpc.calls)], ['getGenesisHash']);
});

test('a signed transaction is not sent to a node that is not devnet', async () => {
  const run = await readyToSend();
  const { createDevnetApi } = await import('../app/devnet-api.mjs');
  const elsewhere = createRpc({ genesisHash: MAINNET_GENESIS });
  const api = createDevnetApi({ programId: run.rpc.programId, fetch: elsewhere.fetch });
  const e = await refused(api('send', { transaction: run.transaction }), /not Solana devnet/, 503);
  assert.equal(e.result.status, 'rejected');
  assert.deepEqual(elsewhere.calls, ['getGenesisHash']);
});

test('configuration: validator mode needs loopback and a private cluster; defaults are the pinned deployment', async () => {
  const { createDevnetApi, DEVNET_PROGRAM_ID, DEVNET_RPC_URL } = await import('../app/devnet-api.mjs');
  const rpc = createRpc({ genesisHash: Keypair.generate().publicKey.toBase58() });
  const make = (config) => createDevnetApi({ programId: rpc.programId, fetch: rpc.fetch, ...config });
  await refused(make({ network: 'validator' })('state'), /only allowed with a loopback RPC URL/, 500);
  await refused(make({ network: 'mainnet' })('state'), /must be "devnet" or "validator"/, 500);
  await refused(make({ rpcUrl: 'http://rpc.example.com' })('state'), /must use https/, 500);
  await refused(make({ rpcUrl: 'not a url' })('state'), /not a valid URL/, 500);
  await refused(make({ programId: 'nope' })('state'), /not a valid address/, 500);
  assert.equal(rpc.calls.length, 0, 'a bad configuration never reaches the network');
  await refused(make({})('state'), /not Solana devnet/, 503); // devnet mode against the private cluster

  const local = make({ network: 'validator', rpcUrl: 'http://127.0.0.1:8899' });
  const env = await local('environment');
  assert.equal(env.network, 'validator'); assert.equal(env.hasFaucet, true); assert.equal(env.rpcHost, '127.0.0.1:8899');
  assert.ok(BigInt(env.preset.migrationThreshold) > 10n * SOL, 'full-size curve off devnet');
  const wallet = Keypair.generate().publicKey.toBase58();
  assert.equal((await local('faucet', { wallet })).ok, true);
  assert.equal((await local('state?wallet=' + wallet)).balance, 10_000_000_000);
  const publicNode = createRpc(); // reports the devnet genesis hash
  await refused(createDevnetApi({ programId: publicNode.programId, fetch: publicNode.fetch, network: 'validator', rpcUrl: 'http://localhost:8899' })('state'), /points at a public cluster/, 503);

  // unset and empty settings fall back to the pinned program and public RPC, never to "anything"
  const asked = [];
  const pinned = createDevnetApi({ programId: undefined, rpcUrl: '', network: undefined, fetch: async (url, init) => { asked.push([String(url), JSON.parse(init.body)]); return createRpc().fetch(url, init); } });
  await refused(pinned('state'), /not deployed as an executable/, 503);
  assert.ok(asked.every(([url]) => url === DEVNET_RPC_URL));
  assert.equal(asked.at(-1)[1].params[0], DEVNET_PROGRAM_ID);
});

test('changed program bytecode stops every route, including a send that was prepared before the change', async () => {
  const run = await readyToSend();
  const { rpc, api, alice, campaign } = run;
  const wallet = alice.publicKey.toBase58();
  const env = await api('environment');
  const programData = env.deployment.programData;
  const upgraded = () => { // what the node would return after an upgrade to other code
    const account = rpc.account(programData), bytes = Buffer.from(account.data[0], 'base64');
    bytes[45 + 4096] ^= 1;
    return { ...account, data: [bytes.toString('base64'), 'base64'] };
  };
  rpc.fault('getAccountInfo', ([address]) => (address === programData ? { result: rpc.withContext(upgraded()) } : undefined));
  rpc.calls.length = 0;
  for (const [route, data] of [['state?wallet=' + wallet], ['environment'], ['prepare', { wallet, action: 'withdraw', campaign }]]) {
    await refused(api(route, data), /Deployed program differs from this reviewed release/, 503);
  }
  const e = await refused(api('send', { transaction: run.transaction }), /Deployed program differs from this reviewed release/, 503);
  assert.equal(e.result.status, 'rejected');
  assert.equal(count(rpc, 'sendTransaction') + count(rpc, 'simulateTransaction'), 0, 'the signed transaction went nowhere');
  // not sticky: a node serving the reviewed build again is accepted again
  rpc.fault('getAccountInfo');
  assert.equal((await api('state?wallet=' + wallet)).deployment.sha256, env.deployment.sha256);
  assert.equal((await api('send', { transaction: run.transaction })).status, 'confirmed');
});

test('the bytecode is re-read on every call by default; the optional cache covers reads only', async () => {
  const strict = await boot();
  const programData = (await strict.api('environment')).deployment.programData;
  let seen = 0;
  strict.rpc.fault('getAccountInfo', ([address]) => { if (address === programData) seen++; });
  await strict.api('state'); await strict.api('state'); await strict.api('environment');
  assert.equal(seen, 3, 'one full bytecode read per call');

  const cached = await boot({ stateDeploymentCacheMs: 60_000 });
  const data = (await cached.api('environment')).deployment.programData;
  let cachedSeen = 0, tampered = false;
  cached.rpc.fault('getAccountInfo', ([address]) => {
    if (address !== data) return undefined;
    cachedSeen++;
    if (!tampered) return undefined;
    const account = cached.rpc.account(data), bytes = Buffer.from(account.data[0], 'base64');
    bytes[100] ^= 1;
    return { result: cached.rpc.withContext({ ...account, data: [bytes.toString('base64'), 'base64'] }) };
  });
  const first = await cached.api('state'); await cached.api('state');
  assert.equal(cachedSeen, 0, 'reads reuse the check made moments ago');
  tampered = true;
  assert.equal((await cached.api('state')).deployment.checkedAt, first.deployment.checkedAt, 'and say when that check was made');
  const wallet = Keypair.generate().publicKey.toBase58();
  await refused(cached.api('prepare', { wallet, action: 'create', target: '0.02', minutes: '1', name: 'x', symbol: 'x' }), /differs from this reviewed release/, 503);
  assert.equal(cachedSeen, 1, 'preparing a transaction always re-reads the bytecode');
  await refused(cached.api('state'), /differs from this reviewed release/, 503); // the failed check dropped the cache
});

test('the adapter keeps the app helper contract: plain JSON in, plain JSON out, errors carry the body', async () => {
  const { rpc, api } = await boot();
  const wallet = rpc.fund(Keypair.generate());
  const { prepared, sent } = await act(api, wallet, { action: 'create', target: '0.02', minutes: 2, name: 'Shape', symbol: 'SHP' }, 'create');
  const state = await api('state?wallet=' + wallet.publicKey.toBase58());
  for (const value of [prepared, sent, state, await api('environment'), await api('state?wallet=')]) {
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'survives JSON unchanged: no BigInt, undefined, Buffer or PublicKey');
  }
  // everything app/main.jsx reads from a campaign is present, with 64-bit amounts as decimal strings
  const c = state.campaigns[0];
  for (const name of ['target', 'total', 'closeTime', 'expiry', 'minTokens', 'supply', 'migrationThreshold', 'walletTokenBalance', 'tokensBought']) assert.match(c[name], /^[0-9]+$/, name);
  for (const name of ['address', 'name', 'symbol', 'status', 'statusLabel', 'venue', 'beneficiary', 'config', 'configHash']) assert.equal(typeof c[name], 'string', name);
  for (const name of ['canContribute', 'canWithdraw', 'canSettle', 'canRefund', 'canMigrate', 'configMatches']) assert.equal(typeof c[name], 'boolean', name);
  for (const name of ['progress', 'decimals', 'creatorTradingFeePercentage']) assert.equal(typeof c[name], 'number', name);
  assert.deepEqual(c.positions, {});
  assert.equal(typeof state.balance, 'number'); assert.match(state.now, /^[0-9]+$/);
  for (const name of ['upgradeable', 'upgradeAuthority', 'sha256']) assert.ok(name in state.deployment, name);
  assert.equal(state.programId, rpc.programId); assert.equal(state.network, 'devnet');
  for (const name of ['transaction', 'title', 'summary', 'note', 'fee', 'createdCampaign', 'quoteDetails']) assert.ok(prepared[name], name);
  assert.match(prepared.quoteDetails.minimumTokens, /^[0-9]+$/);

  await refused(api('faucet', { wallet: wallet.publicKey.toBase58() }), /This page holds no funds/, 400);
  await refused(api('advance', { campaign: prepared.createdCampaign, to: 'close' }), /no time controls on a real cluster/, 404);
  await refused(api('prepare'), /JSON request required/, 400);
  await refused(api('nope'), /Route not found/, 404);
  await refused(api('prepare', 'text'), /JSON request required/, 400);
  await refused(api('state?wallet=not-a-key'), /wallet is not a valid address/, 400);
});
