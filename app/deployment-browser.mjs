// Browser port of ../runtime/deployment-info.cjs: the same loader and bytecode checks,
// hashed with WebCrypto instead of node:crypto. tests/hosted-parity.test.cjs runs both
// against the same accounts. These checks do not prevent a later authorized upgrade.
import {PublicKey} from '@solana/web3.js';
import {sha256Hex} from './sha256-browser.mjs';

export const REVIEWED_SHA256 = '1e8d66705b2ee91c504552fb7e55cf26fb046d54aec26e0aed54e1c48b9e6e4b';
export const REVIEWED_BYTES = 98728;
const UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const LEGACY = new Set(['BPFLoader2111111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111']);

export async function deploymentInfo(connection, programId) {
  const program = await connection.getAccountInfo(programId, 'confirmed');
  if (!program?.executable) throw Error('The launch program is not deployed as an executable.');
  let bytes, programData = null, upgradeAuthority = null, lastDeploySlot = null;
  if (program.owner.equals(UPGRADEABLE)) {
    if (program.data.length !== 36 || program.data.readUInt32LE(0) !== 2) throw Error('Unexpected program loader state.');
    const address = new PublicKey(program.data.subarray(4, 36));
    const data = await connection.getAccountInfo(address, 'confirmed');
    if (!data || !data.owner.equals(UPGRADEABLE) || data.executable || data.data.length < 45 || data.data.readUInt32LE(0) !== 3) throw Error('Invalid program-data account.');
    if (data.data[12] !== 0 && data.data[12] !== 1) throw Error('Invalid upgrade authority flag.');
    programData = address.toBase58();
    lastDeploySlot = data.data.readBigUInt64LE(4).toString();
    if (data.data[12]) upgradeAuthority = new PublicKey(data.data.subarray(13, 45)).toBase58();
    bytes = data.data.subarray(45);
  } else if (LEGACY.has(program.owner.toBase58())) {
    bytes = program.data;
  } else throw Error('Unsupported program loader.');
  // Loader allocation can include zero padding, but never ignore nonzero code.
  if (bytes.length < REVIEWED_BYTES || bytes.subarray(REVIEWED_BYTES).some(b => b !== 0)) throw Error('Program size differs from this reviewed release.');
  const sha256 = await sha256Hex(bytes.subarray(0, REVIEWED_BYTES));
  if (sha256 !== REVIEWED_SHA256) throw Error('Deployed program differs from this reviewed release.');
  return { programData, upgradeAuthority, upgradeable: upgradeAuthority !== null, lastDeploySlot, sha256, bytes: REVIEWED_BYTES, checkedAt: new Date().toISOString() };
}
