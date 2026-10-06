// Browser-native devnet API: lets the app run as a static site with no backend. It
// answers the same routes as runtime/devnet-server.cjs with the same JSON, but from
// inside the page, talking straight to a Solana RPC node.
//
//   const api = createDevnetApi();            // pinned devnet deployment, public RPC
//   await api('state?wallet=' + address);     // same call shape as the app's fetch helper
//   await api('prepare', {action, campaign, wallet, amount});
//   await api('send', {transaction});
//
// Results are plain JSON values (64-bit amounts are decimal strings). Failures throw an
// Error whose `result` is the body the server would have sent ({error, logs, status?}).
// A send that is neither confirmed nor failed resolves with {status: 'unknown'}.
//
// The chain code is in devnet-core.mjs and loads on the first call, so importing this
// file costs nothing in a build that never calls it. Configuration comes only from the
// arguments below. Never read the RPC URL or program address from the page URL or from
// storage: a crafted link could then point a visitor's wallet at another program.

/** The deployment recorded in ../deployment.json. Its bytecode is re-checked on chain. */
export const DEVNET_PROGRAM_ID = '4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD';
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';

const plain = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

/**
 * @param {object} [config] `network` ('devnet', or 'validator' with a loopback RPC),
 *   `rpcUrl`, `programId`; see createCore in devnet-core.mjs for the rest. Unset and
 *   empty values keep the pinned devnet defaults.
 * @returns {(path: string, data?: object) => Promise<object>}
 */
export function createDevnetApi(config = {}) {
  const settings = { network: 'devnet', rpcUrl: DEVNET_RPC_URL, programId: DEVNET_PROGRAM_ID };
  for (const [name, value] of Object.entries(config)) if (value !== undefined && value !== '') settings[name] = value;
  let core = null;
  return async function api(path, data) {
    try {
      if (!core) {
        core = import('./devnet-core.mjs').then((m) => m.createCore(settings));
        core.catch(() => { core = null; }); // a failed load can be retried
      }
      return plain(await (await core).handle(path, data));
    } catch (err) {
      const failure = new Error(err.message);
      failure.status = err.status || 500;
      failure.result = plain({ error: err.message, logs: err.extra?.logs || [], ...(err.extra || {}) });
      throw failure;
    }
  };
}
