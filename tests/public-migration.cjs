// Extend the recorded devnet launch; never creates a new campaign or uses mainnet.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {Connection,Keypair,PublicKey,Transaction,SystemProgram}=require('@solana/web3.js');
const bs58=require('bs58').default;
const proof=require('../private/public-proof/public-evidence.json');
const out='evidence/public-migration.json',api='http://127.0.0.1:19190/api/';
const c=new Connection('https://api.devnet.solana.com','confirmed');
const load=p=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p))));
const trader=load('private/public-proof/alice.json'),payer=load('private/devnet-payer.json');
const campaign=proof.campaigns.launch.address;
let e=fs.existsSync(out)?JSON.parse(fs.readFileSync(out)):{network:'devnet',campaign,developerControlledTestWallets:true,transactions:[],checks:[],startedAt:new Date().toISOString()};
const save=()=>fs.writeFileSync(out,JSON.stringify(e,null,2)+'\n');
async function req(path,data){const r=await fetch(api+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});const j=await r.json();if(!r.ok||j.error)throw Error(JSON.stringify(j));return j;}
async function view(){const s=await req('state?wallet='+trader.publicKey);return s.campaigns.find(x=>x.address===campaign);}
async function broadcast(id,tx,record={}){
 let old=e.transactions.find(x=>x.id===id);
 if(old){const st=(await c.getSignatureStatuses([old.signature],{searchTransactionHistory:true})).value[0];if(st&&!st.err){old.status=st.confirmationStatus;save();return;}throw Error('Existing transaction needs manual reconciliation: '+id);}
 const signature=bs58.encode(tx.signature);const rec={id,signature,explorer:'https://explorer.solana.com/tx/'+signature+'?cluster=devnet',status:'prepared',...record};e.transactions.push(rec);save();
 const sim=await c.simulateTransaction(require('@solana/web3.js').VersionedTransaction.deserialize(tx.serialize()),{sigVerify:true});if(sim.value.err)throw Error('Simulation rejected: '+JSON.stringify(sim.value));
 await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
 for(let i=0;i<60;i++){const s=(await c.getSignatureStatuses([signature])).value[0];if(s?.err)throw Error(JSON.stringify(s.err));if(s&&['confirmed','finalized'].includes(s.confirmationStatus)){rec.status=s.confirmationStatus;rec.slot=s.slot;rec.computeSimulated=sim.value.unitsConsumed;save();return;}await new Promise(r=>setTimeout(r,1000));}throw Error('Confirmation unknown; inspect saved signature.');
}
async function act(id,data){if(e.transactions.some(t=>t.id===id)){await broadcast(id,null);return;}const p=await req('prepare',{wallet:trader.publicKey.toBase58(),campaign,...data});const tx=Transaction.from(Buffer.from(p.transaction,'base64'));tx.partialSign(trader);await broadcast(id,tx,{title:p.title,quote:p.quoteDetails,bytes:p.bytes});}
(async()=>{
 assert.equal(await c.getGenesisHash(),'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');const env=await req('environment');assert.equal(env.programId,proof.programId);assert.equal(env.network,'devnet');e.deployment=env.deployment;
 const v=await view();console.log('Current venue:',v.venue,'Trader balance:',await c.getBalance(trader.publicKey));
 if(!process.argv.includes('--execute')){console.log('Plan: fund trader with 0.3 devnet SOL; buy 0.005 then up to 0.12 SOL to graduate; migrate; sell 1000 tokens on DAMM v2. Already recorded actions are reconciled, never repeated.');return;}
 if(!e.transactions.some(t=>t.id==='fund-trader')){const tx=new Transaction().add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:trader.publicKey,lamports:300000000}));tx.feePayer=payer.publicKey;tx.recentBlockhash=(await c.getLatestBlockhash()).blockhash;tx.sign(payer);await broadcast('fund-trader',tx);}
 if((await view()).venue==='DBC bonding curve'){await act('dbc-buy',{action:'trade',direction:'buy',amount:'0.005'});await act('graduate',{action:'trade',direction:'buy',amount:'0.12'});}
 let at=await view();assert.ok(['Awaiting DAMM v2 migration','DAMM v2'].includes(at.venue));e.afterGraduation=at;
 if(at.venue!=='DAMM v2')await act('migrate',{action:'migrate'});
 at=await view();assert.equal(at.venue,'DAMM v2');e.afterMigration=at;
 const before=BigInt(at.walletTokenBalance);if(!e.transactions.some(t=>t.id==='damm-sale')){await act('damm-sale',{action:'trade',direction:'sell',amount:'1000'});const after=await view();assert.equal(before-BigInt(after.walletTokenBalance),1000000000n);e.checks.push({name:'exactly 1000 tokens sold on DAMM v2',passed:true});e.afterSale=after;}
 delete e.error;e.passed=true;e.completedAt=new Date().toISOString();save();console.log('Public migration and DAMM sale passed.',out);
})().catch(err=>{e.error=err.message;save();console.error(err.message);process.exitCode=1;});
