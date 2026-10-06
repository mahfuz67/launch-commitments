# Recovery without the website

Moved from the repository README. `recover.cjs` needs only an RPC connection and the contributor's own key.

```sh
node recover.cjs --help
node recover.cjs --rpc https://api.devnet.solana.com --program PROGRAM_ADDRESS --campaign CAMPAIGN_ADDRESS --wallet YOUR_PUBLIC_ADDRESS
```

Add `--action refund`, `claim`, `withdraw` or `settle` to prepare a transaction. Sending requires `--keypair /path/to/your/test-keypair.json --send`. The CLI verifies devnet's genesis hash before sending, simulates first and checks confirmation. Never paste a secret key into chat. The app can export terms and public recovery addresses; it never exports your key.

[PUBLIC-DEMO.md](PUBLIC-DEMO.md) has the command with the deployed devnet program address filled in.
