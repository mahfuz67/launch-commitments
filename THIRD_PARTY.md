# Third-party material

Original Launch commitments source is MIT licensed. Dependencies retain the licenses in their packages; versions are pinned in package-lock.json.

The original DAMM and Metaplex fixture files came from the official Meteora DBC SDK repository at commit a28b7239e71899eb52ff7aacac4dec90441885c4. The repository's MIT notice is reproduced in fixtures/METEORA-LICENSE. The original DBC binary was read from public Solana mainnet ProgramData on 4 October 2026. Fixture provenance and byte hashes are in fixtures/provenance.json.

The fixtures-devnet directory contains read-only captures of public devnet ProgramData and its migration configuration on 5 October 2026. See fixtures-devnet/provenance.json. These binaries are test inputs; our MIT license does not relicense third-party programs. Their respective upstream licenses apply. The source repository/public release should preserve applicable upstream notices and use the capture script where redistribution rights are not established.

The Wallet Standard implementation follows the official [wallet-standard reference](https://github.com/wallet-standard/wallet-standard/blob/master/packages/example/wallets/src/solanaWallet.ts). No wallet-extension assets or private keys are bundled.
