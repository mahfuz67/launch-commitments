// In-memory Solana JSON-RPC node for the hosted-adapter tests. Requests are answered from
// the LiteSVM bank in runtime/vm.cjs, so the real program bytecode executes behind the
// same wire protocol a browser uses. Nothing here contacts a network.
const http = require('node:http');
const { Keypair, PublicKey, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const { createEnvironment } = require('../runtime/vm.cjs');
const { binary } = require('./harness.cjs');

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
// LiteSVM reports these without executing anything; a cluster would silently drop them.
const NEVER_LANDS = /BlockhashNotFound|AlreadyProcessed/;

function createRpc({ programId = Keypair.generate().publicKey.toBase58(), genesisHash = DEVNET_GENESIS, now = Math.floor(Date.now() / 1000) } = {}) {
  const e = createEnvironment({ programId, programPath: binary(), now });
  const statuses = new Map(), faults = new Map(), calls = [];
  const slot = () => Number(e.vm.getClock().slot);
  const withContext = (value) => ({ context: { slot: slot(), apiVersion: '2.3.0' }, value });
  const rpcError = (code, message) => Object.assign(new Error(message), { rpc: { code, message } });

  function account(address, config = {}) {
    const a = e.account(address);
    if (!a) return null;
    const slice = config.dataSlice, data = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
    return { lamports: a.lamports, owner: a.owner.toBase58(), data: [data.toString('base64'), 'base64'], executable: a.executable, rentEpoch: 0, space: a.data.length };
  }
  function decode(base64) {
    const bytes = Buffer.from(base64, 'base64');
    let signed = false;
    try { signed = Transaction.from(bytes).verifySignatures(); } catch { /* malformed or unsigned */ }
    return { bytes, signed };
  }

  const methods = {
    getGenesisHash: () => genesisHash,
    getSlot: () => slot(),
    getBlockTime: () => Number(e.vm.getClock().unixTimestamp),
    getBalance: ([address]) => withContext(e.account(address)?.lamports || 0),
    getMinimumBalanceForRentExemption: ([size]) => Number(e.vm.minimumBalanceForRentExemption(BigInt(size))),
    getLatestBlockhash: () => withContext({ blockhash: e.vm.latestBlockhash(), lastValidBlockHeight: slot() + 150 }),
    getAccountInfo: ([address, config]) => withContext(account(address, config)),
    getMultipleAccounts: ([addresses, config]) => withContext(addresses.map((a) => account(a, config))),
    getProgramAccounts: async ([owner, config = {}]) => (await e.connection.getProgramAccounts(new PublicKey(owner), { filters: config.filters }))
      .map((x) => ({ pubkey: x.pubkey.toBase58(), account: account(x.pubkey.toBase58()) })),
    simulateTransaction: ([base64, config = {}]) => {
      const { bytes, signed } = decode(base64);
      if (config.sigVerify && !signed) throw rpcError(-32003, 'Transaction signature verification failure');
      const r = e.simulate(bytes);
      return withContext({ err: r.ok ? null : r.error, logs: r.logs, accounts: null, unitsConsumed: r.compute, returnData: null });
    },
    sendTransaction: ([base64]) => {
      const { bytes, signed } = decode(base64);
      if (!signed) throw rpcError(-32003, 'Transaction signature verification failure');
      let result;
      try { result = e.send(bytes); } catch (err) { result = e.history.get(err.signature); if (!result) throw rpcError(-32602, err.message); }
      if (result.ok || !NEVER_LANDS.test(result.error)) {
        statuses.set(result.signature, { slot: slot(), confirmations: 1, err: result.ok ? null : result.error, confirmationStatus: 'confirmed' });
      }
      e.vm.expireBlockhash(); // the next prepared transaction gets a fresh blockhash
      return result.signature;
    },
    getSignatureStatuses: ([signatures]) => withContext(signatures.map((s) => statuses.get(s) || null)),
    requestAirdrop: ([address, lamports]) => {
      e.fund(address, BigInt(lamports));
      const signature = bs58.encode(Keypair.generate().secretKey);
      statuses.set(signature, { slot: slot(), confirmations: 1, err: null, confirmationStatus: 'confirmed' });
      return signature;
    },
  };

  /**
   * One JSON-RPC request in, one response out. A fault registered for the method runs
   * first and may return {result}, {error: {code, message}}, {drop: true} (no reply at
   * all) or {drop: true, deliver: true} (processed, but the reply is lost).
   */
  async function handle(request) {
    const { id, method, params = [] } = request;
    calls.push(method);
    const reply = (body) => ({ jsonrpc: '2.0', id, ...body });
    const fault = await faults.get(method)?.(params);
    try {
      if (fault?.drop) { if (fault.deliver) await methods[method](params); return null; }
      if (fault?.error) return reply({ error: fault.error });
      if (fault && 'result' in fault) return reply({ result: fault.result });
      if (!methods[method]) return reply({ error: { code: -32601, message: `Method not found in the test node: ${method}` } });
      return reply({ result: await methods[method](params) });
    } catch (err) {
      return reply({ error: err.rpc || { code: -32603, message: err.message } });
    }
  }
  async function handleBody(text) {
    const body = JSON.parse(text);
    if (!Array.isArray(body)) return handle(body);
    const replies = await Promise.all(body.map(handle));
    return replies.includes(null) ? null : replies;
  }

  /** fetch-compatible transport: pass as the adapter's `fetch` option. */
  async function fetch(_url, init) {
    const reply = await handleBody(init.body);
    if (reply === null) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  /** The same node over loopback HTTP, for processes that need a URL. */
  function listen() {
    const server = http.createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', async () => {
        const reply = await handleBody(text).catch(() => null);
        if (reply === null) return req.destroy();
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
  }

  return {
    programId, e, calls, statuses, handle, handleBody, fetch, listen, account, withContext,
    fault(method, fn) { if (fn) faults.set(method, fn); else faults.delete(method); },
    fund(keypair, lamports = 10_000_000_000n) { e.fund(keypair.publicKey.toBase58(), lamports); return keypair; },
    advance(seconds) { e.advance(seconds); },
    now: () => e.vm.getClock().unixTimestamp,
  };
}

module.exports = { createRpc, DEVNET_GENESIS };
