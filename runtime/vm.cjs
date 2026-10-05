// Real Solana program execution in a local, synthetic bank. Never mainnet RPC.
const fs=require('node:fs'),path=require('node:path');
const {LiteSVM,Clock,FailedTransactionMetadata}=require('litesvm');
const {getTransactionDecoder}=require('@solana/kit');
const {Connection,PublicKey,Transaction,VersionedTransaction,AddressLookupTableAccount}=require('@solana/web3.js');
const bs58=require('bs58').default;
const ROOT=path.resolve(__dirname,'..');
const FIXTURES=process.env.LAUNCH_FIXTURE_DIR?path.resolve(process.env.LAUNCH_FIXTURE_DIR):path.join(ROOT,'fixtures');
function createEnvironment({programId,programPath,now=1801699200}={}){
 const vm=new LiteSVM().withNativeMints();
 vm.setClock(new Clock(1000n,BigInt(now),0n,0n,BigInt(now)));
 const known=new Set(),history=new Map();
 for(const [key,file] of [['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN','dbc.so'],['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG','damm.so'],['metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s','metaplex.so']]){vm.addProgram(key,fs.readFileSync(path.join(FIXTURES,file)));known.add(key);}
 const fixture=JSON.parse(fs.readFileSync(path.join(FIXTURES,'damm-config.json'))),a=fixture.account;
 vm.setAccount({address:fixture.pubkey,lamports:BigInt(a.lamports),data:Buffer.from(a.data[0],'base64'),programAddress:a.owner,executable:false,space:BigInt(Buffer.from(a.data[0],'base64').length)});known.add(fixture.pubkey);
 if(programId){vm.addProgram(String(programId),fs.readFileSync(programPath));known.add(String(programId));}
 vm.airdrop('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',1000000000n);
 function account(key){key=String(key);known.add(key);const a=vm.getAccount(key);return a.exists?{data:Buffer.from(a.data),owner:new PublicKey(a.programAddress),lamports:Number(a.lamports),executable:a.executable,rentEpoch:0}:null;}
 function wireAccount(a){return a?{...a,owner:a.owner.toBase58(),data:[a.data.toString('base64'),'base64']}:null;}
 function track(bytes){const tx=VersionedTransaction.deserialize(bytes);for(const p of tx.message.staticAccountKeys)known.add(p.toBase58());if(tx.message.addressTableLookups?.length){const lookup=tx.message.addressTableLookups.map(x=>new AddressLookupTableAccount({key:x.accountKey,state:AddressLookupTableAccount.deserialize(account(x.accountKey).data)}));for(const p of tx.message.getAccountKeys({addressLookupTableAccounts:lookup}).keySegments().flat())known.add(p.toBase58());}return bs58.encode(tx.signatures[0]);}
 function shape(result){const failed=result instanceof FailedTransactionMetadata,m=failed?result.meta():result;return {ok:!failed,error:failed?String(result.err()):null,logs:m.logs(),compute:Number(m.computeUnitsConsumed())};}
 function send(bytes){bytes=Buffer.from(bytes);const signature=track(bytes),r=vm.sendTransaction(getTransactionDecoder().decode(bytes)),result={signature,...shape(r),slot:Number(vm.getClock().slot),bytes:bytes.length};history.set(signature,result);if(!result.ok){const e=new Error(result.logs.findLast(x=>x.includes('Program log:'))||result.error);e.logs=result.logs;e.signature=signature;throw e;}return result;}
 function simulate(bytes){const r=vm.simulateTransaction(getTransactionDecoder().decode(Buffer.from(bytes)));if(r instanceof FailedTransactionMetadata)return shape(r);return shape(r.meta());}
 function advance(seconds){if(!Number.isSafeInteger(seconds)||seconds<0)throw Error('Local time advance must be a nonnegative integer');const c=vm.getClock();vm.setClock(new Clock(c.slot+BigInt(Math.max(1,seconds*2)),c.epochStartTimestamp,c.epoch,c.leaderScheduleEpoch,c.unixTimestamp+BigInt(seconds)));vm.expireBlockhash();}
 const connection=new Connection('http://127.0.0.1:19189','confirmed');
 connection.getAccountInfo=async k=>account(k.toBase58());connection.getAccountInfoAndContext=async k=>({context:{slot:Number(vm.getClock().slot)},value:account(k.toBase58())});connection.getMultipleAccountsInfo=async ks=>ks.map(k=>account(k.toBase58()));connection.getMultipleAccountsInfoAndContext=async ks=>({context:{slot:Number(vm.getClock().slot)},value:ks.map(k=>account(k.toBase58()))});
 connection.getSlot=async()=>Number(vm.getClock().slot);connection.getBlockTime=async()=>Number(vm.getClock().unixTimestamp);connection.getBalance=async k=>Number(vm.getBalance(k.toBase58())||0n);connection.getMinimumBalanceForRentExemption=async n=>Number(vm.minimumBalanceForRentExemption(BigInt(n)));
 connection.getLatestBlockhash=async()=>({blockhash:vm.latestBlockhash(),lastValidBlockHeight:Number(vm.getClock().slot)+150});connection.getLatestBlockhashAndContext=async()=>({context:{slot:Number(vm.getClock().slot)},value:await connection.getLatestBlockhash()});
 connection.sendRawTransaction=async bytes=>send(bytes).signature;connection.confirmTransaction=async sig=>({context:{slot:Number(vm.getClock().slot)},value:{err:history.get(typeof sig==='string'?sig:sig.signature)?.error||null}});
 connection.getTokenAccountBalance=async k=>{const a=account(k.toBase58());if(!a)throw Error('Token account absent');const mint=account(new PublicKey(a.data.subarray(0,32)).toBase58()),decimals=mint.data[44],amount=a.data.readBigUInt64LE(64).toString();return {context:{slot:Number(vm.getClock().slot)},value:{amount,decimals,uiAmount:Number(amount)/10**decimals,uiAmountString:(Number(amount)/10**decimals).toString()}};};
 connection.getProgramAccounts=async (id,opts={})=>[...known].map(pubkey=>({pubkey:new PublicKey(pubkey),account:account(pubkey)})).filter(x=>x.account?.owner.equals(id)&&(opts.filters||[]).every(f=>f.dataSize!==undefined?x.account.data.length===f.dataSize:f.memcmp?x.account.data.subarray(f.memcmp.offset,f.memcmp.offset+bs58.decode(f.memcmp.bytes).length).equals(Buffer.from(bs58.decode(f.memcmp.bytes))):true));
 function fund(key,lamports=10000000000n){vm.expireBlockhash();key=String(key);known.add(key);const r=vm.airdrop(key,BigInt(lamports));if(r instanceof FailedTransactionMetadata)throw Error('Local faucet failed');}
 async function execute(tx,signers){vm.expireBlockhash();tx.feePayer=signers[0].publicKey;tx.recentBlockhash=vm.latestBlockhash();tx.sign(...signers);const wire=tx.serialize(),simulation=simulate(wire);if(!simulation.ok){const e=Error(simulation.logs.findLast(x=>x.includes('Program log:'))||simulation.error);e.logs=simulation.logs;throw e;}return send(wire);}
 return {vm,connection,known,history,account,wireAccount,send,simulate,advance,fund,execute,root:ROOT};
}
module.exports={createEnvironment};
