// Read-only verification; safe to rerun after an interrupted deployment command.
const fs=require('node:fs');
const {Connection,PublicKey}=require('@solana/web3.js');
const {deploymentInfo}=require('./runtime/deployment-info.cjs');
(async()=>{
 const connection=new Connection(process.env.LAUNCH_RPC_URL||'https://api.devnet.solana.com','confirmed');
 if(await connection.getGenesisHash()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw Error('Verification requires devnet.');
 const plan=JSON.parse(fs.readFileSync('deployment-plan.json','utf8')),programId=new PublicKey(plan.programId);
 const info=await deploymentInfo(connection,programId);
 const signatures=await connection.getSignaturesForAddress(programId,{limit:20});
 const deploy=signatures.find(s=>String(s.slot)===info.lastDeploySlot&&!s.err);
 const manifest={network:'devnet',status:'deployed; bytecode verified (application evidence recorded separately)',programId:programId.toBase58(),payer:plan.payer,...info,deployedSha256:info.sha256,deploymentSignature:deploy?.signature||null,deployedAt:deploy?.blockTime?new Date(deploy.blockTime*1000).toISOString():null,upgradeAuthorityRetained:info.upgradeable,explorer:'https://explorer.solana.com/address/'+programId+'?cluster=devnet'};
 fs.writeFileSync('deployment.json',JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify(manifest,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1});
