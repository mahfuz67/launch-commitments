const test=require('node:test'),assert=require('node:assert/strict');
const {setup,BN,dbc,Transaction,SystemProgram}=require('./harness.cjs');
const spl=require('@solana/spl-token'),damm=require('@meteora-ag/cp-amm-sdk');

for(const scale of [1,0.01]) test(`launched allocation trades on DBC, graduates, migrates and trades on DAMM v2 (scale ${scale})`,async()=>{
 const divisor=scale===1?1n:100n,h=await setup({target:2000000000n/divisor,customPreset:require('../runtime/preset.cjs').preset({scale})});await h.invoke('contribute',h.a,{amount:h.terms.target});h.e.advance(100);const settlement=await h.invoke('settle',h.stranger);await h.invoke('claim',h.a);
 const pool=dbc.deriveDbcPoolAddress(h.lc.WSOL_MINT,h.created.mint,h.cfg.publicKey),cfg=await h.client.state.getPoolConfig(h.cfg.publicKey);
 const trade=async(who,sell,amount)=>{const vp=await h.client.state.getPool(pool),q=h.client.pool.swapQuote2({virtualPool:vp,config:cfg,swapBaseForQuote:sell,swapMode:1,amountIn:new BN(amount.toString()),slippageBps:50,hasReferral:false,currentPoint:new BN(h.e.vm.getClock().unixTimestamp.toString())});return h.e.execute(await h.client.pool.swap2({owner:who.publicKey,pool,swapBaseForQuote:sell,swapMode:1,amountIn:new BN(amount.toString()),minimumAmountOut:q.minimumAmountOut,referralTokenAccount:null}),[who]);};
 const before=h.tokenBalance(h.a);await trade(h.a,true,before/10n);assert(h.tokenBalance(h.a)<before);
 await trade(h.b,false,20000000000n/divisor);assert((await h.client.state.getPool(pool)).poolState.finishCurveTimestamp.gt(new BN(0)));
 const migration=await h.client.migration.migrateToDammV2({pool,dammConfig:dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption],payer:h.stranger.publicKey});
 const migrated=await h.e.execute(migration.transaction,[h.stranger,migration.firstPositionNftKeypair,migration.secondPositionNftKeypair]);assert((await h.client.state.getPool(pool)).poolState.isMigrated);
 const cp=new damm.CpAmm(h.e.connection),dp=dbc.deriveDammV2PoolAddress(dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption],h.created.mint,h.lc.WSOL_MINT),ps=await cp.fetchPoolState(dp),amount=new BN((h.tokenBalance(h.a)/10n).toString());
 let locked=new BN(0);for(const nft of [migration.firstPositionNftKeypair,migration.secondPositionNftKeypair]){const address=damm.derivePositionAddress(nft.publicKey);if(!h.e.account(address.toBase58()))continue;const position=await cp.fetchPositionState(address);locked=locked.add(position.permanentLockedLiquidity);assert(position.unlockedLiquidity.isZero());}assert(locked.gt(new BN(0)));assert(locked.eq(ps.liquidity));
 const q=cp.getQuote({inAmount:amount,inputTokenMint:h.created.mint,slippage:0.5,poolState:ps,currentTime:Number(h.e.vm.getClock().unixTimestamp),currentSlot:Number(h.e.vm.getClock().slot),tokenADecimal:6,tokenBDecimal:9,hasReferral:false});
 const swap=await cp.swap2({payer:h.a.publicKey,pool:dp,inputTokenMint:h.created.mint,outputTokenMint:h.lc.WSOL_MINT,tokenAMint:ps.tokenAMint,tokenBMint:ps.tokenBMint,tokenAVault:ps.tokenAVault,tokenBVault:ps.tokenBVault,tokenAProgram:damm.getTokenProgram(ps.tokenAFlag),tokenBProgram:damm.getTokenProgram(ps.tokenBFlag),poolState:ps,referralTokenAccount:null,swapMode:0,amountIn:amount,minimumAmountOut:q.minSwapOutAmount});
 const beforeSol=h.balance(h.a);const traded=await h.e.execute(swap,[h.a]);assert(h.balance(h.a)>beforeSol);console.log('Lifecycle evidence',JSON.stringify({settlement:{bytes:settlement.bytes,compute:settlement.compute},migration:{bytes:migrated.bytes,compute:migrated.compute},dammTrade:{bytes:traded.bytes,compute:traded.compute}}));
});

test('unsynchronized SOL donation to precreated vault WSOL account cannot block settlement',async()=>{
 const h=await setup(),ata=spl.getAssociatedTokenAddressSync(h.lc.WSOL_MINT,h.created.vault,true);
 await h.e.execute(new Transaction().add(spl.createAssociatedTokenAccountIdempotentInstruction(h.stranger.publicKey,ata,h.created.vault,h.lc.WSOL_MINT),SystemProgram.transfer({fromPubkey:h.stranger.publicKey,toPubkey:ata,lamports:1000000})),[h.stranger]);
 await h.invoke('contribute',h.a,{amount:h.terms.target});h.e.advance(100);await h.invoke('settle',h.stranger);assert(h.read().tokensBought>0n);assert.equal(h.e.account(ata.toBase58()).data.readBigUInt64LE(64),1000000n);
});
