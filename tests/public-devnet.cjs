// Public devnet proof for launch-commitments: one campaign that launches and one that fails
// to fund, run side by side with a real funding window, then recovery without the backend.
//
// DEVNET ONLY. The RPC node's genesis hash must be Solana devnet's, and so must the backend's.
// There is no switch for another cluster. Nothing here requests an airdrop.
//
// Money: the only funding source is the dedicated test key in DEPLOY_KEYPAIR (default
// private/devnet-payer.json). It signs one transfer to three test wallets this script
// generates. Those wallets are written to private/public-proof/ (mode 0600) before anything
// is funded and are never deleted or overwritten, so a failed run can always be recovered.
// They are test wallets run by the build team: not users, usage, volume or demand.
//
// Evidence: private/public-proof/public-evidence.json holds addresses, signatures and checks
// only. It is rewritten after every transaction, with the signature recorded before the
// transaction is sent, so a stopped run resumes without sending anything twice. A finished
// phase refuses to run again.
//
// Needs the deployed program and a running backend in devnet mode:
//   DEVNET_PROGRAM_ID=<address> node runtime/devnet-server.cjs
//
// From work/launch-commitments:
//   node tests/public-devnet.cjs                                    read-only plan and balance check
//   node tests/public-devnet.cjs --phase launch --execute           about two minutes
//   (stop the backend)
//   node tests/public-devnet.cjs --phase refund-recovery --execute  uses recover.cjs, no backend
// Optional: add --with-expiry to the launch phase for a third, funded campaign that nobody
// launches, then run --phase expiry-recovery --execute about eleven minutes later.
// See --help for the rest.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction, SystemProgram, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY,
} = require('@solana/web3.js');
const { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } = require('@solana/spl-token');
const bs58 = require('bs58');
const lc = require('../sdk/index.cjs');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

// ---------------------------------------------------------------- configuration

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const RPC_URL = process.env.LAUNCH_RPC_URL || 'https://api.devnet.solana.com';
const API = process.env.LAUNCH_API_URL || `http://127.0.0.1:${Number(process.env.LAUNCH_API_PORT || 19190)}`;
const FEE = 5000n; // lamports per signature
const MARGIN = 3_000_000n; // per test wallet: network fees, and it stays rent exempt throughout
const PAYER_RESERVE = 10_000_000n; // left in the funding key after the transfer
const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

// Test amounts in lamports. Targets sit below the devnet preset's migration threshold.
const PLAN = {
  launch: {
    name: 'LC devnet test: launch', symbol: 'LCTEST', target: 20_000_000n,
    contributions: { alice: 18_000_000n, bob: 14_000_000n }, bobWithdraws: 2_000_000n,
  },
  underfunded: {
    name: 'LC devnet test: refund', symbol: 'LCTESTR', target: 50_000_000n,
    contributions: { alice: 4_000_000n, bob: 3_000_000n },
  },
  expiry: {
    name: 'LC devnet test: expiry', symbol: 'LCTESTX', target: 20_000_000n,
    contributions: { alice: 12_000_000n, bob: 10_000_000n },
  },
};
const ROLES = ['organizer', 'alice', 'bob'];
const CONTRIBUTORS = ['alice', 'bob'];
const SENDING_PHASES = ['launch', 'refund-recovery', 'expiry-recovery', 'recover-all', 'sweep'];
const PHASES = ['plan', 'status', 'verify', ...SENDING_PHASES];

const HELP = `Public devnet proof for launch-commitments. Devnet only.

  node tests/public-devnet.cjs [--phase NAME] [--execute] [options]

Phases
  plan              (default) read-only: cluster, program, funding plan, balance check
  status            read-only: recorded evidence and each campaign's phase on chain
  verify            sends nothing: re-checks every recorded signature and the deployed program
                    against the cluster as it is now, and writes the result into the evidence
  launch            generate and fund three test wallets, create the campaigns, contribute,
                    wait for the funding window, launch, claim pro rata, refund once
  refund-recovery   backend must be stopped: the second refund through recover.cjs
  expiry-recovery   only after --with-expiry; backend must be stopped: waits for expiry, then
                    both refunds of the funded, unlaunched campaign through recover.cjs
  recover-all       after a run that could not finish: withdraw, refund or claim every open
                    contribution through recover.cjs
  sweep             return leftover test SOL from the three wallets to the funding key

Options
  --execute         required for any phase that sends transactions; without it the phase
                    prints the plan and sends nothing
  --with-expiry     launch phase: add the funded-but-unlaunched campaign (one more creation)
  --minutes N       launch phase: funding window, 1 to 5 minutes (default 1)
  --run LABEL       keep this run in private/public-proof/LABEL/ (a fresh run after a failed one)
  --program ADDR    program address (default DEVNET_PROGRAM_ID, then deployment.json)

Environment
  DEPLOY_KEYPAIR    dedicated devnet funding key file (default private/devnet-payer.json)
  LAUNCH_RPC_URL    devnet RPC (default https://api.devnet.solana.com); only its host is shown
  LAUNCH_API_URL    backend (default http://127.0.0.1:19190); loopback only
  DEVNET_PROGRAM_ID the deployed program, as given to the backend`;

function parseArgs(argv) {
  const out = { phase: 'plan', execute: false, withExpiry: false, minutes: null, run: '', program: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value.`); return argv[++i]; };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--execute') out.execute = true;
    else if (a === '--with-expiry') out.withExpiry = true;
    else if (a === '--phase') out.phase = value();
    else if (a === '--minutes') out.minutes = Number(value());
    else if (a === '--run') out.run = value();
    else if (a === '--program') out.program = value();
    else throw new Error(`Unknown argument ${a}. Try --help.`);
  }
  if (!PHASES.includes(out.phase)) throw new Error(`Unknown phase "${out.phase}". Phases: ${PHASES.join(', ')}.`);
  if (out.minutes !== null && (!Number.isInteger(out.minutes) || out.minutes < 1 || out.minutes > 5)) throw new Error('--minutes must be a whole number from 1 to 5.');
  if (out.run && !/^[a-z0-9-]{1,32}$/.test(out.run)) throw new Error('--run takes lowercase letters, digits and dashes, at most 32.');
  return out;
}

let args, DIR, EVIDENCE, PROGRAM, connection, rpcHost;
let ev = null; // the evidence document, also the resume state
let lastSlot = 0; // newest slot this run has seen; later reads must be at least this fresh

/** The run stopped for a reason a retry of the same phase cannot fix. Exit code 2. */
class CannotContinue extends Error {}
/** A phase that already finished was asked to run again. Exit code 3. */
class AlreadyDone extends Error {}

// ---------------------------------------------------------------- small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b58 = (bytes) => (bs58.default || bs58).encode(bytes);
const explorerTx = (signature) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
const explorerAddress = (address) => `https://explorer.solana.com/address/${address}?cluster=devnet`;
const sum = (list) => list.reduce((a, b) => a + b, 0n);

/** Lamports as a decimal SOL string, in the form the backend accepts. */
function sol(lamports) {
  const s = BigInt(lamports).toString().padStart(10, '0');
  const fraction = s.slice(-9).replace(/0+$/, '');
  return s.slice(0, -9) + (fraction ? '.' + fraction : '');
}

/** An RPC URL can carry an API key. Nothing printed or saved may contain it. */
function redact(text) {
  let out = String(text ?? '');
  try {
    const u = new URL(RPC_URL);
    for (const secret of [RPC_URL, u.href, u.search, u.pathname.length > 1 ? u.pathname : '', u.username, u.password]) {
      if (secret && secret.length > 3) out = out.split(secret).join('[rpc]');
    }
  } catch { /* an unparsable URL is rejected before any use */ }
  return out;
}
function log(message) { console.log(`[${args.phase}] ${redact(message)}`); }

async function retry(fn, tries = 6, delayMs = 1500) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= tries) throw e; await sleep(delayMs); }
  }
}

// ---------------------------------------------------------------- evidence (public data only)

function save() {
  ev.updatedAt = new Date().toISOString();
  const body = JSON.stringify(ev, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  // addresses and signatures only: a long run of small integers is what a key file looks like
  if (/secretKey/i.test(body) || /(\d{1,3},\s*){40,}/.test(body)) throw new Error('Refusing to write evidence that looks like key material.');
  fs.writeFileSync(EVIDENCE + '.tmp', body + '\n', { mode: 0o644 });
  fs.renameSync(EVIDENCE + '.tmp', EVIDENCE);
}
const txRecord = (id) => ev?.transactions.find((t) => t.id === id) || null;
const confirmed = (id) => txRecord(id)?.status === 'confirmed';
function upsertTx(record) {
  const i = ev.transactions.findIndex((t) => t.id === record.id);
  if (i < 0) ev.transactions.push(record); else ev.transactions[i] = record;
  return record;
}
/** Record a verification. A failed check stops the run after it is written down. */
function check(id, ok, detail) {
  const entry = { id, ok: !!ok, detail, checkedAt: new Date().toISOString() };
  const i = ev.checks.findIndex((c) => c.id === id);
  if (i < 0) ev.checks.push(entry); else ev.checks[i] = entry;
  save();
  if (!ok) throw new Error(`Check failed: ${id}. ${typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  log(`ok: ${id}`);
}
function startPhase(name) {
  if (ev.phases[name]?.status === 'complete') throw new AlreadyDone(`Phase "${name}" already completed at ${ev.phases[name].completedAt}. Refusing to repeat it. Evidence: ${path.relative(ROOT, EVIDENCE)}`);
  ev.phases[name] = { status: 'in progress', startedAt: ev.phases[name]?.startedAt || new Date().toISOString() };
  save();
}
function finishPhase(name) {
  ev.phases[name] = { ...ev.phases[name], status: 'complete', completedAt: new Date().toISOString() };
  save();
}
function campaignKeys() { return ev.options.withExpiry ? ['launch', 'underfunded', 'expiry'] : ['launch', 'underfunded']; }

// ---------------------------------------------------------------- keys (never printed, never in evidence)

function readKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}
/** The dedicated devnet funding key. Refuses the Solana CLI's default wallet location. */
function loadPayer() {
  const file = path.resolve(ROOT, process.env.DEPLOY_KEYPAIR || 'private/devnet-payer.json');
  if (file.startsWith(path.join(os.homedir(), '.config', 'solana') + path.sep)) throw new Error('DEPLOY_KEYPAIR points into the Solana CLI wallet directory. Use a dedicated devnet test key file.');
  if (!fs.existsSync(file)) throw new Error(`Funding key file not found: ${path.relative(ROOT, file)}. Set DEPLOY_KEYPAIR to the dedicated devnet test key.`);
  if (fs.statSync(file).mode & 0o077) throw new Error(`Funding key file ${path.relative(ROOT, file)} is readable by other users. Run chmod 600 on it first.`);
  return readKeypair(file);
}
const walletFile = (role) => path.join(DIR, `${role}.json`);
/** Load the three test wallets; create missing ones only while nothing has been funded. */
function loadWallets({ create }) {
  if (create) { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(DIR, 0o700); }
  const wallets = {};
  for (const role of ROLES) {
    const file = walletFile(role);
    if (!fs.existsSync(file)) {
      if (!create) throw new Error(`Test wallet file missing: ${path.relative(ROOT, file)}. Restore it; this script will not replace a wallet that may hold funds.`);
      // 'wx' fails rather than overwrite; the file is on disk before the wallet can receive anything
      fs.writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600, flag: 'wx' });
    }
    fs.chmodSync(file, 0o600);
    wallets[role] = readKeypair(file);
  }
  return wallets;
}

// ---------------------------------------------------------------- chain reads (direct RPC, not the backend)

/** unix_timestamp from the Clock sysvar: the same value the program reads. */
async function chainNow() {
  const { context, value } = await retry(() => connection.getAccountInfoAndContext(SYSVAR_CLOCK_PUBKEY, 'confirmed'));
  if (!value) throw new Error('Could not read the Clock sysvar.');
  lastSlot = Math.max(lastSlot, context.slot);
  return value.data.readBigInt64LE(32);
}
/** Read an account no older than anything this run has already seen confirmed. */
async function readAccount(address) {
  return retry(() => connection.getAccountInfo(new PublicKey(address), { commitment: 'confirmed', minContextSlot: lastSlot || undefined }), 10, 1500);
}
async function campaignState(address) {
  const info = await readAccount(address);
  if (!info || !info.owner.equals(PROGRAM)) throw new Error(`Campaign ${address} is not an account of this program.`);
  return lc.decodeCampaign(info.data);
}
async function receiptOf(campaign, wallet) {
  const info = await readAccount(lc.deriveReceipt(PROGRAM, new PublicKey(campaign), wallet)[0]);
  return info && info.owner.equals(PROGRAM) ? lc.decodeReceipt(info.data) : null;
}
async function waitForChainTime(target, what) {
  const started = Date.now();
  let now = await chainNow(), printed = 0;
  const limitMs = (Number(target - now > 0n ? target - now : 0n) * 2 + 180) * 1000; // devnet's clock can run slow
  while (now < target) {
    if (Date.now() - started > limitMs) throw new Error(`Chain time did not reach ${what} in time. Run the same phase again to keep waiting.`);
    if (Date.now() - printed > 20_000) { log(`waiting for ${what}: ${target - now}s of chain time left`); printed = Date.now(); }
    await sleep(2000);
    now = await chainNow();
  }
  return now;
}

/** Confirmed, failed or not yet known. Throws when the signature landed and failed. */
async function signatureStatus(signature) {
  const { value } = await retry(() => connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
  const st = value[0];
  if (!st) return null;
  if (st.err) { const e = new Error(`Transaction ${signature} landed and failed: ${JSON.stringify(st.err)}`); e.landedFailure = true; throw e; }
  if (st.confirmationStatus !== 'confirmed' && st.confirmationStatus !== 'finalized') return null;
  lastSlot = Math.max(lastSlot, st.slot);
  return { confirmation: st.confirmationStatus, slot: st.slot };
}

/** Balance changes of one confirmed transaction, from the cluster's own record of it. */
async function txMeta(signature) {
  for (let i = 0; i < 15; i++) {
    const t = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (t?.meta) {
      const message = t.transaction.message;
      const keys = (message.staticAccountKeys || message.accountKeys).map((k) => k.toBase58());
      const lamports = (address) => {
        const at = keys.indexOf(new PublicKey(address).toBase58());
        return at < 0 ? null : { pre: BigInt(t.meta.preBalances[at]), post: BigInt(t.meta.postBalances[at]) };
      };
      const tokens = (owner, mint) => {
        const pick = (list) => (list || []).find((b) => b.owner === owner.toBase58() && b.mint === mint.toBase58());
        return { pre: BigInt(pick(t.meta.preTokenBalances)?.uiTokenAmount.amount || 0), post: BigInt(pick(t.meta.postTokenBalances)?.uiTokenAmount.amount || 0) };
      };
      return { fee: BigInt(t.meta.fee), feePayer: keys[0], signatures: t.transaction.signatures.length, lamports, tokens };
    }
    await sleep(2000);
  }
  return null;
}
function warn(message) {
  if (!ev.warnings.includes(message)) ev.warnings.push(message);
  save();
  log(`warning: ${message}`);
}

// ---------------------------------------------------------------- backend calls

async function api(method, route, body, timeoutMs = 30_000) {
  let res;
  try {
    res = await fetch(API + route, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { status: 0, json: null, error: e.cause?.code || e.name || 'request failed' };
  }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, json, error: json?.error || text.slice(0, 200) };
}
async function backendReachable() {
  const r = await api('GET', '/api/environment', null, 4000);
  return { reachable: r.status !== 0, reason: r.status === 0 ? r.error : `HTTP ${r.status}` };
}
/** /api/prepare has no side effects, so a transient failure is simply retried. */
async function prepare(wallet, body, what) {
  for (let attempt = 1; ; attempt++) {
    const r = await api('POST', '/api/prepare', { wallet: wallet.publicKey.toBase58(), ...body });
    if (r.status === 200) return r.json;
    if (r.status === 400 || attempt >= 5) throw new Error(`prepare ${what}: ${r.status ? 'HTTP ' + r.status : 'backend unreachable'} ${r.error || ''}`);
    await sleep(1500);
  }
}

const ACTION_TAG = { create: lc.TAG.CreateCampaign, contribute: lc.TAG.Contribute, withdraw: lc.TAG.Withdraw, settle: lc.TAG.Settle, claim: lc.TAG.Claim, refund: lc.TAG.Refund };
/**
 * Check a transaction the backend prepared before a funded test wallet signs it: only the
 * programs this action needs, this wallet as fee payer and only missing signer, and the
 * amounts that were asked for. Returns the transaction and the public terms read from it.
 */
function checkPrepared(prepared, wallet, body, expect = {}) {
  const tx = Transaction.from(Buffer.from(prepared.transaction, 'base64'));
  const me = wallet.publicKey;
  const need = (cond, message) => { if (!cond) throw new Error(`Refusing to sign the prepared "${body.action}" transaction: ${message}.`); };
  need(tx.feePayer?.equals(me), 'the fee payer is not the signing wallet');
  const allowed = {
    create: [lc.DBC_PROGRAM_ID, PROGRAM], contribute: [PROGRAM], withdraw: [PROGRAM], refund: [PROGRAM],
    settle: [ComputeBudgetProgram.programId, PROGRAM], claim: [ASSOCIATED_TOKEN_PROGRAM_ID, PROGRAM],
  }[body.action];
  for (const ix of tx.instructions) {
    need(allowed.some((p) => p.equals(ix.programId)), `unexpected program ${ix.programId.toBase58()}`);
    // a compute-unit price would be an open-ended fee; only the unit limit is expected
    if (ix.programId.equals(ComputeBudgetProgram.programId)) need(ix.data[0] === 2, 'unexpected compute budget instruction');
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) need(ix.data[0] === 1 && ix.keys[0].pubkey.equals(me) && ix.keys[2].pubkey.equals(me), 'the token account is not this wallet’s own');
  }
  const ours = tx.instructions.filter((ix) => ix.programId.equals(PROGRAM));
  need(ours.length === 1 && ours[0].data[0] === ACTION_TAG[body.action], 'it does not hold exactly one matching launch-commitments instruction');
  const ix = ours[0];
  const terms = {};
  if (body.action === 'create') {
    need(ix.keys[0].pubkey.equals(me) && ix.keys[4].pubkey.equals(me), 'organizer or beneficiary is not this wallet');
    terms.closeTime = ix.data.readBigInt64LE(25); terms.expiry = ix.data.readBigInt64LE(33);
    need(ix.data.readBigUInt64LE(9) === expect.target, 'the target differs from the plan');
    need(ix.data.readBigUInt64LE(41) <= expect.maxBudget, 'the setup budget is above the disclosed amount');
    need(terms.expiry - terms.closeTime === expect.settlementWindow, 'the settlement window differs from the backend’s stated one');
    need(tx.signatures.length === 2 && tx.signatures[1].signature && tx.signatures[1].publicKey.toBase58() === prepared.createdConfig, 'the config co-signature is not as described');
  } else {
    need(tx.signatures.length === 1, 'it asks for more than one signature');
    const campaignAt = body.action === 'settle' ? 0 : 1;
    need(ix.keys[campaignAt].pubkey.toBase58() === body.campaign, 'it targets a different campaign');
    if (body.action !== 'settle') need(ix.keys[0].pubkey.equals(me), 'the contributor is not this wallet');
    if (body.action === 'contribute' || body.action === 'withdraw') need(ix.data.readBigUInt64LE(1) === expect.amount, 'the amount differs from the plan');
  }
  need(tx.signatures[0].publicKey.equals(me) && !tx.signatures[0].signature, 'the wallet signature slot is not empty');
  return { tx, terms };
}

// ---------------------------------------------------------------- sending, exactly once

async function pushBackend(wire) {
  const r = await api('POST', '/api/send', { transaction: wire.toString('base64') }, 90_000);
  if (r.status === 200 && r.json?.ok) { lastSlot = Math.max(lastSlot, r.json.slot || 0); return { kind: 'confirmed', confirmation: r.json.status, slot: r.json.slot, compute: r.json.compute }; }
  if (r.status === 400 && r.json?.status === 'failed') return { kind: 'failed', error: r.error };
  if (r.status === 400 || r.status === 503) return { kind: 'rejected', error: r.error, logs: r.json?.logs || [] }; // simulation or guard: not broadcast
  return { kind: 'unknown', error: r.error || `HTTP ${r.status}` }; // 202, 5xx, timeout: it may have been broadcast
}
async function pushRpc(wire) {
  let sim;
  try { sim = await connection.simulateTransaction(VersionedTransaction.deserialize(wire), { sigVerify: true, commitment: 'confirmed' }); } catch (e) { return { kind: 'rejected', error: e.message, logs: [] }; }
  if (sim.value.err) return { kind: 'rejected', error: `Simulation failed, nothing was sent (${JSON.stringify(sim.value.err)}).`, logs: sim.value.logs || [] };
  try { await connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 3 }); } catch (e) { return { kind: 'unknown', error: e.message, compute: sim.value.unitsConsumed }; }
  return { kind: 'unknown', error: 'sent, not yet confirmed', compute: sim.value.unitsConsumed };
}
/**
 * Push signed bytes until the cluster gives a definite answer for this signature: confirmed,
 * or never broadcast, or its blockhash expired unseen. Re-pushing the same bytes is safe
 * because a signature can only be processed once.
 */
async function deliver({ wire, signature, lastValidBlockHeight, via }) {
  let mayBeBroadcast = false, rejections = 0, compute = null, last = {};
  for (;;) {
    last = via.startsWith('backend') ? await pushBackend(wire) : await pushRpc(wire);
    compute = last.compute ?? compute;
    if (last.kind === 'confirmed') return { ...last, compute };
    if (last.kind === 'failed') { const e = new Error(`The transaction landed and failed: ${last.error}`); e.landedFailure = true; throw e; }
    if (last.kind === 'rejected') rejections++; else mayBeBroadcast = true;
    const until = Date.now() + (last.kind === 'rejected' ? 2500 : 20_000);
    do {
      const st = await signatureStatus(signature);
      if (st) return { kind: 'confirmed', ...st, compute };
      await sleep(1500);
    } while (Date.now() < until);
    if (!mayBeBroadcast && rejections >= 3) return { kind: 'rejected', error: last.error, logs: last.logs };
    if (await retry(() => connection.getBlockHeight('confirmed')) > lastValidBlockHeight) {
      await sleep(3000);
      const st = await signatureStatus(signature);
      if (st) return { kind: 'confirmed', ...st, compute };
      return { kind: 'expired', error: last.error };
    }
  }
}
/** A record left "pending" by a stopped run: find out what happened to that signature. */
async function resolvePending(rec) {
  log(`resuming ${rec.id}: checking signature ${rec.signature}`);
  for (;;) {
    let st;
    try { st = await signatureStatus(rec.signature); } catch (e) { if (!e.landedFailure) throw e; rec.status = 'failed'; rec.error = e.message; save(); return; }
    if (st) { Object.assign(rec, { status: 'confirmed', confirmation: st.confirmation, slot: st.slot }); save(); return; }
    if (await retry(() => connection.getBlockHeight('confirmed')) > rec.lastValidBlockHeight + 5) { rec.status = 'expired'; save(); return; }
    await sleep(3000);
  }
}
/**
 * One recorded transaction. `build` returns { tx, lastValidBlockHeight, public } with the
 * blockhash set and every signature but the signer's in place. Skipped when already confirmed.
 */
async function txStep(id, label, role, signer, via, build) {
  let rec = txRecord(id);
  if (rec?.status === 'pending') await resolvePending(rec);
  if (rec?.status === 'confirmed') return rec;
  for (let attempt = 1; ; attempt++) {
    const built = await build();
    built.tx.partialSign(signer);
    const wire = built.tx.serialize(); // throws unless every signature is present and valid
    const signature = b58(built.tx.signature);
    rec = upsertTx({
      id, label, signer: role, address: signer.publicKey.toBase58(), via, signature, status: 'pending',
      lastValidBlockHeight: built.lastValidBlockHeight, bytes: wire.length, ...built.public, explorer: explorerTx(signature),
    });
    save(); // on disk before the first byte leaves this process
    let out;
    try { out = await deliver({ wire, signature, lastValidBlockHeight: built.lastValidBlockHeight, via }); } catch (e) {
      if (e.landedFailure) { rec.status = 'failed'; rec.error = redact(e.message); save(); }
      throw e;
    }
    if (out.kind === 'confirmed') {
      Object.assign(rec, { status: 'confirmed', confirmation: out.confirmation, slot: out.slot, computeSimulated: out.compute ?? null, recordedAt: new Date().toISOString() });
      save();
      log(`${label}: ${signature}`);
      return rec;
    }
    rec.status = out.kind; rec.error = redact(out.error); save(); // rejected or expired: it can never land
    if (attempt >= 3) throw new Error(`${label}: ${out.kind} after ${attempt} attempts. ${redact(out.error)}${out.logs?.length ? '\n' + out.logs.join('\n') : ''}`);
    await sleep(2000);
  }
}
/** A wallet action through the backend: prepare, check, sign here, send. */
function backendStep(id, label, role, wallets, body, expect) {
  return txStep(id, label, role, wallets[role], 'backend /api/prepare + /api/send', async () => {
    const prepared = await prepare(wallets[role], body, label);
    const { tx, terms } = checkPrepared(prepared, wallets[role], body, expect);
    const extra = body.action === 'create'
      ? { campaign: prepared.createdCampaign, config: prepared.createdConfig, closeTime: terms.closeTime, expiry: terms.expiry, disclosedCostLamports: prepared.costs.totalLamports, minimumTokens: prepared.quoteDetails.minimumTokens }
      : { campaign: body.campaign, ...(body.amount ? { amountSol: body.amount } : {}) };
    return { tx, lastValidBlockHeight: prepared.lastValidBlockHeight, public: extra };
  });
}

/**
 * A transaction the program must refuse. It is signed and simulated on the RPC node with
 * signature verification and is never sent, whatever the result.
 */
async function expectRefusal(id, label, signer, build, expected) {
  if (ev.refusals.some((r) => r.id === id)) return;
  let observed = null, err = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const tx = await build();
    tx.partialSign(signer);
    const sim = await retry(() => connection.simulateTransaction(VersionedTransaction.deserialize(tx.serialize()), { sigVerify: true, commitment: 'confirmed', minContextSlot: lastSlot || undefined }), 8, 1500);
    err = sim.value.err;
    const code = JSON.stringify(err || '').match(/"Custom":(\d+)/)?.[1];
    observed = err ? (code ? lc.ERRORS[Number(code)] || `custom error ${code}` : JSON.stringify(err)) : 'accepted';
    if (err && (!expected || observed === expected)) break;
    await sleep(2000); // a lagging node can answer from older state
  }
  ev.refusals.push({ id, label, expected: expected || 'any refusal', observed, broadcast: false, checkedAt: new Date().toISOString() });
  save();
  if (!err || (expected && observed !== expected)) throw new Error(`Refusal check failed: ${label}. Expected ${expected || 'a refusal'}, observed ${observed}. Nothing was sent.`);
  log(`refused as expected (${observed}): ${label}`);
}
const viaBackend = (wallet, body, expect) => async () => checkPrepared(await prepare(wallet, body, body.action), wallet, body, expect).tx;
async function withBlockhash(tx, feePayer) {
  const { blockhash, lastValidBlockHeight } = await retry(() => connection.getLatestBlockhash('confirmed'));
  tx.feePayer = feePayer; tx.recentBlockhash = blockhash;
  return { tx, lastValidBlockHeight };
}

// ---------------------------------------------------------------- recover.cjs, with the backend out of the picture

function runRecoverCli(extra) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'recover.cjs'), '--rpc', RPC_URL, '--program', PROGRAM.toBase58(), ...extra], { cwd: ROOT, encoding: 'utf8', timeout: 180_000, maxBuffer: 1 << 20 });
  const stdout = redact(r.stdout || '');
  const stderr = redact(r.stderr || (r.error ? r.error.message : '')).split('\n').filter((line) => line.trim() && !line.startsWith('bigint:')).join('\n');
  let json = null;
  try { json = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)); } catch { /* not JSON */ }
  return { code: r.status, json, stderr: stderr.trim() };
}
/** What recover.cjs reports for a wallet, read-only. Retried because it reads the newest block's time. */
async function cliInspect(campaign, wallet) {
  let r;
  for (let attempt = 1; attempt <= 5; attempt++) {
    r = runRecoverCli(['--campaign', campaign, '--wallet', wallet.publicKey.toBase58()]);
    if (r.code === 0 && r.json) return r.json;
    await sleep(3000);
  }
  throw new Error(`recover.cjs could not read campaign ${campaign}: ${r.stderr}`);
}
/** One refund, claim or withdrawal sent by recover.cjs itself from the wallet's key file. */
async function cliStep(id, label, role, wallets, campaign, action) {
  let rec = txRecord(id);
  if (rec?.status === 'confirmed') return rec;
  const wallet = wallets[role];
  const receipt = lc.deriveReceipt(PROGRAM, new PublicKey(campaign), wallet.publicKey)[0];
  // recover.cjs only prints the signature at the end, so a stopped run is resolved from the receipt
  const landedSignature = async () => {
    if (await receiptOf(campaign, wallet.publicKey)) return null;
    const history = await retry(() => connection.getSignaturesForAddress(receipt, { limit: 10 }, 'confirmed'));
    return history.find((h) => !h.err)?.signature || null;
  };
  let signature = rec?.status === 'started' ? await landedSignature() : null;
  rec = upsertTx({
    id, label, signer: role, address: wallet.publicKey.toBase58(), via: 'recover.cjs over RPC, no backend', status: 'started', campaign,
    command: `node recover.cjs --rpc [rpc] --program ${PROGRAM.toBase58()} --campaign ${campaign} --keypair [${role} key file] --action ${action} --send`,
  });
  save();
  let lastError = '';
  for (let attempt = 1; !signature && attempt <= 4; attempt++) {
    const r = runRecoverCli(['--campaign', campaign, '--keypair', walletFile(role), '--action', action, '--send']);
    if (r.code === 0 && r.json?.signature) { signature = r.json.signature; break; }
    lastError = r.stderr;
    await sleep(4000);
    signature = await landedSignature(); // it may have landed although the CLI did not see it confirm
  }
  if (!signature) throw new Error(`${label}: recover.cjs did not complete. ${lastError}`);
  let st = null;
  for (let i = 0; i < 20 && !st; i++) { st = await signatureStatus(signature); if (!st) await sleep(2000); }
  if (!st) throw new Error(`${label}: signature ${signature} is not confirmed yet. Run the phase again.`);
  Object.assign(rec, { status: 'confirmed', signature, confirmation: st.confirmation, slot: st.slot, explorer: explorerTx(signature), recordedAt: new Date().toISOString() });
  save();
  log(`${label}: ${signature}`);
  return rec;
}
async function requireBackendStopped() {
  const probe = await backendReachable();
  if (probe.reachable) throw new Error(`The backend at ${API} is still answering. Stop it first: this phase shows recovery without it.`);
  return { backendReachable: false, probe: `${API}/api/environment`, result: probe.reason, checkedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------- preflight (read-only)

async function clusterGuard() {
  let u;
  try { u = new URL(RPC_URL); } catch { throw new Error('LAUNCH_RPC_URL is not a valid URL.'); }
  rpcHost = u.host;
  const apiUrl = new URL(API);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname)) throw new Error('LAUNCH_API_URL must be a loopback address: signed transactions are only handed to the local backend.');
  connection = new Connection(RPC_URL, 'confirmed');
  const genesis = await retry(() => connection.getGenesisHash(), 3, 1500);
  if (genesis !== DEVNET_GENESIS) throw new Error(`The RPC node at ${rpcHost} is not Solana devnet (genesis ${genesis}). This script only runs on devnet.`);
}
function resolveProgram() {
  let address = args.program || process.env.DEVNET_PROGRAM_ID || ev?.programId;
  if (!address && fs.existsSync(path.join(ROOT, 'deployment.json'))) address = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployment.json'), 'utf8')).programId;
  if (!address) throw new Error('No program address. Set DEVNET_PROGRAM_ID (as for the backend) or pass --program.');
  if (ev && ev.programId !== address) throw new Error(`This run was started against program ${ev.programId}, not ${address}.`);
  PROGRAM = new PublicKey(address);
}
/** What is deployed and who can change it. Read-only; the result is disclosed in the evidence. */
async function programFacts() {
  const info = await retry(() => connection.getAccountInfo(PROGRAM, 'confirmed'));
  if (!info?.executable) throw new Error(`${PROGRAM.toBase58()} is not an executable program on devnet. Deploy it first.`);
  const facts = { programId: PROGRAM.toBase58(), loader: info.owner.toBase58(), audited: false };
  if (facts.loader !== UPGRADEABLE_LOADER || info.data.readUInt32LE(0) !== 2) throw new Error('The program is not an upgradeable-loader program; this script does not know how to describe it.');
  const programData = new PublicKey(info.data.subarray(4, 36));
  const data = (await retry(() => connection.getAccountInfo(programData, 'confirmed')))?.data;
  if (!data || data.readUInt32LE(0) !== 3) throw new Error('The program data account is missing.');
  const local = fs.readFileSync(path.join(ROOT, 'program/build/launch_commitments.so'));
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  Object.assign(facts, {
    programData: programData.toBase58(), lastDeployedSlot: Number(data.readBigUInt64LE(4)),
    upgradeAuthority: data[12] === 1 ? new PublicKey(data.subarray(13, 45)).toBase58() : null,
    deployedSha256: sha(data.subarray(45, 45 + local.length)), localBuildSha256: sha(local),
  });
  facts.upgradeable = facts.upgradeAuthority !== null;
  facts.matchesLocalBuild = facts.deployedSha256 === facts.localBuildSha256 && data.subarray(45 + local.length).every((b) => b === 0);
  if (!facts.matchesLocalBuild) throw new Error('The deployed program bytes differ from program/build/launch_commitments.so. Evidence would not describe the reviewed build; nothing was sent.');
  for (const [name, id] of [['DBC', lc.DBC_PROGRAM_ID], ['Metaplex token metadata', lc.METADATA_PROGRAM_ID]]) {
    if (!(await retry(() => connection.getAccountInfo(id, 'confirmed')))?.executable) throw new Error(`${name} is not present on this cluster.`);
  }
  return facts;
}
async function backendEnvironment() {
  const r = await api('GET', '/api/environment', null, 20_000);
  if (r.status !== 200) throw new Error(`The backend at ${API} is not ready (${r.status ? 'HTTP ' + r.status + ' ' + r.error : r.error}). Start it with DEVNET_PROGRAM_ID=${PROGRAM.toBase58()} node runtime/devnet-server.cjs`);
  const env = r.json;
  assert.equal(env.network, 'devnet', 'the backend is not in devnet mode');
  assert.equal(env.genesisHash, DEVNET_GENESIS, 'the backend is not connected to devnet');
  assert.equal(env.programId, PROGRAM.toBase58(), 'the backend serves a different program');
  assert.equal(env.holdsWalletKeys, false);
  return env;
}
async function fundingPlan(env, withExpiry) {
  const [configRent, campaignRent, rentFloor, receiptRent, tokenAccountRent] = await Promise.all(
    [lc.CONFIG_SIZE, lc.CAMPAIGN_SIZE, 0, lc.RECEIPT_SIZE, 165].map((size) => retry(() => connection.getMinimumBalanceForRentExemption(size)).then(BigInt)),
  );
  const keys = withExpiry ? ['launch', 'underfunded', 'expiry'] : ['launch', 'underfunded'];
  const setupBudget = BigInt(env.preset.setupBudgetLamports);
  const creationCost = setupBudget + configRent + campaignRent + rentFloor + 2n * FEE;
  const perWallet = { organizer: BigInt(keys.length) * creationCost + MARGIN };
  for (const role of CONTRIBUTORS) perWallet[role] = sum(keys.map((k) => PLAN[k].contributions[role] + receiptRent)) + tokenAccountRent + MARGIN;
  const total = sum(Object.values(perWallet));
  return {
    campaigns: keys, setupBudgetLamports: setupBudget, creationCostLamports: creationCost, receiptRentLamports: receiptRent, tokenAccountRentLamports: tokenAccountRent, rentFloorLamports: rentFloor,
    perWalletLamports: perWallet, totalLamports: total, payerMustHoldLamports: total + FEE + PAYER_RESERVE,
    notRecoverableLamports: BigInt(keys.length) * creationCost + PLAN.launch.target + 2n * tokenAccountRent,
    note: 'Setup budget and account rent of every campaign stay locked in this version, including the campaign that fails. The launch target is spent on tokens.',
  };
}

// ---------------------------------------------------------------- phase: plan and status

async function phasePlan({ dryRunOf } = {}) {
  const payer = loadPayer();
  const facts = await programFacts();
  const probe = await backendReachable();
  const env = probe.reachable ? await backendEnvironment() : null;
  const withExpiry = ev ? ev.options.withExpiry : args.withExpiry;
  const plan = env ? await fundingPlan(env, withExpiry) : null;
  const balance = BigInt(await retry(() => connection.getBalance(payer.publicKey, 'confirmed')));
  const out = {
    network: 'devnet', genesisHash: DEVNET_GENESIS, rpcHost, backend: probe.reachable ? API : `${API} not reachable (${probe.reason}); start it to see the funding plan`,
    program: facts, fundingKey: payer.publicKey.toBase58(), fundingKeyIsUpgradeAuthority: facts.upgradeAuthority === payer.publicKey.toBase58(),
    fundingKeyBalanceLamports: balance, fundingPlan: plan,
    sufficient: plan ? (confirmed('fund') ? 'already funded' : balance >= plan.payerMustHoldLamports) : null,
    shortfallLamports: plan && !confirmed('fund') && balance < plan.payerMustHoldLamports ? plan.payerMustHoldLamports - balance : 0n,
    runDirectory: path.relative(ROOT, DIR), existingRun: ev ? { phases: ev.phases, transactions: ev.transactions.length, wallets: ev.wallets } : null,
    sent: 'nothing; this is a read-only plan',
  };
  console.log(redact(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)));
  if (dryRunOf) console.log(`\nDry run of "${dryRunOf}". Nothing was sent and no wallet was created. Add --execute to run it.`);
}
async function phaseStatus() {
  if (!ev) { console.log(`No run recorded in ${path.relative(ROOT, DIR)}.`); return; }
  const now = await chainNow();
  const campaigns = {};
  for (const [key, c] of Object.entries(ev.campaigns)) {
    const s = await campaignState(c.address);
    campaigns[key] = { address: c.address, phase: lc.phase(s, now), total: s.totalContributed, target: s.target, openReceipts: s.receiptCount, refunded: s.refunded, tokensClaimed: s.tokensClaimed, secondsToClose: s.closeTime - now, secondsToExpiry: s.expiry - now };
  }
  console.log(redact(JSON.stringify({
    evidence: path.relative(ROOT, EVIDENCE), chainTime: now, phases: ev.phases, campaigns,
    transactions: ev.transactions.map((t) => ({ id: t.id, status: t.status, signature: t.signature })), refusals: ev.refusals.length, checks: ev.checks.length, warnings: ev.warnings, result: ev.result || null,
  }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)));
}

// ---------------------------------------------------------------- phase: launch

/** Balance checks of one claim or refund, taken from the transaction's own recorded balances. */
async function verifyPayout(id, { signature, wallet, campaign, vault, principalOut, mint, tokensOut }) {
  const m = await txMeta(signature);
  if (!m) { warn(`${id}: the RPC node did not return transaction details, so per-transaction balances were not checked. Campaign counters were.`); return null; }
  const receipt = lc.deriveReceipt(PROGRAM, new PublicKey(campaign), wallet)[0];
  const w = m.lamports(wallet), v = m.lamports(vault), r = m.lamports(receipt);
  const tokenAccount = mint ? m.lamports(getAssociatedTokenAddressSync(mint, wallet, true)) : null;
  const tokenAccountRentPaid = tokenAccount ? tokenAccount.post - tokenAccount.pre : 0n;
  const detail = {
    signature, feeLamports: m.fee, vaultPaidLamports: v.pre - v.post, expectedFromVaultLamports: principalOut,
    walletChangeLamports: w.post - w.pre, receiptRentReturnedLamports: r.pre, receiptClosed: r.post === 0n, tokenAccountRentPaidLamports: tokenAccountRentPaid,
  };
  let ok = m.feePayer === wallet.toBase58() && v.pre - v.post === principalOut && r.post === 0n
    && w.post - w.pre === principalOut + r.pre - tokenAccountRentPaid - m.fee;
  if (mint) {
    const t = m.tokens(wallet, mint);
    detail.tokensReceived = t.post - t.pre; detail.expectedTokens = tokensOut;
    ok = ok && t.post - t.pre === tokensOut;
  }
  check(id, ok, detail);
  return detail;
}

async function phaseLaunch() {
  const env = await backendEnvironment();
  const facts = await programFacts();
  const payer = loadPayer();
  const minutes = ev ? ev.options.minutes : args.minutes || 1;
  const withExpiry = ev ? ev.options.withExpiry : args.withExpiry;
  if (ev && ((args.minutes && args.minutes !== minutes) || (args.withExpiry && !withExpiry))) throw new Error('This run was started with different options. Resume it without them, or start another with --run LABEL.');
  const plan = await fundingPlan(env, withExpiry);
  const settlementWindow = BigInt(env.preset.settlementWindowSeconds);

  // Balance first. On a fresh run no wallet exists and nothing has been sent until this passes.
  const requireFundingBalance = async () => {
    const balance = BigInt(await retry(() => connection.getBalance(payer.publicKey, 'confirmed')));
    if (balance < plan.payerMustHoldLamports) {
      throw new CannotContinue(`The funding key ${payer.publicKey.toBase58()} holds ${sol(balance)} devnet SOL; this run needs ${sol(plan.payerMustHoldLamports)} (${sol(plan.totalLamports)} for the test wallets, the rest is fee and reserve). Short by ${sol(plan.payerMustHoldLamports - balance)}. The funding transfer was not sent.`);
    }
  };
  if (!ev) await requireFundingBalance();

  const wallets = loadWallets({ create: !ev });
  const addresses = Object.fromEntries(ROLES.map((r) => [r, wallets[r].publicKey.toBase58()]));
  if (ROLES.some((r) => wallets[r].publicKey.equals(payer.publicKey))) throw new Error('A test wallet equals the funding key.');
  if (!ev) {
    ev = {
      schema: 'launch-commitments/public-devnet-proof/v1', network: 'devnet', genesisHash: DEVNET_GENESIS, rpcHost,
      programId: PROGRAM.toBase58(), program: facts, startedAt: new Date().toISOString(), updatedAt: null,
      disclosures: [
        'Devnet test SOL only. Every wallet here is a test wallet generated and funded by the build team. This is not usage, volume, traction or demand.',
        facts.upgradeable
          ? `The program is upgradeable and its upgrade authority (${facts.upgradeAuthority}) is retained. Whoever holds that key can replace the program, including the rules that protect the vaults. The program is not audited.`
          : 'The program has no upgrade authority, so it cannot be changed, including to fix a defect. The program is not audited.',
        'The devnet preset scales the curve’s SOL amounts by 0.01. Amounts are test configurations, not valuations.',
        'The setup budget and account rent of each campaign are paid by the organizer and are not recoverable in this version, including for a campaign that fails.',
        'The pooled first purchase pays DBC’s 1% trading fee like any other trade, and can get a lower average price than later buyers.',
      ],
      fundingKey: payer.publicKey.toBase58(), wallets: addresses, options: { minutes, withExpiry },
      fundingPlan: plan, backend: { url: API, holdsWalletKeys: env.holdsWalletKeys, preset: env.preset },
      campaigns: {}, transactions: [], refusals: [], checks: [], warnings: [], phases: {}, notDemonstrated: [], result: null,
    };
    save(); // wallet files and their addresses are on disk before the funding transfer is built
    log(`test wallets written to ${path.relative(ROOT, DIR)}/ (mode 0600); evidence at ${path.relative(ROOT, EVIDENCE)}`);
  } else if (ROLES.some((r) => ev.wallets[r] !== addresses[r])) {
    throw new Error('The wallet files do not match the addresses recorded for this run. Restore the original files.');
  }
  startPhase('launch');
  const keys = campaignKeys();

  // 1. one transfer from the funding key to the three test wallets
  await txStep('fund', 'funding key funds the three test wallets', 'fundingKey', payer, 'backend /api/send', async () => {
    await requireFundingBalance(); // also on a resumed run, where an earlier transfer may have expired unsent
    const tx = new Transaction();
    for (const role of ROLES) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wallets[role].publicKey, lamports: plan.perWalletLamports[role] }));
    return { ...await withBlockhash(tx, payer.publicKey), public: { lamports: plan.perWalletLamports } };
  });

  // 2. the campaigns, created together so their funding windows run side by side
  const created = await Promise.allSettled(keys.map((key) => backendStep(
    `create:${key}`, `organizer creates the ${key} campaign`, 'organizer', wallets,
    { action: 'create', target: sol(PLAN[key].target), minutes, name: PLAN[key].name, symbol: PLAN[key].symbol },
    { target: PLAN[key].target, maxBudget: plan.setupBudgetLamports, settlementWindow },
  )));
  const createFailure = created.find((r) => r.status === 'rejected');
  if (createFailure) throw createFailure.reason;
  const address = Object.fromEntries(keys.map((k) => [k, txRecord(`create:${k}`).campaign]));
  const closeTime = Object.fromEntries(keys.map((k) => [k, BigInt(txRecord(`create:${k}`).closeTime)]));
  const expiry = Object.fromEntries(keys.map((k) => [k, BigInt(txRecord(`create:${k}`).expiry)]));

  // 3. contributions, each contributor in parallel; the ones the launch depends on go first
  const contribute = async (key, role) => {
    const id = `contribute:${key}:${role}`;
    if (!confirmed(id) && txRecord(id)?.status !== 'pending' && await chainNow() >= closeTime[key] - 4n) {
      throw new CannotContinue(`The funding window of the ${key} campaign closed before ${role}'s contribution was sent, so this run cannot show what it set out to. Nothing is lost: run --phase recover-all --execute to return every open contribution, then start again with --run LABEL${minutes === 1 ? ' and consider --minutes 2' : ''}.`);
    }
    const amount = PLAN[key].contributions[role];
    await backendStep(id, `${role} contributes ${sol(amount)} SOL to the ${key} campaign`, role, wallets, { action: 'contribute', campaign: address[key], amount: sol(amount) }, { amount });
  };
  const flows = await Promise.allSettled(CONTRIBUTORS.map(async (role) => {
    for (const key of keys) await contribute(key, role);
    if (role === 'bob' && !confirmed('withdraw:launch:bob') && !ev.campaigns.launch?.atClose) {
      // optional: shows a withdrawal before close. Skipped, not failed, if the window is nearly over.
      const skipped = 'The partial withdrawal before close was skipped because the funding window was nearly over.';
      if (txRecord('withdraw:launch:bob')?.status === 'pending' || await chainNow() < closeTime.launch - 12n) {
        try {
          await backendStep('withdraw:launch:bob', `bob withdraws ${sol(PLAN.launch.bobWithdraws)} SOL from the launch campaign before close`, 'bob', wallets, { action: 'withdraw', campaign: address.launch, amount: sol(PLAN.launch.bobWithdraws) }, { amount: PLAN.launch.bobWithdraws });
        } catch (e) {
          if (e.landedFailure || await chainNow() < closeTime.launch - 12n) throw e;
          warn(skipped);
        }
      } else warn(skipped);
    }
  }));
  const flowFailure = flows.find((r) => r.status === 'rejected');
  if (flowFailure) throw flowFailure.reason;

  // 4. the terms on chain, read directly from the RPC node
  for (const key of keys) {
    if (ev.campaigns[key]) continue;
    const c = await campaignState(address[key]);
    const configInfo = await readAccount(c.config);
    const terms = {
      address: address[key], explorer: explorerAddress(address[key]), name: c.name, symbol: c.symbol,
      organizer: c.organizer.toBase58(), beneficiary: c.beneficiary.toBase58(), config: c.config.toBase58(), configHash: c.configHash,
      vault: lc.deriveVault(PROGRAM, address[key])[0].toBase58(), mint: c.mint.toBase58(),
      target: c.target, minTokens: c.minTokens, closeTime: c.closeTime, expiry: c.expiry, fundingWindowSeconds: c.closeTime - c.createdAt,
    };
    const preset = lc.checkConfigPreset(configInfo.data, c.target);
    check(`terms:${key}`, terms.organizer === ev.wallets.organizer && terms.beneficiary === ev.wallets.organizer && c.target === PLAN[key].target
      && terms.config === txRecord(`create:${key}`).config && c.closeTime === closeTime[key] && c.expiry - c.closeTime === settlementWindow
      && lc.hashConfig(configInfo.data) === c.configHash && preset.ok, { ...terms, configMatchesHash: lc.hashConfig(configInfo.data) === c.configHash, presetViolations: preset.violations });
    ev.campaigns[key] = terms; save();
  }

  // 5. while funding is open the program refuses to launch or refund (simulated, never sent)
  if (await chainNow() < closeTime.launch - 8n) {
    await expectRefusal('refusal:early-settle', 'launching before the funding window closes', wallets.bob, viaBackend(wallets.bob, { action: 'settle', campaign: address.launch }), 'FundingStillOpen');
    await expectRefusal('refusal:early-refund', 'refunding before the funding window closes', wallets.bob, viaBackend(wallets.bob, { action: 'refund', campaign: address.underfunded }), 'RefundNotAvailable');
  } else if (!ev.refusals.some((r) => r.id === 'refusal:early-settle')) warn('The before-close refusal checks were skipped because the funding window was nearly over.');

  // 6. the real funding window
  const lastClose = keys.map((k) => closeTime[k]).reduce((a, b) => (a > b ? a : b));
  await waitForChainTime(lastClose + 3n, 'the funding windows to close');

  // 7. what each campaign holds at close; contributions cannot change after this
  for (const key of keys) {
    if (ev.campaigns[key].atClose) continue;
    const c = await campaignState(address[key]);
    if (c.state !== lc.STATE.Open) throw new CannotContinue(`The ${key} campaign was settled by another wallet before this run recorded its contributions. Start again with --run LABEL.`);
    const contributions = {};
    for (const role of CONTRIBUTORS) contributions[role] = (await receiptOf(address[key], wallets[role].publicKey))?.amount ?? 0n;
    ev.campaigns[key].atClose = { total: c.totalContributed, contributions, receipts: c.receiptCount, phase: lc.phase(c, await chainNow()) };
    save();
  }
  const A = ev.campaigns.launch, B = ev.campaigns.underfunded;
  const big = (v) => BigInt(v);
  if (big(A.atClose.total) < PLAN.launch.target) {
    throw new CannotContinue('The launch campaign closed below its target, so this run cannot show a launch. Nothing is lost: run --phase recover-all --execute to refund it, then start again with --run LABEL.');
  }
  check('at-close:launch', A.atClose.phase === 'settleable' && big(A.atClose.total) === sum(CONTRIBUTORS.map((r) => big(A.atClose.contributions[r]))), A.atClose);
  check('at-close:underfunded', B.atClose.phase === 'refundable' && big(B.atClose.total) < PLAN.underfunded.target && big(B.atClose.total) === sum(CONTRIBUTORS.map((r) => PLAN.underfunded.contributions[r])), B.atClose);
  if (withExpiry) check('at-close:expiry', ev.campaigns.expiry.atClose.phase === 'settleable' && big(ev.campaigns.expiry.atClose.total) >= PLAN.expiry.target, ev.campaigns.expiry.atClose);

  // 8. after close: no late contribution, no launch of an underfunded campaign, no early refund of a funded one
  if (!confirmed('settle:launch')) {
    await expectRefusal('refusal:late-contribution', 'contributing after the funding window closed', wallets.alice, viaBackend(wallets.alice, { action: 'contribute', campaign: A.address, amount: '0.001' }, { amount: 1_000_000n }), 'FundingClosed');
  }
  if (await chainNow() < expiry.underfunded - 10n) {
    await expectRefusal('refusal:settle-underfunded', 'launching the underfunded campaign', wallets.bob, viaBackend(wallets.bob, { action: 'settle', campaign: B.address }), 'TargetNotReached');
  }
  if (withExpiry && await chainNow() < expiry.expiry - 10n) {
    await expectRefusal('refusal:refund-before-expiry', 'refunding a funded campaign before its expiry', wallets.alice, viaBackend(wallets.alice, { action: 'refund', campaign: ev.campaigns.expiry.address }), 'RefundNotAvailable');
  }

  // 9. the launch, sent by a contributor. The organizer signs nothing after creation.
  if (!confirmed('settle:launch') && txRecord('settle:launch')?.status !== 'pending' && await chainNow() >= expiry.launch - 15n) {
    throw new CannotContinue('The launch campaign reached its expiry before it was launched in this run. Nothing is lost: run --phase recover-all --execute to refund it, then start again with --run LABEL.');
  }
  const settle = await backendStep('settle:launch', 'bob, a contributor and not the organizer, executes the launch', 'bob', wallets, { action: 'settle', campaign: A.address });
  const settled = await campaignState(A.address);
  const mint = settled.mint, vault = new PublicKey(A.vault);
  if (!A.settled) {
    const m = await txMeta(settle.signature);
    const budget = lc.deriveBudget(PROGRAM, A.address)[0];
    A.settled = {
      signature: settle.signature, settledBy: ev.wallets.bob, organizerSigned: false, mint: mint.toBase58(), mintExplorer: explorerAddress(mint.toBase58()),
      pool: lc.deriveSettlementAccounts(PROGRAM, A.address, settled.config).pool.toBase58(), tokensBought: settled.tokensBought, minTokens: settled.minTokens,
      vaultSpentLamports: m ? m.lamports(vault).pre - m.lamports(vault).post : null, setupBudgetSpentLamports: m ? m.lamports(budget).pre - m.lamports(budget).post : null,
      feePayer: m ? m.feePayer : null, signatures: m ? m.signatures : null,
    };
    save();
    if (!m) warn('settle: the RPC node did not return transaction details, so the vault’s exact spend was not checked from the transaction.');
  }
  check('launch:settled', settled.state === lc.STATE.Settled && settled.tokensBought >= settled.minTokens && settled.totalContributed === big(A.atClose.total)
    && settled.tokenAccount.equals(getAssociatedTokenAddressSync(mint, vault, true))
    && (A.settled.vaultSpentLamports === null || (big(A.settled.vaultSpentLamports) === PLAN.launch.target && A.settled.feePayer === ev.wallets.bob && A.settled.signatures === 1)), A.settled);

  // 10. pro rata claims: floor(c × bought / total) tokens and floor(c × (total − target) / total) lamports
  const total = big(A.atClose.total), bought = settled.tokensBought;
  const owed = Object.fromEntries(CONTRIBUTORS.map((r) => [r, lc.allocation({ contribution: big(A.atClose.contributions[r]), total, target: PLAN.launch.target, bought })]));
  A.allocation = Object.fromEntries(CONTRIBUTORS.map((r) => [r, { contribution: A.atClose.contributions[r], tokens: owed[r].tokens, excessLamports: owed[r].excess }]));
  save();
  for (const role of CONTRIBUTORS) {
    const claim = await backendStep(`claim:launch:${role}`, `${role} claims tokens and excess SOL`, role, wallets, { action: 'claim', campaign: A.address });
    await verifyPayout(`claim:launch:${role}`, { signature: claim.signature, wallet: wallets[role].publicKey, campaign: A.address, vault, principalOut: owed[role].excess, mint, tokensOut: owed[role].tokens });
  }
  const afterClaims = await campaignState(A.address);
  const tokensOut = sum(CONTRIBUTORS.map((r) => owed[r].tokens)), excessOut = sum(CONTRIBUTORS.map((r) => owed[r].excess));
  A.afterClaims = { tokensClaimed: afterClaims.tokensClaimed, excessPaidLamports: afterClaims.excessPaid, openReceipts: afterClaims.receiptCount, tokenDustLocked: bought - tokensOut, lamportDustLocked: total - PLAN.launch.target - excessOut };
  check('launch:pro-rata', afterClaims.tokensClaimed === tokensOut && afterClaims.excessPaid === excessOut && afterClaims.receiptCount === 0n
    && tokensOut <= bought && excessOut <= total - PLAN.launch.target && bought - tokensOut < BigInt(CONTRIBUTORS.length) && total - PLAN.launch.target - excessOut < BigInt(CONTRIBUTORS.length),
  { ...A.afterClaims, allocation: A.allocation, tokensBought: bought, totalContributed: total, target: PLAN.launch.target });
  await expectRefusal('refusal:second-claim', 'claiming a second time', wallets.alice, viaBackend(wallets.alice, { action: 'claim', campaign: A.address }), null);

  // 11. the failed launch: alice recovers through the backend; bob's refund is left for recover.cjs
  const refund = await backendStep('refund:underfunded:alice', 'alice recovers her contribution from the underfunded campaign', 'alice', wallets, { action: 'refund', campaign: B.address });
  await verifyPayout('refund:underfunded:alice', { signature: refund.signature, wallet: wallets.alice.publicKey, campaign: B.address, vault: new PublicKey(B.vault), principalOut: big(B.atClose.contributions.alice) });
  await expectRefusal('refusal:second-refund', 'refunding a second time', wallets.alice, viaBackend(wallets.alice, { action: 'refund', campaign: B.address }), null);
  const afterRefund = await campaignState(B.address);
  check('underfunded:first-refund', afterRefund.state === lc.STATE.Open && afterRefund.refunded === big(B.atClose.contributions.alice) && afterRefund.receiptCount === 1n,
    { refundedLamports: afterRefund.refunded, openReceipts: afterRefund.receiptCount, bobStillOwedLamports: B.atClose.contributions.bob });

  finishPhase('launch');
  console.log(`\nLaunch phase complete. Evidence: ${path.relative(ROOT, EVIDENCE)}\nNext: stop the backend, then run\n  node tests/public-devnet.cjs --phase refund-recovery --execute${args.run ? ' --run ' + args.run : ''}`);
  if (withExpiry) console.log(`After that, the funded campaign expires at chain time ${expiry.expiry} (about ${expiry.expiry - await chainNow()}s from now):\n  node tests/public-devnet.cjs --phase expiry-recovery --execute${args.run ? ' --run ' + args.run : ''}`);
}

// ---------------------------------------------------------------- phases: recovery without the backend

function requireRun() {
  if (!ev) throw new Error(`No run recorded in ${path.relative(ROOT, DIR)}. Run --phase launch first.`);
}
/** recover.cjs must see the refund itself, send it, and the chain must show exactly the principal returned. */
async function refundThroughCli(key, role, wallets, tag) {
  const c = ev.campaigns[key];
  const amount = BigInt(c.atClose.contributions[role]);
  const id = `${tag}:${key}:${role}`;
  if (!confirmed(id)) {
    const seen = await cliInspect(c.address, wallets[role]);
    check(`${id}:cli-sees-refund`, seen.phase === 'refundable' && seen.receipt && BigInt(seen.receipt.amount) === amount && seen.configMatches === true,
      { phase: seen.phase, receiptLamports: seen.receipt?.amount ?? null, configMatches: seen.configMatches, chainTime: seen.chainTime });
  }
  const rec = await cliStep(id, `${role} recovers ${sol(amount)} SOL from the ${key} campaign with recover.cjs`, role, wallets, c.address, 'refund');
  await verifyPayout(id, { signature: rec.signature, wallet: wallets[role].publicKey, campaign: c.address, vault: new PublicKey(c.vault), principalOut: amount });
  if (!ev.refusals.some((r) => r.id === `refusal:${id}:again`)) {
    const again = runRecoverCli(['--campaign', c.address, '--wallet', wallets[role].publicKey.toBase58(), '--action', 'refund']);
    ev.refusals.push({ id: `refusal:${id}:again`, label: `recover.cjs asked to refund ${role} a second time`, expected: 'refused before any transaction is built', observed: again.code === 0 ? 'accepted' : again.stderr.split('\n')[0], broadcast: false, checkedAt: new Date().toISOString() });
    save();
    if (again.code === 0) throw new Error('recover.cjs prepared a second refund for a closed receipt.');
  }
}

async function phaseRefundRecovery() {
  requireRun();
  if (ev.phases.launch?.status !== 'complete') throw new Error('The launch phase has not completed. Finish it first, or use --phase recover-all after a run that cannot finish.');
  const stopped = await requireBackendStopped();
  startPhase('refund-recovery');
  ev.phases['refund-recovery'].backend = stopped; save();
  const wallets = loadWallets({ create: false });
  const B = ev.campaigns.underfunded;
  await refundThroughCli('underfunded', 'bob', wallets, 'recover');
  const after = await campaignState(B.address);
  const mintInfo = await readAccount(B.mint);
  B.final = { state: 'open, never launched', refundedLamports: after.refunded, totalContributedLamports: after.totalContributed, openReceipts: after.receiptCount, tokenMintExists: mintInfo !== null };
  check('underfunded:fully-refunded', after.state === lc.STATE.Open && after.refunded === after.totalContributed && after.refunded === BigInt(B.atClose.total) && after.receiptCount === 0n && mintInfo === null, B.final);
  finishPhase('refund-recovery');
  conclude();
  console.log(`\nRefund recovery complete without the backend. Evidence: ${path.relative(ROOT, EVIDENCE)}`);
  if (ev.options.withExpiry && ev.phases['expiry-recovery']?.status !== 'complete') console.log(`Keep the backend stopped and run, once the funded campaign has expired:\n  node tests/public-devnet.cjs --phase expiry-recovery --execute${args.run ? ' --run ' + args.run : ''}`);
}

async function phaseExpiryRecovery() {
  requireRun();
  if (!ev.options.withExpiry) throw new Error('This run has no funded-but-unlaunched campaign. It is only created by --phase launch --with-expiry.');
  if (ev.phases.launch?.status !== 'complete') throw new Error('The launch phase has not completed.');
  const stopped = await requireBackendStopped();
  startPhase('expiry-recovery');
  ev.phases['expiry-recovery'].backend = stopped; save();
  const wallets = loadWallets({ create: false });
  const C = ev.campaigns.expiry;
  await waitForChainTime(BigInt(C.expiry) + 3n, 'the funded campaign to expire');
  const atExpiry = await campaignState(C.address);
  if (atExpiry.state !== lc.STATE.Open) {
    throw new CannotContinue('Another wallet launched the funded campaign before it expired, which the program allows. The expiry refund cannot be shown in this run; run --phase recover-all --execute to claim the allocations instead.');
  }
  check('expiry:funded-and-unlaunched', atExpiry.totalContributed >= atExpiry.target && lc.phase(atExpiry, await chainNow()) === 'refundable',
    { totalContributedLamports: atExpiry.totalContributed, targetLamports: atExpiry.target, expiry: atExpiry.expiry });
  // after expiry nobody can launch it any more, the organizer included (simulated, never sent)
  await expectRefusal('refusal:settle-after-expiry', 'launching the funded campaign after its expiry', wallets.organizer, async () => {
    const built = await lc.settle({ programId: PROGRAM, campaign: C.address, config: atExpiry.config, beneficiary: atExpiry.beneficiary });
    return (await withBlockhash(built.transaction, wallets.organizer.publicKey)).tx;
  }, 'SettlementExpired');
  for (const role of CONTRIBUTORS) await refundThroughCli('expiry', role, wallets, 'recover');
  const after = await campaignState(C.address);
  const mintInfo = await readAccount(C.mint);
  C.final = { state: 'open, never launched', refundedLamports: after.refunded, totalContributedLamports: after.totalContributed, openReceipts: after.receiptCount, tokenMintExists: mintInfo !== null };
  check('expiry:fully-refunded', after.state === lc.STATE.Open && after.refunded === after.totalContributed && after.receiptCount === 0n && mintInfo === null, C.final);
  finishPhase('expiry-recovery');
  conclude();
  console.log(`\nExpiry recovery complete without the backend. Evidence: ${path.relative(ROOT, EVIDENCE)}`);
}

/** Write the summary once every phase this run planned has finished. */
function conclude() {
  ev.notDemonstrated = [
    ...(ev.options.withExpiry ? [] : ['Refund of a funded campaign that nobody launches before expiry: not run on devnet in this proof. Tested locally only (sdk/selftest.test.cjs in LiteSVM, at the exact expiry boundary).']),
    'Public trading on the curve, graduation and DAMM v2 migration: not run on devnet in this proof. Tested against a local validator only (tests/devnet-api.cjs).',
    'Signing with a real wallet extension, any participant outside the build team, and any mainnet use.',
  ];
  const needed = ['launch', 'refund-recovery', ...(ev.options.withExpiry ? ['expiry-recovery'] : [])];
  if (!needed.every((p) => ev.phases[p]?.status === 'complete')) { save(); return; }
  ev.result = {
    passed: ev.checks.every((c) => c.ok), completedAt: new Date().toISOString(),
    demonstrated: [
      'Two campaigns open at the same time with a real funding window, one reaching its target and one not.',
      'Launch executed by a contributor without the organizer; the vault spent exactly the target.',
      'Pro rata token and excess-SOL claims, checked against each transaction’s recorded balances.',
      'Refund of the underfunded campaign through the backend, and again through recover.cjs with the backend stopped.',
      ...(ev.options.withExpiry ? ['Refund of a funded campaign that nobody launched, after its expiry, through recover.cjs with the backend stopped.'] : []),
    ],
    confirmedTransactions: ev.transactions.filter((t) => t.status === 'confirmed').length, refusalsSimulated: ev.refusals.length, warnings: ev.warnings.length,
  };
  save();
}

/** After a run that cannot finish: get every open contribution back through recover.cjs. */
async function phaseRecoverAll() {
  requireRun();
  const wallets = loadWallets({ create: false });
  const waiting = [];
  for (const record of ev.transactions.filter((t) => t.id.startsWith('create:') && t.campaign)) {
    const key = record.id.slice('create:'.length);
    if (!(await readAccount(record.campaign))) continue; // the creation never landed
    for (const role of CONTRIBUTORS) {
      const seen = await cliInspect(record.campaign, wallets[role]);
      if (!seen.receipt) continue;
      const action = { funding: 'withdraw', refundable: 'refund', settled: 'claim' }[seen.phase];
      if (!action) { waiting.push(`${role} in ${key}: funded and awaiting launch; refundable at chain time ${seen.terms.expiry}`); continue; }
      await cliStep(`recover-all:${key}:${role}`, `${role} recovers from the ${key} campaign with recover.cjs (${action})`, role, wallets, record.campaign, action);
    }
  }
  ev.phases['recover-all'] = { status: waiting.length ? 'waiting' : 'complete', completedAt: new Date().toISOString(), waiting }; save();
  console.log(waiting.length ? `Recovered what is recoverable now. Still locked until expiry:\n  ${waiting.join('\n  ')}\nRun this phase again after that time.` : 'Every open contribution of this run has been recovered.');
}

/** Return leftover test SOL to the funding key. Refuses while any contribution is still open. */
async function phaseSweep() {
  requireRun();
  const payer = loadPayer();
  if (payer.publicKey.toBase58() !== ev.fundingKey) throw new Error('DEPLOY_KEYPAIR is not the key that funded this run. Leftovers are only returned to that key.');
  const wallets = loadWallets({ create: false });
  for (const record of ev.transactions.filter((t) => t.id.startsWith('create:') && t.campaign)) {
    for (const role of CONTRIBUTORS) {
      if (await receiptOf(record.campaign, wallets[role].publicKey)) throw new Error(`${role} still has an open contribution in ${record.campaign}. Recover it first; the wallet needs its balance for the fee.`);
    }
  }
  for (const role of ROLES) {
    if (confirmed(`sweep:${role}`)) continue;
    const balance = BigInt(await retry(() => connection.getBalance(wallets[role].publicKey, 'confirmed')));
    if (balance <= FEE) continue;
    await txStep(`sweep:${role}`, `${role} returns ${sol(balance - FEE)} leftover test SOL to the funding key`, role, wallets[role], 'direct RPC', async () => {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallets[role].publicKey, toPubkey: payer.publicKey, lamports: balance - FEE }));
      return { ...await withBlockhash(tx, wallets[role].publicKey), public: { lamports: balance - FEE, to: ev.fundingKey } };
    });
  }
  ev.phases.sweep = { status: 'complete', completedAt: new Date().toISOString() }; save();
  console.log('Leftover test SOL returned to the funding key. Claimed test tokens stay in the test wallets; the key files are kept.');
}

/**
 * Sends nothing. Re-checks a recorded run against the cluster as it is now: every recorded
 * signature, the deployed program against the one the run started with, and recover.cjs's
 * answer to a second refund. Run it after the last phase; the result is added to the evidence.
 */
async function phaseVerify() {
  requireRun();
  const recorded = ev.transactions.filter((t) => t.signature);
  const transactions = [];
  for (let i = 0; i < recorded.length; i += 100) {
    const batch = recorded.slice(i, i + 100);
    const { value } = await retry(() => connection.getSignatureStatuses(batch.map((t) => t.signature), { searchTransactionHistory: true }));
    batch.forEach((t, j) => transactions.push({ id: t.id, signature: t.signature, recorded: t.status, now: value[j] ? (value[j].err ? 'failed' : value[j].confirmationStatus) : 'not found' }));
  }
  const finalized = transactions.filter((t) => t.recorded === 'confirmed').every((t) => t.now === 'finalized');
  let program;
  try { program = await programFacts(); } catch (e) { program = { error: redact(e.message) }; }
  const unchanged = !program.error && program.lastDeployedSlot === ev.program.lastDeployedSlot
    && program.deployedSha256 === ev.program.deployedSha256 && program.upgradeAuthority === ev.program.upgradeAuthority;
  let refusalsHold = true;
  for (const refusal of ev.refusals.filter((r) => r.id.endsWith(':again'))) {
    const [, , key, role] = refusal.id.split(':');
    const again = runRecoverCli(['--campaign', ev.campaigns[key].address, '--wallet', ev.wallets[role], '--action', 'refund']);
    refusal.observed = again.code === 0 ? 'accepted' : again.stderr.split('\n')[0];
    refusal.checkedAt = new Date().toISOString();
    if (again.code === 0) refusalsHold = false;
  }
  ev.verification = {
    checkedAt: new Date().toISOString(), sent: 'nothing',
    everyConfirmedTransactionFinalized: finalized, transactions,
    programUnchangedSinceRunStarted: unchanged,
    program: program.error ? program : { lastDeployedSlot: program.lastDeployedSlot, deployedSha256: program.deployedSha256, upgradeAuthority: program.upgradeAuthority },
    programAtRunStart: { lastDeployedSlot: ev.program.lastDeployedSlot, deployedSha256: ev.program.deployedSha256, upgradeAuthority: ev.program.upgradeAuthority },
    secondRefundsStillRefused: refusalsHold,
  };
  save();
  console.log(redact(JSON.stringify(ev.verification, null, 2)));
  if (!finalized || !unchanged || !refusalsHold) {
    throw new Error('Verification did not pass. If transactions are only "confirmed", wait a minute and run it again; anything else needs a look before the evidence is published.');
  }
}

// ---------------------------------------------------------------- main

async function main() {
  args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  DIR = path.join(ROOT, 'private', 'public-proof', args.run);
  EVIDENCE = path.join(DIR, 'public-evidence.json');
  if (fs.existsSync(EVIDENCE)) ev = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8'));
  if (ev && (ev.network !== 'devnet' || ev.genesisHash !== DEVNET_GENESIS)) throw new Error('The recorded run is not a devnet run.');

  await clusterGuard(); // nothing else happens unless the RPC node is devnet
  resolveProgram();
  log(`devnet verified at ${rpcHost}; program ${PROGRAM.toBase58()}; run directory ${path.relative(ROOT, DIR)}`);

  if (args.phase === 'plan') return phasePlan();
  if (args.phase === 'status') return phaseStatus();
  if (args.phase === 'verify') return phaseVerify();
  if (!args.execute) return phasePlan({ dryRunOf: args.phase });
  if (['launch', 'refund-recovery', 'expiry-recovery'].includes(args.phase) && ev?.phases[args.phase]?.status === 'complete') {
    throw new AlreadyDone(`Phase "${args.phase}" already completed at ${ev.phases[args.phase].completedAt}. Refusing to repeat it. Evidence: ${path.relative(ROOT, EVIDENCE)}`);
  }
  if (args.phase === 'launch') return phaseLaunch();
  if (args.phase === 'refund-recovery') return phaseRefundRecovery();
  if (args.phase === 'expiry-recovery') return phaseExpiryRecovery();
  if (args.phase === 'recover-all') return phaseRecoverAll();
  if (args.phase === 'sweep') return phaseSweep();
}

main().catch((e) => {
  console.error(redact(e instanceof CannotContinue || e instanceof AlreadyDone ? e.message : e.stack || e.message));
  if (ev && EVIDENCE && fs.existsSync(EVIDENCE)) console.error(`Evidence so far: ${path.relative(ROOT, EVIDENCE)}. Test wallet files are untouched.`);
  process.exitCode = e instanceof AlreadyDone ? 3 : e instanceof CannotContinue ? 2 : 1;
});
