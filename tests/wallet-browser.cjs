// Simulated Wallet Standard provider, fresh test keys, local validator only.
const {chromium}=require('playwright'),{Keypair,Transaction}=require('@solana/web3.js'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'}),page=await browser.newPage({viewport:{width:1280,height:960}}),key=Keypair.generate(),errors=[];
 page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('__walletTestSign',bytes=>{const tx=Transaction.from(Buffer.from(bytes));tx.partialSign(key);return Array.from(tx.serialize());});
 await page.addInitScript(({address,publicKey})=>{
  const account={address,publicKey:new Uint8Array(publicKey),chains:['solana:devnet','solana:localnet'],features:['solana:signTransaction']};
  const wallet={version:'1.0.0',name:'Automated test wallet',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',chains:account.chains,accounts:[],features:{'standard:connect':{version:'1.0.0',connect:async()=>{wallet.accounts=[account];return {accounts:wallet.accounts};}},'solana:signTransaction':{version:'1.0.0',supportedTransactionVersions:['legacy'],signTransaction:async({transaction})=>[{signedTransaction:new Uint8Array(await window.__walletTestSign(Array.from(transaction)))}]}}};
  const register=api=>api.register(wallet);window.addEventListener('wallet-standard:app-ready',e=>register(e.detail));window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet',{detail:register}));
 },{address:key.publicKey.toBase58(),publicKey:Array.from(key.publicKey.toBytes())});
 async function clean(){await page.waitForFunction(()=>!document.querySelector('button[disabled]:not([title=""])'),null,{timeout:20000});if(await page.locator('[role=alert]').count())throw Error(await page.locator('[role=alert]').innerText());}
 async function click(name){console.log(name);await page.getByRole('button',{name,exact:true}).click();await clean();}
 async function sign(){await page.getByRole('region',{name:'Transaction review'}).waitFor();await click('Sign with wallet & submit');await page.getByRole('region',{name:'Transaction review'}).waitFor({state:'detached'});}
 try{
  const env=await (await fetch('http://127.0.0.1:19190/api/environment')).json();assert.equal(env.network,'validator');
  const funded=await fetch('http://127.0.0.1:19190/api/faucet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({wallet:key.publicKey.toBase58()})});assert.equal(funded.status,200);
  await page.goto('http://127.0.0.1:5181');await page.getByText('Local validator',{exact:true}).waitFor();await click('Connect wallet');await click('Create a launch →');await page.getByLabel('Token name',{exact:true}).fill('Wallet integration');await page.getByLabel('Token metadata URL',{exact:true}).fill('https://example.invalid/test.json');await click('Review campaign transaction');await sign();
  await page.getByRole('heading',{name:'Wallet integration',exact:true}).waitFor();await page.getByLabel('Contribution · SOL',{exact:true}).fill('0.2');await click('Review contribution');await sign();await click('Withdraw contribution');await sign();
  assert.equal(await page.getByText('Local rehearsal controls',{exact:true}).count(),0);assert.deepEqual(errors,[]);await page.screenshot({path:'evidence/screenshots/wallet-browser.png',fullPage:true});
  fs.mkdirSync('evidence/reports',{recursive:true});fs.writeFileSync('evidence/reports/wallet-browser-result.json',JSON.stringify({passed:true,network:'local validator',wallet:'simulated Wallet Standard provider; no real extension claimed',flows:['connect','create with preserved co-signature','contribute','withdraw'],errors},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
