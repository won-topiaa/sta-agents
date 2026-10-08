import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hash} from '../lib/research-autonomy-policy.mjs';
import {AutonomyStockMesh} from '../lib/research-autonomy-stockmesh.mjs';
function fixture(t,reply=null){
 const dir=mkdtempSync(join(tmpdir(),'sta-quote-wire-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const release={network:'mainnet-beta',engineBinarySha256:'e'.repeat(64),artifacts:{catalog:{sha256:'c'.repeat(64)},manifest:{sha256:'d'.repeat(64)},contracts:{sha256:'a'.repeat(64)}}};
 const releaseFile=join(dir,'release.json'),bytes=Buffer.from(JSON.stringify(release));writeFileSync(releaseFile,bytes);let calls=0;
 const adapter=new AutonomyStockMesh({base:'http://127.0.0.1:4999/',token:'fixture-not-live-'.repeat(4),releaseFile,releaseSha256:hash(bytes)},async(url,options)=>{
  calls++;assert.equal(new URL(url).pathname,'/v1/quote');const body=JSON.parse(options.body);
  const keys=['instrument','side','notional','notionalAsset','notionalAtoms','maxSlippageBps',...(body.side==='SELL'?['productMint']:[])];
  assert.deepEqual(Object.keys(body).sort(),keys.sort()); // Rust QuoteRequest contract
  return Response.json(reply??{body,releaseBinding:adapter.binding});
 });
 return{adapter,calls:()=>calls};
}
const buy={instrument:'JNJ',side:'BUY',notional:'0.333200',inputAtoms:'333200',notionalAsset:'USDC',maxSlippageBps:20};
test('reported sub-dollar plan reaches exact engine schema, not internal fields',async t=>{
 const {adapter}=fixture(t);const r=await adapter.quote({...buy,inputDecimals:6,mint:'internal',planId:'private-plan',notionalAtoms:'999999'});
 assert.deepEqual(r.body,{instrument:'JNJ',side:'BUY',notional:'0.333200',notionalAsset:'USDC',notionalAtoms:'333200',maxSlippageBps:20});
});
test('all reported allocation legs retain exact small cash amount',async t=>{
 const {adapter}=fixture(t);for(const instrument of ['JNJ','SPY','XOM']){
  const r=await adapter.quote({...buy,instrument});assert.equal(r.body.notionalAtoms,'333200');
 }
});
test('approved input amount mismatch is rejected before read',async t=>{
 const x=fixture(t);await assert.rejects(x.adapter.quote({...buy,inputAtoms:'333201'}),/QUOTE_INPUT_AMOUNT_MISMATCH/);assert.equal(x.calls(),0);
});
test('buy cannot leak productMint into exact quote contract',async t=>{
 const x=fixture(t);const r=await x.adapter.quote({...buy,productMint:'internal-product'});assert.equal(Object.hasOwn(r.body,'productMint'),false);
});
test('sell keeps token atoms and exact issuer mint, omits internal fields',async t=>{
 const x=fixture(t);const r=await x.adapter.quote({instrument:'NVDA',side:'SELL',notional:'0.000100001',inputAtoms:'100001',inputDecimals:9,productMint:'fixture-mint',minimumCashAtoms:'1',notionalAsset:'USDC',maxSlippageBps:20});
 assert.equal(r.body.notionalAtoms,'100001');assert.equal(r.body.productMint,'fixture-mint');assert.equal(r.body.notional,'0.000100001');
});
test('unsupported asset or side never reaches engine',async t=>{
 const x=fixture(t);await assert.rejects(x.adapter.quote({...buy,notionalAsset:'SOL'}),/INVALID_QUOTE_ASSET/);await assert.rejects(x.adapter.quote({...buy,side:'TRANSFER'}),/INVALID_TRADE_SIDE/);assert.equal(x.calls(),0);
});
test('release mismatch is still fatal; wire fix cannot weaken engine pinning',async t=>{
 const x=fixture(t,{releaseBinding:{}});await assert.rejects(x.adapter.quote(buy),/STOCKMESH_RELEASE_CHANGED/);
});
test('receipt observation uses only owner-scoped orders and rejects stale or foreign records',async t=>{
 const {adapter}=fixture(t);let change={};const requests=[];
 adapter.fetcher=async(url,o)=>{requests.push(new URL(url).pathname);assert.equal(o.method,'POST');assert.deepEqual(JSON.parse(o.body),{owner:'owner',preparedId:'stkp_exact'});return Response.json({schema:'skew.stockmesh.orders/v1',owner:'owner',refreshSucceeded:true,truncated:false,orders:[{preparedId:'stkp_exact',phase:'RECONCILED',signature:'exact',receiptVerified:true}],releaseBinding:adapter.binding,...change});};
 assert.equal((await adapter.order('owner','stkp_exact')).phase,'RECONCILED');
 for(const bad of [{refreshSucceeded:false},{owner:'foreign'},{truncated:true},{orders:[{preparedId:'stkp_other'}]}]){change=bad;await assert.rejects(adapter.order('owner','stkp_exact'),/STOCKMESH_RECONCILIATION_PENDING/);}
 change={orders:[]};assert.equal(await adapter.order('owner','stkp_exact'),null);assert.ok(requests.every(p=>p==='/v1/orders'));
});
