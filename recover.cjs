#!/usr/bin/env node
// Read/prepare by default. Sending requires an explicit key file and --send.
const fs=require('node:fs'),{Connection,PublicKey,Keypair}=require('@solana/web3.js');
const {inspect,buildRecovery}=require('./runtime/recovery.cjs');
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2);
async function main(){
 const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i++){const k=args[i];if(k==='--send'||k==='--help')opts[k]=true;else if(k.startsWith('--')&&args[i+1]&&!args[i+1].startsWith('--'))opts[k]=args[++i];else throw Error('Invalid argument '+k);}
 if(opts['--help'])return console.log('Read: node recover.cjs --rpc URL --program ADDRESS --campaign ADDRESS --wallet ADDRESS\nPrepare: add --action refund|claim|withdraw|settle\nSend on devnet: add --keypair PATH --send (never paste a secret key).\nThe website and organizer are not needed. This experimental release only sends to Solana devnet.');
 const connection=new Connection(opts['--rpc']||'https://api.devnet.solana.com','confirmed'),programId=new PublicKey(opts['--program']),campaign=new PublicKey(opts['--campaign']);
 let signer;if(opts['--send']){if(!opts['--keypair'])throw Error('--send requires --keypair PATH');if(await connection.getGenesisHash()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw Error('This release only sends to devnet.');signer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(opts['--keypair'],'utf8'))));}
 const wallet=signer?.publicKey||(opts['--wallet']?new PublicKey(opts['--wallet']):null);
 if(!opts['--action'])return console.log(json(await inspect(connection,programId,campaign,wallet)));
 if(!wallet)throw Error('A wallet address is required to prepare an action.');const result=await buildRecovery({connection,programId,campaign,wallet,action:opts['--action']});
 const tx=result.transaction,block=await connection.getLatestBlockhash();tx.feePayer=wallet;tx.recentBlockhash=block.blockhash;
 if(!signer)return console.log(json({status:result.status,unsignedTransaction:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),message:'Not sent. Inspect the terms and use --keypair PATH --send on devnet.'}));
 tx.sign(signer);const sim=await connection.simulateTransaction(tx);if(sim.value.err)throw Error('Simulation rejected: '+JSON.stringify(sim.value.err)+'\n'+sim.value.logs?.join('\n'));
 const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false});const confirmation=await connection.confirmTransaction({...block,signature},'confirmed');if(confirmation.value.err)throw Error('Transaction rejected: '+JSON.stringify(confirmation.value.err));console.log(json({signature,network:'devnet',action:opts['--action']}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
