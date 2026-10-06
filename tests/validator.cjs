// Real local validator rehearsal. Never connects to a public cluster.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {Connection,Keypair,PublicKey,Transaction,SystemProgram,sendAndConfirmTransaction}=require('@solana/web3.js');
const BN=require('bn.js'),dbc=require('@meteora-ag/dynamic-bonding-curve-sdk'),lc=require('../sdk/index.cjs'),{preset}=require('../runtime/preset.cjs');
const {getAssociatedTokenAddressSync}=require('@solana/spl-token');
async function run(){
 const connection=new Connection('http://127.0.0.1:18899','confirmed'),payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('private/devnet-payer.json')))),programId=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync('program/build/launch_commitments-keypair.json')))).publicKey;
 const a=Keypair.generate(),b=Keypair.generate(),cfg=Keypair.generate(),client=new dbc.DynamicBondingCurveClient(connection,'confirmed'),parameters=preset(),transactions=[];
 async function send(tx,signers=[payer]){tx.feePayer=signers[0].publicKey;const signature=await sendAndConfirmTransaction(connection,tx,signers,{commitment:'confirmed',skipPreflight:false});transactions.push(signature);return signature;}
 await send(new Transaction().add(...[a,b].map(k=>SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:k.publicKey,lamports:5000000000})),SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'),lamports:1000000000})));
 await send(await client.partner.createConfig({config:cfg.publicKey,feeClaimer:payer.publicKey,leftoverReceiver:payer.publicKey,payer:payer.publicKey,quoteMint:lc.WSOL_MINT,...parameters}),[payer,cfg]);
 const clock=async()=>BigInt(await connection.getBlockTime(await connection.getSlot())),now=await clock(),target=2000000000n,q=client.pool.getQuoteFromInputAmount({config:parameters,swapBaseForQuote:false,swapMode:0,amountIn:new BN(target.toString()),slippageBps:1});
 const common={programId,organizer:payer.publicKey,beneficiary:payer.publicKey,config:cfg.publicKey,target,minTokens:BigInt(q.minimumAmountOut.toString()),closeTime:now+20n,expiry:now+180n,budgetLamports:100000000n,name:'Validator rehearsal',symbol:'VAL',uri:'https://example.invalid/local-validator.json'};
 const launched=await lc.createCampaign({...common,nonce:BigInt(Date.now())}),failed=await lc.createCampaign({...common,nonce:BigInt(Date.now())+1n});await send(launched.transaction);await send(failed.transaction);
 await send((await lc.contribute({programId,campaign:launched.campaign,contributor:a.publicKey,amount:3000000000n})).transaction,[a]);await send((await lc.contribute({programId,campaign:failed.campaign,contributor:b.publicKey,amount:1000000000n})).transaction,[b]);
 while(await clock()<common.closeTime)await new Promise(r=>setTimeout(r,1000));
 await send((await lc.settle({connection,programId,campaign:launched.campaign})).transaction,[b]);await send((await lc.claim({programId,campaign:launched.campaign,contributor:a.publicKey})).transaction,[a]);await send((await lc.refund({programId,campaign:failed.campaign,contributor:b.publicKey})).transaction,[b]);
 const s=lc.decodeCampaign((await connection.getAccountInfo(launched.campaign)).data),f=lc.decodeCampaign((await connection.getAccountInfo(failed.campaign)).data),balance=await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(launched.mint,a.publicKey));assert.equal(balance.value.amount,s.tokensBought.toString());assert.equal(s.excessPaid,1000000000n);assert.equal(f.refunded,1000000000n);
 const result={passed:true,network:'local Agave validator',version:await connection.getVersion(),programId:programId.toBase58(),campaigns:{launched:launched.campaign.toBase58(),refunded:failed.campaign.toBase58()},transactions,checks:['real RPC and block time','atomic launch','excess and token claim','underfunded refund']};fs.mkdirSync('evidence/reports',{recursive:true});fs.writeFileSync('evidence/reports/validator-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
run().catch(e=>{console.error(e);process.exitCode=1;});
