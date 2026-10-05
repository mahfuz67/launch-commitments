const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Keypair,PublicKey,Transaction,SystemProgram,ComputeBudgetProgram}=require('@solana/web3.js');
const BN=require('bn.js'),dbc=require('@meteora-ag/dynamic-bonding-curve-sdk');
const {getAssociatedTokenAddressSync}=require('@solana/spl-token');
const {createEnvironment}=require('../runtime/vm.cjs'),{preset}=require('../runtime/preset.cjs');
const ROOT=path.resolve(__dirname,'..');
function binary(){const options=['program/build/launch_commitments.so','program/target/deploy/launch_commitments.so','program/target/deploy/launch_commitment.so','program/build/launch_commitment.so'];const result=options.map(p=>path.join(ROOT,p)).find(fs.existsSync);if(!result)throw Error('Compiled campaign program not found. Build it before running integration tests.');return result;}
async function setup({target=2000000000n,minimum,budget,nonce=1n,customPreset}={}){
 const lc=require('../sdk/index.cjs'),programId=Keypair.generate().publicKey,e=createEnvironment({programId:programId.toBase58(),programPath:binary()}),owner=Keypair.generate(),a=Keypair.generate(),b=Keypair.generate(),stranger=Keypair.generate(),cfg=Keypair.generate();for(const k of [owner,a,b,stranger])e.fund(k.publicKey.toBase58(),1000000000000n);
 const client=new dbc.DynamicBondingCurveClient(e.connection,'confirmed'),parameters=customPreset||preset();
 await e.execute(await client.partner.createConfig({config:cfg.publicKey,feeClaimer:owner.publicKey,leftoverReceiver:owner.publicKey,payer:owner.publicKey,quoteMint:new PublicKey('So11111111111111111111111111111111111111112'),...parameters}),[owner,cfg]);
 const quote=client.pool.getQuoteFromInputAmount({config:parameters,swapBaseForQuote:false,swapMode:0,amountIn:new BN(target.toString()),slippageBps:1});
 const now=e.vm.getClock().unixTimestamp,terms={programId,organizer:owner.publicKey,beneficiary:owner.publicKey,config:cfg.publicKey,nonce,target,minTokens:minimum??BigInt(quote.minimumAmountOut.toString()),closeTime:now+100n,expiry:now+200n,budgetLamports:budget??100000000n,name:'Community launch',symbol:'COMM',uri:'https://example.invalid/community.json'};
 const created=await lc.createCampaign(terms);await e.execute(created.transaction,[owner]);
 const read=()=>lc.decodeCampaign(e.account(created.campaign.toBase58()).data);
 const receipt=k=>{const p=lc.deriveReceipt(programId,created.campaign,k.publicKey)[0],ac=e.account(p.toBase58());return ac?.owner.equals(programId)?lc.decodeReceipt(ac.data):null;};
 const balance=k=>BigInt(e.account(k.publicKey?.toBase58()||String(k))?.lamports||0);
 const tokenBalance=k=>{const ac=e.account(getAssociatedTokenAddressSync(created.mint,k.publicKey).toBase58());return ac?ac.data.readBigUInt64LE(64):0n;};
 const invoke=async(name,k,args={})=>{const built=await lc[name]({connection:e.connection,programId,campaign:created.campaign,contributor:k.publicKey,...args});return e.execute(built.transaction,[k]);};
 return {lc,e,owner,a,b,stranger,cfg,client,parameters,terms,created,read,receipt,balance,tokenBalance,invoke,programId};
}
async function reject(promise,code){try{await promise;assert.fail('Transaction unexpectedly succeeded');}catch(e){if(e.code==='ERR_ASSERTION')throw e;if(code!==undefined){const logs=(e.logs||[]).join('\n');assert(logs.includes('0x'+code.toString(16))||e.message.includes(String(code)),`Expected program error ${code}; got ${e.message}\n${logs}`);}return e;}}
module.exports={setup,reject,binary,ROOT,Keypair,PublicKey,Transaction,SystemProgram,ComputeBudgetProgram,BN,dbc};
