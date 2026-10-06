// Plan by default. --execute sends only to verified Solana devnet.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const {Connection,Keypair,PublicKey}=require('@solana/web3.js');
(async()=>{
 const rpc=process.env.LAUNCH_RPC_URL||'https://api.devnet.solana.com',connection=new Connection(rpc,'confirmed');if(await connection.getGenesisHash()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw Error('Only devnet is supported.');
 const payerFile=path.resolve(process.env.DEPLOY_KEYPAIR||'private/devnet-payer.json'),programFile=path.resolve(process.env.PROGRAM_KEYPAIR||'program/build/launch_commitments-keypair.json'),binary=path.resolve('program/build/launch_commitments.so');
 const readKey=p=>Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p,'utf8'))));const payer=readKey(payerFile),program=readKey(programFile),bytes=fs.readFileSync(binary),hash=crypto.createHash('sha256').update(bytes).digest('hex');
 if(hash!=='1e8d66705b2ee91c504552fb7e55cf26fb046d54aec26e0aed54e1c48b9e6e4b')throw Error('Binary differs from the reviewed build. Revalidate it and update this manifest intentionally.');
 if(await connection.getAccountInfo(program.publicKey))throw Error('Program address already exists. This helper only performs initial deployments.');
 const programDataRent=await connection.getMinimumBalanceForRentExemption(bytes.length+45),bufferRent=await connection.getMinimumBalanceForRentExemption(bytes.length+37),programRent=await connection.getMinimumBalanceForRentExemption(36),balance=await connection.getBalance(payer.publicKey),reserve=350000000;
 const plan={network:'devnet',status:'not deployed',programId:program.publicKey.toBase58(),payer:payer.publicKey.toBase58(),upgradeAuthority:payer.publicKey.toBase58(),sha256:hash,bytes:bytes.length,balanceLamports:balance,conservativeUpfrontLamports:programDataRent+bufferRent+programRent+reserve,allowanceForTestFlowsLamports:reserve,bufferRentReturnedOnSuccess:true,upgradeAuthorityRetained:true};
 fs.mkdirSync('evidence/reports',{recursive:true});fs.writeFileSync('evidence/reports/deployment-plan.json',JSON.stringify(plan,null,2));console.log(JSON.stringify(plan,null,2));if(!process.argv.includes('--execute'))return;
 if(balance<plan.conservativeUpfrontLamports)throw Error('Insufficient devnet test SOL. Nothing deployed.');
 const result=await new Promise((resolve,reject)=>{const child=spawn('solana',['program','deploy','--url',rpc,'--keypair',payerFile,'--program-id',programFile,'--upgrade-authority',payerFile,'--max-len',String(bytes.length),'--output','json','--use-rpc','--max-sign-attempts','10',...(process.env.DEPLOY_BUFFER?['--buffer',process.env.DEPLOY_BUFFER]:[]),binary],{stdio:['ignore','pipe','pipe']});
  let stderr='';child.stdout.resume();child.stderr.on('data',d=>{stderr=(stderr+d).slice(-1048576)});
  const timer=setTimeout(()=>child.kill('SIGTERM'),900000);child.on('error',e=>{clearTimeout(timer);reject(e)});child.on('close',status=>{clearTimeout(timer);resolve({status,stderr})});
 });
 if(result.status!==0){
  const safeLines=(result.stderr||'').split('\n').filter(line=>/^(Error:|RPC request error:|Transaction simulation failed:)/.test(line));
  if(safeLines.length)console.error(safeLines.join('\n'));
  throw Error('Deployment CLI did not confirm success; inspect the program on devnet before retrying.');
 }
 const account=await connection.getAccountInfo(program.publicKey);if(!account?.executable)throw Error('Executable program was not observed after deploy.');const pd=new PublicKey(account.data.subarray(4,36)),data=await connection.getAccountInfo(pd);const landedHash=crypto.createHash('sha256').update(data.data.subarray(45,45+bytes.length)).digest('hex');if(landedHash!==hash)throw Error('Deployed bytes do not match reviewed binary.');
 const manifest={...plan,status:'deployed; application flow not yet verified',programData:pd.toBase58(),deployedAt:new Date().toISOString(),deployedSha256:landedHash};fs.writeFileSync('deployment.json',JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
