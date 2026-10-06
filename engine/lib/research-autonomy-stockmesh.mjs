import {readFileSync} from 'node:fs';
import {hash,integer,requirePolicy as need} from './research-autonomy-policy.mjs';

// Private loopback relay to the existing, release-pinned user transaction API.
// This adapter neither publishes policies nor holds a Solana private key.
export class AutonomyStockMesh {
 constructor(config,fetcher=fetch){
  this.config=config;this.fetcher=fetcher;
  const u=new URL(config.base);need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/','STOCKMESH_LOOPBACK_REQUIRED');
  need(typeof config.token==='string'&&config.token.length>=32,'STOCKMESH_CREDENTIAL_REQUIRED');
  const bytes=readFileSync(config.releaseFile);need(hash(bytes)===config.releaseSha256,'STOCKMESH_RELEASE_CHANGED');
  const doc=JSON.parse(bytes);need(doc.network==='mainnet-beta','WRONG_STOCKMESH_NETWORK');
  this.binding={schema:'xtxc.release-binding/v1',releaseSha256:config.releaseSha256,engineBinarySha256:doc.engineBinarySha256,catalogSha256:doc.artifacts.catalog.sha256,manifestSha256:doc.artifacts.manifest.sha256,contractsSha256:doc.artifacts.contracts.sha256};
 }
 async call(path,body){
  need(['/v1/status','/v1/quote','/v1/prepare','/v1/submit','/v1/portfolio'].includes(path),'STOCKMESH_OPERATION_NOT_ALLOWED');
  if(path==='/v1/prepare'||path==='/v1/submit')await this.call('/v1/status');
  const r=await this.fetcher(new URL(path,this.config.base),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${this.config.token}`,'Content-Type':'application/json','X-Skew-Product':'stocklana','X-XTXC-Release':this.config.releaseSha256},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(20000)});
  const reader=r.body?.getReader();need(reader,'STOCKMESH_EMPTY');const chunks=[];let size=0;
  try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;need(size<=1024*1024,'STOCKMESH_OVERSIZED');chunks.push(p.value);}}finally{await reader.cancel();}
  const value=JSON.parse(Buffer.concat(chunks).toString());
  need(r.ok,typeof value.error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(value.error.code)?value.error.code:'STOCKMESH_UNAVAILABLE');
  need(Object.entries(this.binding).every(([key,v])=>value.releaseBinding?.[key]===v),'STOCKMESH_RELEASE_CHANGED');
  return value;
 }
 async quote(request){let atoms;
  if(request.side==='SELL'){need(request.productMint&&request.inputAtoms,'EXACT_SELL_PRODUCT_REQUIRED');atoms=request.inputAtoms;}
  else{need(typeof request.notional==='string'&&/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(request.notional),'INVALID_NOTIONAL');const [a,b='']=request.notional.split('.');atoms=String(BigInt(a)*1000000n+BigInt(b.padEnd(6,'0')));}
  integer(atoms);
  // The first quote wakes a parked MicroBank. Retry only this read, with a
  // finite warm-up window. Never retry prepare, signing or submit here.
  for(let attempt=0;;attempt++){try{return await this.call('/v1/quote',{...request,notionalAtoms:atoms});}catch(e){if(e.code!=='STOCKLANA_STATE_STALE'||attempt>=3)throw e;await new Promise(resolve=>setTimeout(resolve,1200));}}
 }
 prepare(request){return this.call('/v1/prepare',request);}
 submit(request){return this.call('/v1/submit',request);}
 portfolio(owner){return this.call('/v1/portfolio',{owner});}
}
