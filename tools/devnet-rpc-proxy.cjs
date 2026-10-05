// Temporary local upload proxy. Pace requests to respect shared RPC limits.
// No keys, caching, response rewriting, or requests to another network.
const http=require('node:http');
const upstream=process.env.LAUNCH_UPSTREAM_RPC||'https://api.devnet.solana.com';
const port=Number(process.env.LAUNCH_PROXY_PORT||19192),queue=[];
let active=0,pauseUntil=0,served=0;
async function main(){
 const r=await fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getGenesisHash'})});
 if((await r.json()).result!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw Error('Upstream is not verified devnet.');
 http.createServer((req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let body='';req.on('data',b=>{body+=b;if(body.length>2000000)req.destroy();});
  req.on('end',()=>{try{JSON.parse(body)}catch{res.writeHead(400).end();return;}
   if(queue.length>1000){res.writeHead(503).end();return;}queue.push({body,res});});
 }).listen(port,'127.0.0.1',()=>console.log('Verified devnet proxy ready on loopback port',port));
 setInterval(async()=>{
  if(active>=2||Date.now()<pauseUntil||!queue.length)return;
  const {body,res}=queue.shift();active++;
  try{
   const reply=await fetch(upstream,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(45000)});
   if(reply.status===429)pauseUntil=Date.now()+Math.max(10000,Number(reply.headers.get('retry-after')||0)*1000);
   const bytes=await reply.arrayBuffer();res.writeHead(reply.status,{'content-type':'application/json'});res.end(Buffer.from(bytes));served++;
   if(served%25===0)console.log('Requests served',served,'queued',queue.length);
  }catch{res.writeHead(502).end('{"error":"Devnet RPC unavailable"}');}finally{active--;}
 },350);
}
main().catch(e=>{console.error(e.message);process.exit(1)});
