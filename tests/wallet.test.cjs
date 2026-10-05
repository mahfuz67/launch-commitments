const test=require('node:test'),assert=require('node:assert/strict');
const {Keypair,Transaction,SystemProgram}=require('@solana/web3.js');
test('Wallet Standard signing preserves message and config co-signature; altered or incomplete results reject',async()=>{
 const {signWalletTransaction}=await import('../app/wallet.mjs');
 const payer=Keypair.generate(),co=Keypair.generate(),account={address:payer.publicKey.toBase58(),chains:['solana:devnet']};
 const original=new Transaction({feePayer:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:co.publicKey,lamports:1}),SystemProgram.transfer({fromPubkey:co.publicKey,toPubkey:payer.publicKey,lamports:1}));original.partialSign(co);
 const base64=original.serialize({requireAllSignatures:false}).toString('base64');
 const wallet={accounts:[account],features:{'solana:signTransaction':{signTransaction:async input=>{assert.equal(input.chain,'solana:devnet');assert.equal(input.account,account);const tx=Transaction.from(input.transaction);tx.partialSign(payer);return [{signedTransaction:tx.serialize()}];}}}};
 const signed=Transaction.from(await signWalletTransaction(wallet,account,'solana:devnet',base64));assert(signed.verifySignatures());assert(signed.serializeMessage().equals(original.serializeMessage()));
 wallet.features['solana:signTransaction'].signTransaction=async input=>{const tx=Transaction.from(input.transaction);tx.signatures=[];tx.partialSign(payer);return [{signedTransaction:tx.serialize({requireAllSignatures:false})}];};await assert.rejects(signWalletTransaction(wallet,account,'solana:devnet',base64),/Signature verification failed/);
 wallet.features['solana:signTransaction'].signTransaction=async input=>{const tx=Transaction.from(input.transaction);tx.instructions[0].data[4]^=1;return [{signedTransaction:tx.serialize({requireAllSignatures:false,verifySignatures:false})}];};await assert.rejects(signWalletTransaction(wallet,account,'solana:devnet',base64),/changed the transaction/);
 await assert.rejects(signWalletTransaction(wallet,account,'solana:mainnet',base64),/network changed/);
});
