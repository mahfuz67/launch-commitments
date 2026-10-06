# Hosted release checks — 6 October 2026

Codex ran the complete Node test suite: 51 passed, zero failed. New checks compare the browser SDK instruction bytes and account decoders with the existing SDK and exercise the browser API through a simulated JSON-RPC node backed by the real program in LiteSVM. This is automated internal testing, not an independent audit or real Phantom signing evidence.

The production static build passed. A CUA-controlled browser loaded the build, read actual public devnet campaigns and displayed the successful campaign on DAMM v2. Build warnings remain for large chunks and Anchor’s unused Node util branch; the browser branch uses native TextEncoder/TextDecoder. Full extension signing remains pending.

The migration manifest records five finalized transactions including graduation, migration and a 1,000-token DAMM v2 sale. These transactions use developer test wallets, not external users. The earlier 18-transaction manifest remains a separate historical record.

The app pins the devnet cluster and recorded program deployment. Transaction preparation and sending recheck the deployment; read-only state may cache the deployment check for 30 seconds. RPC throttling and offline failures remain possible. An unknown send result preserves its signature and must be checked before retrying.

Remaining release limitations: real Phantom end-to-end test pending, no independent audit, upgrade authority retained, no proven customer demand or mainnet traction. The package is prepared, not submitted. The guided walkthrough shows current chain state and historical evidence; it is not a recording of new transactions.

Claude’s closing note items 3 and 4 were addressed by Codex: the release allowlist includes the review and logs, and public documentation links the hosted app. The remaining wallet-signing and browser migration limitations are retained.
