# Repository presentation cleanup

6 October 2026. Layout and documentation changes only, left as an uncommitted working-tree diff on `main` (base `a65a071`). No program, SDK, app or runtime behavior changed; `docs/` (the GitHub Pages site), fixtures and `program/build/launch_commitments.so` are byte-identical. Nothing was committed, pushed or published.

## What moved

| From the root | To |
|---|---|
| `browser-result.json`, `wallet-browser-result.json`, `validator-result.json`, `devnet-preflight.json`, `dependency-audit.json`, `deployment-plan.json` | `evidence/reports/` |
| `wallet-browser.png` | `evidence/screenshots/` |
| `browser-desktop.png`, `browser-mobile.png` (on disk only; `.gitignore` excludes `browser-*.png`, so they were never in the repository) | `evidence/screenshots/`, still ignored |
| `COMPARISON.md`, `DEPENDENCIES.md`, `DEVNET.md`, `PRODUCT.md`, `PUBLIC-DEMO.md`, `SUBMISSION.md` | `documentation/` |

No evidence file was deleted. Tracked files were moved with `git mv`, so history follows them.

## What stayed at the root, and why

- `deployment.json`: the runtime manifest read by `tests/hosted-parity.test.cjs`, `tests/public-devnet.cjs` and `tools/build-public-proof.cjs`.
- `INTERFACE.md`: cited by path from `program/src/*.rs`, `sdk/index.cjs` and `app/lc-browser.mjs`. Moving it would mean editing program source.
- `THIRD_PARTY.md`: `LICENSE` refers to it.
- `brand.md`: the design tooling used on this project reads it from the project root.
- `recover.cjs`, `deploy-devnet.cjs`, `verify-deployment.cjs`: documented commands and `npm run deploy:plan`.
- `COMPARISON.md` and `PUBLIC-DEMO.md`: now three-line pointers. The published Pages site, `submission/entry.md` and `tools/build-public-proof.cjs` link to `blob/main/COMPARISON.md` and `blob/main/PUBLIC-DEMO.md`; those URLs keep resolving, and the generated pages did not need rebuilding.

## Edits

- `README.md`: condensed to the product introduction, live app/walkthrough/proof/program/demo links, quickstart, architecture, limitations and a documentation index. The removed sections are preserved in new `documentation/MECHANISM.md`, `documentation/VERIFICATION.md` and `documentation/RECOVERY.md`; `documentation/README.md` indexes the directory.
- Output paths: `tests/browser.cjs`, `tests/wallet-browser.cjs`, `tests/validator.cjs`, `tests/devnet-preflight.cjs` and `deploy-devnet.cjs` now write to `evidence/reports/` and `evidence/screenshots/` (creating `evidence/reports/` if absent). `verify-deployment.cjs` reads the plan from `evidence/reports/deployment-plan.json`. Nothing else in those scripts changed.
- `tools/stage-release.py`: allowlist updated for the new paths, the `documentation/` folder and this file.
- Moved documents: relative links and file mentions updated (`documentation/PUBLIC-DEMO.md`, `DEVNET.md`, `DEPENDENCIES.md`). `DEVNET.md` said to start "From `work/launch-commitments`", a scratch path; it now says the repository root.
- `program/IMPLEMENTATION-NOTES.md`, `program/REVIEW-RESPONSE.md`: the header note pointed to `README.md` and `verification.json` for later results. It now points to `documentation/VERIFICATION.md`. `verification.json` was never in the public repository.
- Test count: the old README said 28 Node tests. The suite has 51; `documentation/VERIFICATION.md` carries the corrected figure.

## Checks

- `npm run test:core`: 51 passed, 0 failed. Run in a temporary export of the working tree with the scratch `node_modules` symlinked, then discarded, so `program/selftest-result.json` was not rewritten in either tree.
- `node --check` on the six edited scripts and a Python parse of `tools/stage-release.py`: clean.
- Relative Markdown links: 58 checked across 26 files, none broken.
- `git grep` for the old root paths and bare document names: the only remaining hits are link text and the staging allowlist.
- `git status -- docs fixtures fixtures-devnet program/build program/src sdk app runtime`: no changes.

Not run: the Vite build and Rust tests (no app or program source changed); `tests/browser.cjs`, `tests/wallet-browser.cjs`, `tests/validator.cjs`, `tests/devnet-preflight.cjs`, `deploy-devnet.cjs` and `verify-deployment.cjs` (they need a browser, a validator, the network or keys). Their new output paths are verified by syntax check and inspection only.

## Scratch mirror and remaining drift

The same moves and edited files were applied to the scratch tree `work/launch-commitments`, without touching `private/`, `dist/`, `node_modules/` or `.cache/`. Shared files are identical between the two trees. Differences that remain, all pre-existing and deliberately not synced:

- Scratch only: root `*.log` files, `verification.json`, `claude-*-brief.md`, `work/`, `demo/raw/`, `program/target/`, the program keypair, and 24 unpublished files in `evidence/`. `.gitignore` or the staging allowlist excludes each of them.
- Release only: `evidence/public-devnet-proof.json`, which `tools/stage-release.py` writes from the private proof record.
- `tools/stage-release.py` copies and never deletes, so a release tree staged before this change would keep the old root copies until removed by hand.

## Open points

- `documentation/VERIFICATION.md` and `documentation/DEVNET.md` mention `evidence/devnet-api-result.log` and `evidence/devnet-bytecode-tests.log`. Both exist only in scratch; `*.log` is ignored and neither is on the staging allowlist. This predates the cleanup.
- `browser-desktop.png` and `browser-mobile.png` remain unpublished. Publishing them needs a `.gitignore` exception.
- Links to `blob/main/DEVNET.md`, `PRODUCT.md`, `SUBMISSION.md` or `DEPENDENCIES.md` from outside the repository would break once this is pushed. None was found in the repository or the Pages site; add pointers like the two above if any exist elsewhere.

## Codex follow-up

The two referenced devnet test logs were checked for credential patterns and added to the explicit release allowlist, so the documentation no longer points to unavailable logs. The GitHub Pages site and deployed program remain unchanged.
