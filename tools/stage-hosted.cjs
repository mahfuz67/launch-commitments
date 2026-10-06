// Run npm run build:hosted first. Copies only the generated browser bundle to Pages.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),src=path.join(root,'dist'),dest=path.join(root,'docs/app');
const index=fs.readFileSync(path.join(src,'index.html'),'utf8');
if(!index.includes('/launch-commitments/app/assets/'))throw Error('Build does not use the public app base path. Run npm run build:hosted.');
const assets=fs.readdirSync(path.join(src,'assets')).filter(n=>n.endsWith('.js'));
const code=assets.map(n=>fs.readFileSync(path.join(src,'assets',n),'utf8')).join('\n');
if(!code.includes('https://api.devnet.solana.com')||!code.includes('4WcS5bp77ayc8ZE2dQ47z9qi3KFPFgZz6f9XEzSjojqD'))throw Error('The bundle lacks the pinned devnet adapter.');
if(/(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,})/.test(code))throw Error('Possible credential in bundle.');
fs.mkdirSync(dest,{recursive:true});
// Remove only obsolete generated chunks; retain all non-generated page files.
const targetAssets=path.join(dest,'assets');
if(fs.existsSync(targetAssets))for(const name of fs.readdirSync(targetAssets))if(!fs.existsSync(path.join(src,'assets',name)))fs.unlinkSync(path.join(targetAssets,name));
fs.cpSync(src,dest,{recursive:true});
console.log('Hosted devnet app staged in docs/app; no server or wallet keys included.');
