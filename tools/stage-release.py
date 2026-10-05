"""Stage only an explicit public allowlist; never recurse into private/ or target/."""
from pathlib import Path
import shutil, json, re
root=Path(__file__).resolve().parents[1]
workspace=root.parents[1]
release=workspace/'work'/'launch-commitments-release'
release.mkdir(exist_ok=True)
folders=['app','runtime','sdk','tests','fixtures','fixtures-devnet','docs','.github','tools','demo']
files=['.gitignore','brand.md','DEPENDENCIES.md','dependency-audit.json','deploy-devnet.cjs','verify-deployment.cjs','deployment-plan.json','deployment.json','devnet-preflight.json','DEVNET.md','INTERFACE.md','LICENSE','package-lock.json','package.json','PRODUCT.md','PUBLIC-DEMO.md','COMPARISON.md','README.md','recover.cjs','SUBMISSION.md','THIRD_PARTY.md','vite.config.mjs','validator-result.json','browser-result.json','wallet-browser-result.json','browser-desktop.png','browser-mobile.png','wallet-browser.png']
files+=['program/Cargo.lock','program/Cargo.toml','program/IMPLEMENTATION-NOTES.md','program/REVIEW-RESPONSE.md','program/selftest-result.json','program/build/launch_commitments.so']
folders+=['program/src']
allowed_evidence=['public-proof-verification.log','public-release-review.md','public-prep-core-tests.log','public-prep-api-tests.log','public-prep-build.log','devnet-deployment-verified.log','deployment-buffer-recovered.json','public-proof-plan.json','public-proof-launch.log','public-proof-refund.log','public-proof-expiry.log','claude-public-review.md','claude-public-cross-review.md']
files+=['evidence/'+x for x in allowed_evidence]
for folder in folders:
    if (root/folder).exists():
        for p in (root/folder).rglob('*'):
            if p.is_file() and not p.is_symlink() and 'raw' not in p.relative_to(root).parts:
                files.append(str(p.relative_to(root)))
for relative in sorted(set(files)):
    p=root/relative
    if not p.is_file(): continue
    if any(x in Path(relative).parts for x in ['private','node_modules','target','.cache']): raise RuntimeError('Forbidden path: '+relative)
    if 'keypair' in p.name.lower(): raise RuntimeError('Forbidden key file: '+relative)
    if p.suffix in ['.json','.md','.cjs','.mjs','.jsx','.yml','.toml','.log','.html','.txt']:
        text=p.read_text()
        if re.search(r'(?:\d{1,3},\s*){50,}',text): raise RuntimeError('Possible byte-array key: '+relative)
        if '-----BEGIN PRIVATE KEY-----' in text: raise RuntimeError('Private key: '+relative)
    q=release/relative;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,q)
proof=root/'private/public-proof/public-evidence.json'
if proof.exists():
    data=json.loads(proof.read_text())
    if (data.get('result') or {}).get('passed'):
        q=release/'evidence/public-devnet-proof.json';q.parent.mkdir(exist_ok=True);q.write_text(json.dumps(data,indent=2)+'\n')
print(release)
