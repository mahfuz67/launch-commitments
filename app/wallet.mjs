import {getWallets} from '@wallet-standard/app';
import {Transaction,PublicKey} from '@solana/web3.js';
import {Buffer} from 'buffer';
export const registry=getWallets();
export const availableWallets=()=>registry.get().filter(w=>w.features['standard:connect']&&w.features['solana:signTransaction']);
export function accountFor(wallet,chain){return wallet.accounts.find(a=>a.chains.includes(chain)&&a.features.includes('solana:signTransaction'));}
export async function connectWallet(wallet,chain){await wallet.features['standard:connect'].connect();const account=accountFor(wallet,chain);if(!account)throw Error(`This wallet has no account that supports ${chain}. Switch its network and reconnect.`);return account;}
export async function signWalletTransaction(wallet,account,chain,base64){
 if(!wallet.accounts.some(a=>a.address===account.address)||!account.chains.includes(chain))throw Error('Wallet account or network changed. Reconnect and review the transaction again.');
 const original=Transaction.from(Buffer.from(base64,'base64'));if(!original.feePayer?.equals(new PublicKey(account.address)))throw Error('The prepared transaction has a different payer.');
 const [result]=await wallet.features['solana:signTransaction'].signTransaction({transaction:new Uint8Array(Buffer.from(base64,'base64')),account,chain});
 if(!result?.signedTransaction)throw Error('Wallet did not return a signed transaction.');
 const signed=Transaction.from(Buffer.from(result.signedTransaction));if(!signed.serializeMessage().equals(original.serializeMessage()))throw Error('The wallet changed the transaction after review. Prepare it again.');
 return signed.serialize(); // checks all signatures, including config/NFT co-signers
}
