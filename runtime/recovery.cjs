// Independent of the web server. Uses only chain accounts, an RPC and the SDK.
const lc=require('../sdk/index.cjs');
async function inspect(connection,programId,campaign,wallet){
 const a=await connection.getAccountInfo(campaign);if(!a||!a.owner.equals(programId))throw Error('Campaign is absent or belongs to a different program.');
 const c=lc.decodeCampaign(a.data),slot=await connection.getSlot(),time=await connection.getBlockTime(slot);if(time===null)throw Error('RPC did not return chain time.');
 const config=await connection.getAccountInfo(c.config);const configMatches=!!config&&config.owner.equals(lc.DBC_PROGRAM_ID)&&lc.hashConfig(config.data)===c.configHash;
 let receipt=null;if(wallet){const r=await connection.getAccountInfo(lc.deriveReceipt(programId,campaign,wallet)[0]);if(r?.owner.equals(programId))receipt=lc.decodeReceipt(r.data);}
 return {programId,campaign,chainTime:time,phase:lc.phase(c,BigInt(time)),configMatches,terms:c,receipt,allocation:receipt&&c.state===lc.STATE.Settled?lc.allocation({contribution:receipt.amount,total:c.totalContributed,target:c.target,bought:c.tokensBought}):null};
}
async function buildRecovery({connection,programId,campaign,wallet,action}){
 const status=await inspect(connection,programId,campaign,wallet),common={connection,programId,campaign,contributor:wallet};
 if(action==='refund'){if(status.phase!=='refundable'||!status.receipt)throw Error('No refundable receipt at the current chain time.');}
 else if(action==='claim'){if(status.phase!=='settled'||!status.receipt)throw Error('No claimable receipt.');}
 else if(action==='withdraw'){if(status.phase!=='funding'||!status.receipt)throw Error('No withdrawable receipt before close.');common.amount=status.receipt.amount;}
 else if(action==='settle'){if(status.phase!=='settleable'||!status.configMatches)throw Error('Campaign is not settleable with its bound configuration.');}
 else throw Error('Action must be refund, claim, withdraw or settle.');
 return {...await lc[action](common),status};
}
module.exports={inspect,buildRecovery};
