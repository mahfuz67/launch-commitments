# Dependency status

This is an experimental local/testnet build, not an audited release. Packages are locked. Install with `npm ci --ignore-scripts`; this skips dependency installation scripts. LiteSVM ships its native runtime as a prebuilt package.

The first audit reported 15 affected packages (including transitive propagation): 8 moderate and 7 high. A normal `npm audit fix --ignore-scripts` could not resolve the remaining set without breaking the required Meteora/web3 v1 combination. Do not use `--force`, which proposes web3 v3 and breaks these SDKs.

The directly used BN library was upgraded from 5.2.2 to compatible patched 5.2.5. The follow-up audit still reports 14 affected packages, including transitive propagation; see [dependency-audit.json](../evidence/reports/dependency-audit.json). The program integration suite and frontend build pass with the updated BN version.

Unresolved advisory roots observed: bigint-buffer native buffer overflow, toml recursion/prototype pollution, uuid buffer bounds in v3/v5/v6, and stream-json nested-filter denial of service. The app does not accept TOML, and web3 request IDs use UUID v4. The current install reports the bigint native binding absent and takes the JavaScript fallback. Those observations reduce specific exposure; they are not a security clearance or reason to ignore the dependency chain. Production requires a reviewed dependency remediation plan and independent program review.

No third-party package, skill or CLI installation receives the user's wallet keys. Local test keys are disposable and must never receive real funds.
