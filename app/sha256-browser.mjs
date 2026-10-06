// SHA-256 through WebCrypto. Browsers expose it only in a secure context (https or
// loopback); without it the bytecode and configuration checks fail closed.
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('This page cannot verify hashes: WebCrypto needs an https or loopback origin.');
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
