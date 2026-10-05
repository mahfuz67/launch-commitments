const test=require('node:test'),assert=require('node:assert/strict');
const {setup,reject,Keypair,PublicKey,Transaction,SystemProgram,BN,dbc}=require('./harness.cjs');
const {getAssociatedTokenAddressSync}=require('@solana/spl-token');

test('oversubscribed launch: any settler, real DBC purchase, exact pro-rata tokens and excess, one claim each',async()=>{
 const h=await setup();await h.invoke('contribute',h.a,{amount:1000000000n});await h.invoke('contribute',h.b,{amount:2000000000n});assert.equal(h.read().totalContributed,3000000000n);
 await reject(h.invoke('settle',h.stranger),6010);h.e.advance(100);const settled=await h.invoke('settle',h.stranger);assert(settled.bytes<=1232);assert(settled.compute<400000);
 const s=h.read();assert.equal(s.tokensBought>0n,true);assert.equal(s.totalContributed,3000000000n);assert.equal(h.lc.phase(s,h.e.vm.getClock().unixTimestamp),'settled');
 const pool=dbc.deriveDbcPoolAddress(h.lc.WSOL_MINT,h.created.mint,h.cfg.publicKey),p=await h.client.state.getPool(pool);assert(p.poolState.creator.equals(h.owner.publicKey));assert(p.poolState.quoteReserve.gt(new BN(0)));
 const expectedA=s.tokensBought/3n,expectedB=s.tokensBought*2n/3n;
 for(const [who,tokens,excess] of [[h.a,expectedA,333333333n],[h.b,expectedB,666666666n]]){
  const beforeVault=h.balance(h.created.vault),beforeToken=h.tokenBalance(who);await h.invoke('claim',who);assert.equal(h.tokenBalance(who)-beforeToken,tokens);assert.equal(beforeVault-h.balance(h.created.vault),excess);assert.equal(h.receipt(who),null);await reject(h.invoke('claim',who));
 }
 assert.equal(h.read().excessPaid,999999999n);assert.equal(h.read().tokensClaimed,expectedA+expectedB);await reject(h.invoke('settle',h.stranger),6013);await reject(h.invoke('refund',h.a));
});

test('underfunded round refunds full accounted principal at close, no DBC dependency',async()=>{
 const h=await setup();await h.invoke('contribute',h.a,{amount:777777777n});await reject(h.invoke('refund',h.a),6014);h.e.advance(100);const vault=h.balance(h.created.vault);await h.invoke('refund',h.a);assert.equal(vault-h.balance(h.created.vault),777777777n);assert.equal(h.read().refunded,777777777n);assert.equal(h.receipt(h.a),null);assert.equal(h.e.account(h.created.mint.toBase58()),null);await reject(h.invoke('refund',h.a));
});

test('funded but abandoned launch becomes refundable exactly at expiry',async()=>{
 const h=await setup();await h.invoke('contribute',h.a,{amount:h.terms.target});h.e.advance(199);await reject(h.invoke('refund',h.a),6014);h.e.advance(1);await reject(h.invoke('settle',h.stranger),6012);await h.invoke('refund',h.a);assert.equal(h.read().refunded,h.terms.target);
});

test('withdrawals reopen receipt safely before close; deposit and withdrawal both reject at close',async()=>{
 const h=await setup();await h.invoke('contribute',h.a,{amount:100n});await h.invoke('withdraw',h.a,{amount:40n});assert.equal(h.receipt(h.a).amount,60n);assert.equal(h.read().totalContributed,60n);await h.invoke('withdraw',h.a,{amount:60n});assert.equal(h.receipt(h.a),null);assert.equal(h.read().totalContributed,0n);await h.invoke('contribute',h.a,{amount:99n});h.e.advance(100);await reject(h.invoke('withdraw',h.a,{amount:99n}),6009);await reject(h.invoke('contribute',h.b,{amount:1n}),6009);
});

test('an impossible promised output rolls back mint, pool, principal and rent; expiry refund still works',async()=>{
 const h=await setup({minimum:999999999999999999n});await h.invoke('contribute',h.a,{amount:h.terms.target});h.e.advance(100);const vault=h.balance(h.created.vault),budget=h.balance(h.created.budget);await reject(h.invoke('settle',h.stranger));assert.equal(h.e.account(h.created.mint.toBase58()),null);assert.equal(h.balance(h.created.vault),vault);assert.equal(h.balance(h.created.budget),budget);assert.equal(h.read().tokensBought,0n);h.e.advance(100);await h.invoke('refund',h.a);assert.equal(h.read().refunded,h.terms.target);
});

test('direct donations do not buy entitlement, count toward the target, or increase refunds',async()=>{
 const h=await setup();await h.e.execute(new Transaction().add(SystemProgram.transfer({fromPubkey:h.stranger.publicKey,toPubkey:h.created.vault,lamports:3000000000})),[h.stranger]);await h.invoke('contribute',h.a,{amount:123n});assert.equal(h.read().totalContributed,123n);h.e.advance(100);await reject(h.invoke('settle',h.stranger),6011);const before=h.balance(h.created.vault);await h.invoke('refund',h.a);assert.equal(before-h.balance(h.created.vault),123n);assert(h.balance(h.created.vault)>=3000000000n);
});

test('substituted recipient cannot withdraw another contribution',async()=>{
 const h=await setup();await h.invoke('contribute',h.a,{amount:1000000n});const built=await h.lc.withdraw({programId:h.programId,campaign:h.created.campaign,contributor:h.a.publicKey,amount:1000000n});const ix=built.transaction.instructions[0];ix.keys[0].pubkey=h.stranger.publicKey;await reject(h.e.execute(built.transaction,[h.stranger]));assert.equal(h.receipt(h.a).amount,1000000n);
});

test('substituted system program and settlement token destination are rejected',async()=>{
 const h=await setup();const x=await h.lc.contribute({programId:h.programId,campaign:h.created.campaign,contributor:h.a.publicKey,amount:1n});x.transaction.instructions[0].keys[4].pubkey=h.lc.DBC_PROGRAM_ID;await reject(h.e.execute(x.transaction,[h.a]));await h.invoke('contribute',h.a,{amount:h.terms.target});h.e.advance(100);const y=await h.lc.settle({connection:h.e.connection,programId:h.programId,campaign:h.created.campaign});const ix=y.transaction.instructions.find(i=>i.programId.equals(h.programId));ix.keys[13].pubkey=getAssociatedTokenAddressSync(h.created.mint,h.stranger.publicKey);await reject(h.e.execute(y.transaction,[h.stranger]));assert.equal(h.e.account(h.created.mint.toBase58()),null);
});

test('configuration bytes changed after funding cannot be settled, and refund remains available',async()=>{
 const h=await setup();await h.invoke('contribute',h.a,{amount:h.terms.target});const addr=h.cfg.publicKey.toBase58(),a=h.e.vm.getAccount(addr),data=Buffer.from(a.data);data[103]^=1;h.e.vm.setAccount({...a,data});h.e.advance(100);await reject(h.invoke('settle',h.stranger));h.e.advance(100);await h.invoke('refund',h.a);assert.equal(h.read().refunded,h.terms.target);
});

test('random withdrawal/deposit schedules conserve accounted principal before a failed launch',async()=>{
 const h=await setup({target:5000000000n});let seed=908713;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};const people=[h.a,h.b,h.stranger],book=[0n,0n,0n];for(let i=0;i<60;i++){const j=next()%3,amount=BigInt(next()%100000+1);if((next()%2)&&book[j]>=amount){await h.invoke('withdraw',people[j],{amount});book[j]-=amount;}else{await h.invoke('contribute',people[j],{amount});book[j]+=amount;}assert.equal(h.read().totalContributed,book.reduce((a,b)=>a+b,0n));}
 h.e.advance(100);for(let j=0;j<3;j++)if(book[j]){const before=h.balance(h.created.vault);await h.invoke('refund',people[j]);assert.equal(before-h.balance(h.created.vault),book[j]);}assert.equal(h.read().refunded,book.reduce((a,b)=>a+b,0n));
});
