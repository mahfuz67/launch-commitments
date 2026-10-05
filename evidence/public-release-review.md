# Public release review — 5 October 2026

Codex reviewed the release and executed its public devnet proof. This is an internal engineering review, not an independent security audit.

## Review performed

- Verified deployed loader ownership, bytecode length/hash and retained upgrade authority with a fresh RPC connection after deployment.
- Added matching deployment checks to the RPC backend and an explicit upgrade-authority disclosure to the app.
- Four focused tests reject substituted bytecode, malformed loader data and invalid ownership; all 28 core Node tests pass.
- Re-ran the separate local-validator API lifecycle, including DBC graduation, DAMM v2 migration/trading and refund. These migration results are local execution, not public-devnet migration evidence.
- Reviewed Claude's resumable public harness before executing it. Fixed a null evidence lookup in plan mode and an API dispatch selector that otherwise misclassified backend routes. Public launch execution and independent refund logs reflect the corrected harness.
- Staged only an explicit public file allowlist. Participant, payer and program keypairs remain excluded. Only the completed public-evidence manifest is copied out of its private working directory.

## Collaboration boundary

Claude Code (claude-opus-5-5) produced the public harness and comparison document. It reached its usage limit before completing the requested written review. Codex reviewed and corrected those artifacts and executed the tests. No completed independent Claude security sign-off is claimed.

## Remaining limits

Real wallet-extension testing, independent audit, hosted transactional service, customer adoption and mainnet deployment are outstanding. Devnet wallets are developer-controlled. The upgrade authority can replace the program. Public proof data names exactly which transactions ran; no local-only migration is represented as public execution.
