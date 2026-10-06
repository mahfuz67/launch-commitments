// The browser modules in app/ are ports of Node modules that cannot be bundled for a
// browser. These tests hold each port to its original: same exports, same bytes, same
// errors. They run in Node; tests/hosted-bundle.cjs runs the bundle in a real browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Keypair, PublicKey } = require('@solana/web3.js');
const sdk = require('../sdk/index.cjs');
const original = require('../runtime/deployment-info.cjs');
const { preset: originalPreset } = require('../runtime/preset.cjs');
const { setup } = require('./harness.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const key = () => Keypair.generate().publicKey;
const u64 = () => crypto.randomBytes(8).readBigUInt64LE();
const plain = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof PublicKey ? x.toBase58() : x)));
/** Run the same call on both: the same value from each, or (only if allowed) the same error. */
async function same(run, what, { mayThrow = false } = {}) {
  const outcome = async (lib) => { try { return { value: plain(await run(lib)) }; } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } };
  const [a, b] = [await outcome(sdk), await outcome(await port())];
  assert.deepEqual(b, a, what);
  if (!mayThrow) assert.equal(a.error, undefined, what);
  return a;
}
let ported;
const port = async () => (ported ||= await import('../app/lc-browser.mjs'));
const wire = (tx) => { tx.feePayer = tx.instructions.at(-1).keys[0].pubkey; tx.recentBlockhash = PublicKey.default.toBase58(); return tx.serializeMessage().toString('hex'); };
const ix = (i) => ({ programId: i.programId.toBase58(), keys: i.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), data: i.data.toString('hex') });

// The ports were written against these exact files. When one changes, compare it with its
// port, carry the change over, then update the hash here.
const PORTED_FROM = {
  'sdk/index.cjs': ['app/lc-browser.mjs', '82487ecb998b6277b553490025c4f79e3f27a7daa53a6e100f779a09ef2c1a4c'],
  'runtime/deployment-info.cjs': ['app/deployment-browser.mjs', '977309f6ffec0e1ac31e61cf0ea7f88eac689a3bec3c791b0a1c4f2997518d73'],
  'runtime/preset.cjs': ['app/devnet-core.mjs', 'c4f73c55dfe90341151d52be346d9806579308dfbd2c7a7d60be7c88c45a423a'],
  'runtime/devnet-server.cjs': ['app/devnet-core.mjs', '1bf079755d1908fe3dcecfedb9fc572dab8f8f6cc54ff221bc09c18d553d49a3'],
};
test('the Node sources are the versions the browser ports were written against', () => {
  for (const [source, [target, hash]] of Object.entries(PORTED_FROM)) {
    assert.equal(sha256(read(source)), hash, `${source} changed: carry the change into ${target}, then update PORTED_FROM`);
  }
});

test('lc-browser exports the same names and constants as the SDK', async () => {
  const lc = await port();
  assert.deepEqual(Object.keys(lc).sort(), Object.keys(sdk).sort());
  assert.deepEqual(Object.keys(lc.instructions).sort(), Object.keys(sdk.instructions).sort());
  for (const name of ['TAG', 'STATE', 'ERRORS', 'CAMPAIGN_SIZE', 'RECEIPT_SIZE', 'CONFIG_SIZE', 'MIN_SETUP_BUDGET_LAMPORTS', 'DBC_PROGRAM_ID', 'METADATA_PROGRAM_ID', 'WSOL_MINT']) {
    assert.deepEqual(plain(lc[name]), plain(sdk[name]), name);
  }
});

test('lc-browser derives the same addresses and builds byte-identical instructions and transactions', async () => {
  for (let round = 0; round < 25; round++) {
    const programId = key(), organizer = key(), contributor = key(), campaign = key(), config = key(), beneficiary = key(), nonce = u64();
    await same((lc) => lc.deriveCampaign(programId, organizer, nonce), 'deriveCampaign');
    for (const name of ['deriveVault', 'deriveBudget', 'deriveMint']) await same((lc) => lc[name](programId, campaign), name);
    await same((lc) => lc.deriveReceipt(programId.toBase58(), campaign, contributor.toBase58()), 'deriveReceipt');
    await same((lc) => lc.deriveSettlementAccounts(programId, campaign, config), 'deriveSettlementAccounts');

    const terms = { programId, organizer, beneficiary, config, nonce, target: u64(), minTokens: u64(), closeTime: BigInt(round) * 1000n, expiry: 2n ** 40n + BigInt(round), budgetLamports: 50_000_000n + BigInt(round), name: 'Launch ' + round, symbol: 'L' + round, uri: 'https://example.invalid/' + round + '.json' };
    await same(async (lc) => { const b = await lc.createCampaign(terms); return { wire: wire(b.transaction), campaign: b.campaign, vault: b.vault, budget: b.budget, mint: b.mint }; }, 'createCampaign');
    const amount = u64(), common = { programId, campaign, contributor };
    await same(async (lc) => { const b = await lc.contribute({ ...common, amount }); return [wire(b.transaction), b.receipt]; }, 'contribute');
    await same(async (lc) => { const b = await lc.withdraw({ ...common, amount }); return [wire(b.transaction), b.receipt]; }, 'withdraw');
    await same(async (lc) => { const b = await lc.refund(common); return [wire(b.transaction), b.receipt]; }, 'refund');
    for (const createTokenAccount of [true, false]) {
      await same(async (lc) => { const b = await lc.claim({ ...common, createTokenAccount }); return [wire(b.transaction), b.tokenAccount]; }, 'claim');
    }
    await same(async (lc) => { const b = await lc.settle({ programId, campaign, config, beneficiary, computeUnitLimit: 300_000 + round }); return [b.transaction.instructions.map(ix), b.accounts]; }, 'settle');
    const [vault] = sdk.deriveVault(programId, campaign), [receipt] = sdk.deriveReceipt(programId, campaign, contributor);
    for (const name of ['contribute', 'withdraw', 'refund']) await same((lc) => ix(lc.instructions[name]({ programId, contributor, campaign, vault, receipt, amount })), 'instructions.' + name);
    await same((lc) => ix(lc.instructions.claim({ programId, contributor, campaign, vault, receipt, campaignTokenAccount: vault.toBase58(), contributorTokenAccount: receipt })), 'instructions.claim');
  }
});

test('lc-browser rejects bad arguments with the same errors', async () => {
  const programId = key(), campaign = key(), contributor = key();
  const terms = { programId, organizer: key(), beneficiary: key(), config: key(), nonce: 1n, target: 1n, minTokens: 1n, closeTime: 1n, expiry: 2n, name: 'n', symbol: 's', uri: 'https://x' };
  const bad = [
    (lc) => lc.contribute({ programId, campaign, contributor, amount: 5 }),
    (lc) => lc.contribute({ programId, campaign, contributor, amount: -1n }),
    (lc) => lc.contribute({ programId, campaign, contributor, amount: 2n ** 64n }),
    (lc) => lc.contribute({ programId: 42, campaign, contributor, amount: 1n }),
    (lc) => lc.withdraw({ programId, campaign: 'not base58!', contributor, amount: 1n }),
    (lc) => lc.createCampaign({ ...terms, name: '' }),
    (lc) => lc.createCampaign({ ...terms, name: 'x'.repeat(33) }),
    (lc) => lc.createCampaign({ ...terms, symbol: 'é'.repeat(6) }),
    (lc) => lc.createCampaign({ ...terms, uri: 'u'.repeat(201) }),
    (lc) => lc.createCampaign({ ...terms, budgetLamports: 49_999_999n }),
    (lc) => lc.createCampaign({ ...terms, closeTime: 2n ** 63n }),
    (lc) => lc.settle({ programId, campaign }),
    (lc) => lc.decodeCampaign(Buffer.alloc(568)),
    (lc) => lc.decodeReceipt(Buffer.alloc(88)),
    (lc) => lc.decodeDbcConfig(Buffer.alloc(10)),
    (lc) => lc.checkConfigPreset(Buffer.alloc(10), 1n),
    (lc) => lc.checkConfigPreset(Buffer.alloc(1048), 1),
    (lc) => lc.phase({ state: 1, closeTime: 1n, expiry: 2n, totalContributed: 0n, target: 1n }, 5),
    (lc) => lc.allocation({ contribution: 5n, total: 4n, target: 1n, bought: 1n }),
    (lc) => lc.allocation({ contribution: 1n, total: 1n, target: 2n, bought: 1n }),
  ];
  for (const [i, run] of bad.entries()) {
    const outcome = await same(run, 'bad call ' + i, { mayThrow: true });
    if (i !== 15) assert.ok(outcome.error, 'bad call ' + i + ' must throw'); // 15 reports a violation list instead
  }
});

test('lc-browser decodes real accounts, checks the preset and hashes the config like the SDK', async () => {
  const lc = await port();
  const h = await setup();
  await h.invoke('contribute', h.a, { amount: 3_000_000_000n });
  const campaign = h.e.account(h.created.campaign.toBase58()).data;
  const receipt = h.e.account(sdk.deriveReceipt(h.programId, h.created.campaign, h.a.publicKey)[0].toBase58()).data;
  const config = h.e.account(h.cfg.publicKey.toBase58()).data;
  await same((x) => x.decodeCampaign(campaign), 'decodeCampaign');
  await same((x) => x.decodeReceipt(receipt), 'decodeReceipt');
  await same((x) => x.decodeDbcConfig(config), 'decodeDbcConfig');
  assert.equal((await same((x) => x.checkConfigPreset(config, h.terms.target), 'preset')).value.ok, true);
  assert.equal(await lc.hashConfig(config), sdk.hashConfig(config));
  assert.equal(await lc.hashConfig(config), sdk.decodeCampaign(campaign).configHash, 'the browser hash equals the hash the program stored');

  // every single-byte change must be judged identically, and change the hash identically
  let rejected = 0;
  for (let i = 0; i < 600; i++) {
    const changed = Buffer.from(config);
    changed[i < 380 ? i : crypto.randomInt(changed.length)] ^= 1 + crypto.randomInt(255);
    const verdict = await same((x) => x.checkConfigPreset(changed, h.terms.target), 'mutated preset ' + i);
    if (!verdict.value.ok) rejected++;
    await same((x) => x.decodeDbcConfig(changed), 'mutated decode ' + i);
    assert.equal(await lc.hashConfig(changed), sdk.hashConfig(changed));
  }
  assert.ok(rejected > 50, 'the mutations exercised the violation paths');

  const settled = { ...sdk.decodeCampaign(campaign), state: sdk.STATE.Settled };
  for (const now of [0n, h.terms.closeTime - 1n, h.terms.closeTime, h.terms.expiry - 1n, h.terms.expiry]) {
    for (const total of [0n, h.terms.target - 1n, h.terms.target]) {
      await same((x) => x.phase({ ...x.decodeCampaign(campaign), totalContributed: total }, now), 'phase');
    }
    await same((x) => x.phase(settled, now), 'settled phase');
  }
  for (let i = 0; i < 200; i++) {
    const total = u64() >> 8n, target = total - (u64() % (total + 1n)), contribution = u64() % (total + 1n), bought = u64();
    await same((x) => x.allocation({ contribution, total, target, bought }), 'allocation');
  }
});

test('the browser preset is the curve the server uses', async () => {
  const core = await import('../app/devnet-core.mjs');
  for (const scale of [1, 0.01]) assert.equal(JSON.stringify(core.preset({ scale })), JSON.stringify(originalPreset({ scale })));
  assert.throws(() => core.preset({ scale: 0.5 }), /Unsupported/);
  assert.equal(core.DEVNET_GENESIS, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
});

// ---------------------------------------------------------------- deployment guard

const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const binary = read('program/build/launch_commitments.so');
function fixture() {
  const pid = key(), pd = key(), authority = key();
  const program = { executable: true, owner: loader, data: Buffer.alloc(36) };
  program.data.writeUInt32LE(2); pd.toBuffer().copy(program.data, 4);
  const data = { executable: false, owner: loader, data: Buffer.alloc(45 + binary.length) };
  data.data.writeUInt32LE(3); data.data.writeBigUInt64LE(123n, 4); data.data[12] = 1;
  authority.toBuffer().copy(data.data, 13); binary.copy(data.data, 45);
  const connection = { getAccountInfo: async (k) => (k.equals(pid) ? program : k.equals(pd) ? data : null) };
  return { pid, pd, authority, program, data, connection };
}

test('the pinned program, hash and size are the recorded deployment and the committed build', async () => {
  const browser = await import('../app/deployment-browser.mjs'), api = await import('../app/devnet-api.mjs');
  const manifest = JSON.parse(read('deployment.json'));
  assert.equal(api.DEVNET_PROGRAM_ID, manifest.programId);
  assert.equal(manifest.network, 'devnet');
  assert.equal(browser.REVIEWED_SHA256, original.REVIEWED_SHA256);
  assert.equal(browser.REVIEWED_SHA256, manifest.sha256);
  assert.equal(browser.REVIEWED_SHA256, sha256(binary));
  assert.equal(browser.REVIEWED_BYTES, original.REVIEWED_BYTES);
  assert.equal(browser.REVIEWED_BYTES, binary.length);
});

test('the browser deployment guard accepts and refuses exactly what the server guard does', async () => {
  const browser = await import('../app/deployment-browser.mjs');
  const cases = {
    'reviewed build with a retained authority': () => {},
    'reviewed build with no authority': (f) => { f.data.data[12] = 0; },
    'one changed code byte': (f) => { f.data.data[50] ^= 1; },
    'last code byte changed': (f) => { f.data.data[f.data.data.length - 1] ^= 0x80; },
    'nonzero byte after the code': (f) => { f.data.data = Buffer.concat([f.data.data, Buffer.from([1])]); },
    'zero padding after the code': (f) => { f.data.data = Buffer.concat([f.data.data, Buffer.alloc(4096)]); },
    'truncated code': (f) => { f.data.data = f.data.data.subarray(0, f.data.data.length - 1); },
    'program data owned by another program': (f) => { f.data.owner = PublicKey.default; },
    'program data missing': (f) => { f.connection.getAccountInfo = async (k) => (k.equals(f.pid) ? f.program : null); },
    'program data marked executable': (f) => { f.data.executable = true; },
    'program data too short': (f) => { f.data.data = f.data.data.subarray(0, 44); },
    'program data with the wrong tag': (f) => { f.data.data.writeUInt32LE(2); },
    'authority flag out of range': (f) => { f.data.data[12] = 2; },
    'program account with the wrong tag': (f) => { f.program.data.writeUInt32LE(3); },
    'program account of the wrong size': (f) => { f.program.data = Buffer.alloc(40); },
    'unknown loader': (f) => { f.program.owner = PublicKey.default; },
    'legacy loader holding the reviewed build': (f) => { f.program.owner = new PublicKey('BPFLoader2111111111111111111111111111111111'); f.program.data = binary; },
    'legacy loader holding other code': (f) => { f.program.owner = new PublicKey('BPFLoader2111111111111111111111111111111111'); f.program.data = Buffer.from(binary); f.program.data[9] ^= 1; },
    'not executable': (f) => { f.program.executable = false; },
    'no account at all': (f) => { f.connection.getAccountInfo = async () => null; },
  };
  const accepted = [];
  for (const [name, change] of Object.entries(cases)) {
    const f = fixture(); change(f);
    const outcome = async (fn) => { try { const { checkedAt, ...info } = await fn(f.connection, f.pid); return { info }; } catch (e) { return { error: e.message }; } };
    const [server, page] = [await outcome(original.deploymentInfo), await outcome(browser.deploymentInfo)];
    assert.deepEqual(page, server, name);
    if (page.info) { accepted.push(name); assert.equal(page.info.sha256, original.REVIEWED_SHA256); }
  }
  assert.deepEqual(accepted, ['reviewed build with a retained authority', 'reviewed build with no authority', 'zero padding after the code', 'legacy loader holding the reviewed build']);
});

test('hashing fails closed where WebCrypto is unavailable', async () => {
  const { sha256Hex } = await import('../app/sha256-browser.mjs');
  assert.equal(await sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const view = Buffer.concat([Buffer.from('xx'), Buffer.from('abc'), Buffer.from('yy')]).subarray(2, 5);
  assert.equal(await sha256Hex(view), sha256(Buffer.from('abc')), 'a view hashes only its own bytes');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try { await assert.rejects(sha256Hex(Buffer.from('abc')), /WebCrypto/); } finally { Object.defineProperty(globalThis, 'crypto', descriptor); }
});

test('the browser modules use no Node built-ins, stored keys, page-supplied configuration or side channels', () => {
  const modules = ['devnet-api.mjs', 'devnet-core.mjs', 'lc-browser.mjs', 'deployment-browser.mjs', 'sha256-browser.mjs', 'buffer-global.mjs'];
  const forbidden = /node:|\brequire\s*\(|\bprocess\.|__dirname|localStorage|sessionStorage|indexedDB|document\.|\blocation\b|fromSecretKey|fromSeed|secretKey|sendBeacon|XMLHttpRequest|WebSocket|EventSource|\beval\s*\(|new Function/;
  for (const name of modules) {
    const code = read('app/' + name).toString().split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**')).join('\n');
    assert.equal(code.match(forbidden), null, `${name} contains ${code.match(forbidden)?.[0]}`);
  }
  // the only places the adapter creates a key or reaches the network
  const core = read('app/devnet-core.mjs').toString();
  assert.equal(core.match(/Keypair\.generate\(\)/g).length, 1, 'one generated key: the new config address');
  assert.equal(core.match(/globalThis\.fetch/g).length, 1, 'one network primitive: the RPC transport');
});
