const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PublicKey, Keypair } = require('@solana/web3.js');
const { deploymentInfo, REVIEWED_SHA256 } = require('../runtime/deployment-info.cjs');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const binary = fs.readFileSync(path.join(__dirname, '../program/build/launch_commitments.so'));
function fixture() {
  const pid = Keypair.generate().publicKey, pd = Keypair.generate().publicKey, authority = Keypair.generate().publicKey;
  const program = { executable: true, owner: loader, data: Buffer.alloc(36) };
  program.data.writeUInt32LE(2); pd.toBuffer().copy(program.data, 4);
  const data = { executable: false, owner: loader, data: Buffer.alloc(45 + binary.length) };
  data.data.writeUInt32LE(3); data.data.writeBigUInt64LE(123n, 4); data.data[12] = 1;
  authority.toBuffer().copy(data.data, 13); binary.copy(data.data, 45);
  const connection = { getAccountInfo: async key => key.equals(pid) ? program : key.equals(pd) ? data : null };
  return { pid, pd, authority, program, data, connection };
}
test('deployment verifies actual reviewed bytes and discloses retained authority', async () => {
  const f = fixture(), info = await deploymentInfo(f.connection, f.pid);
  assert.equal(info.sha256, REVIEWED_SHA256); assert.equal(info.upgradeAuthority, f.authority.toBase58());
  assert.equal(info.programData, f.pd.toBase58()); assert.equal(info.lastDeploySlot, '123');
  f.data.data[12] = 0;
  assert.equal((await deploymentInfo(f.connection, f.pid)).upgradeable, false);
});
test('deployment rejects byte substitution and nonzero trailing payload', async () => {
  const f = fixture(); f.data.data[50] ^= 1;
  await assert.rejects(deploymentInfo(f.connection, f.pid), /differs/);
  const g = fixture(); g.data.data = Buffer.concat([g.data.data, Buffer.from([1])]);
  await assert.rejects(deploymentInfo(g.connection, g.pid), /size differs/);
  g.data.data[g.data.data.length - 1] = 0;
  assert.equal((await deploymentInfo(g.connection, g.pid)).sha256, REVIEWED_SHA256);
});
test('deployment rejects substituted loader-owned accounts and malformed authority state', async () => {
  const f = fixture(); f.data.owner = PublicKey.default;
  await assert.rejects(deploymentInfo(f.connection, f.pid), /program-data/);
  const g = fixture(); g.data.data[12] = 2;
  await assert.rejects(deploymentInfo(g.connection, g.pid), /authority flag/);
  const h = fixture(); h.program.owner = PublicKey.default;
  await assert.rejects(deploymentInfo(h.connection, h.pid), /Unsupported/);
});
test('validator legacy-loader deployment is verified without inventing an authority', async () => {
  const f = fixture(); f.program.owner = new PublicKey('BPFLoader2111111111111111111111111111111111'); f.program.data = binary;
  assert.equal((await deploymentInfo(f.connection, f.pid)).upgradeAuthority, null);
  f.program.executable = false;
  await assert.rejects(deploymentInfo(f.connection, f.pid), /not deployed/);
});
