const test=require('node:test'),assert=require('node:assert/strict');
const {setup}=require('./harness.cjs'),{inspect,buildRecovery}=require('../runtime/recovery.cjs');
test('server-independent recovery discovers entitlement and refunds via chain accounts alone',async()=>{
 const h=await setup();await h.invoke('contribute',h.a,{amount:123456789n});const args={connection:h.e.connection,programId:h.programId,campaign:h.created.campaign,wallet:h.a.publicKey,action:'refund'};
 const status=await inspect(args.connection,args.programId,args.campaign,args.wallet);assert(status.configMatches);assert.equal(status.receipt.amount,123456789n);await assert.rejects(buildRecovery(args),/No refundable/);h.e.advance(100);const tx=await buildRecovery(args);const before=h.balance(h.created.vault);await h.e.execute(tx.transaction,[h.a]);assert.equal(before-h.balance(h.created.vault),123456789n);await assert.rejects(buildRecovery(args),/No refundable/);
});
