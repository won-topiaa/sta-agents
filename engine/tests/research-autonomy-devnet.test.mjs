import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,sign} from 'node:crypto';
import {DevnetPolicyTransport,DEPLOYED_POLICY} from '../lib/research-autonomy-devnet.mjs';
import {DEVNET,keyString} from '../lib/research-autonomy-policy.mjs';
const key=n=>keyString(Buffer.alloc(32,n));
function fixture(){
 const pair=generateKeyPairSync('ed25519'),address=keyString(pair.publicKey.export({type:'spki',format:'der'}).subarray(-32));let signed=0,sends=0;
 const signer={address,signDevnet:async bytes=>{signed++;return sign(null,bytes,pair.privateKey);}};
 const c={schema:'xtxc.autonomy-policy/v1',executionChain:'solana:mainnet',evidenceChain:'solana:devnet',program:DEPLOYED_POLICY,owner:key(21),verifier:address,wallet:key(22),id:'ab'.repeat(32),approvalHash:'cd'.repeat(32),startsAt:'0',expiresAt:'0',buyBudgetAtoms:'3000000',perBuyAtoms:'2000000',maxOrders:'2',mints:[key(23)],maxSlippageBps:20,feeBudgetLamports:null};
 const args={counter:'0',inputAtoms:'2000000',mint:c.mints[0],messageHash:'ef'.repeat(32)};
 const db=new DatabaseSync(':memory:');let row,finalized=false;
 const fetcher=async(url,init)=>{
  assert.equal(url,'https://api.devnet.solana.com');const {method}=JSON.parse(init.body);let result;
  if(method==='getGenesisHash')result=DEVNET;
  else if(method==='getLatestBlockhash')result={value:{blockhash:key(24),lastValidBlockHeight:1000}};
  else if(method==='getSignatureStatuses')result={value:[finalized?{slot:900,confirmationStatus:'finalized',err:null}:null]};
  else if(method==='getTransaction')result={slot:900,transaction:[row.wire,'base64'],meta:{err:null,fee:5000}};
  else if(method==='sendTransaction'){sends++;throw new Error('ambiguous transport timeout');}
  else throw new Error('Unexpected method');return Response.json({jsonrpc:'2.0',id:1,result});
 };
 const transport=new DevnetPolicyTransport(db,signer,fetcher);
 return{db,c,args,transport,signer,fetcher,counts:()=>({signed,sends}),finalize:r=>{row=r;finalized=true;}};
}
test('reservation idempotency never signs a changed or duplicate request',async()=>{const x=fixture();try{const r=await x.transport.create(x.c,'RESERVE',x.args);assert.equal((await x.transport.create(x.c,'RESERVE',x.args)).wire,r.wire);assert.equal(x.counts().signed,1);await assert.rejects(x.transport.create(x.c,'RESERVE',{...x.args,inputAtoms:'1'}),/DEVNET_REQUEST_CHANGED/);}finally{x.db.close();}});
test('ambiguous transport persists same wire across adapter restart and receipt reconciliation',async()=>{const x=fixture();try{let r=await x.transport.create(x.c,'RESERVE',x.args);r=await x.transport.submit(r.id);assert.equal(r.phase,'UNKNOWN');const resumed=new DevnetPolicyTransport(x.db,x.signer,x.fetcher);assert.equal((await resumed.create(x.c,'RESERVE',x.args)).wire,r.wire);await resumed.submit(r.id);assert.deepEqual(x.counts(),{signed:1,sends:1});x.finalize(r);assert.equal((await resumed.status(r.id)).phase,'FINALIZED');assert.equal(x.counts().signed,1);}finally{x.db.close();}});
test('wrong actor, untyped call and missing mainnet receipt are rejected',async()=>{const x=fixture();try{await assert.rejects(x.transport.create({...x.c,verifier:key(99)},'RESERVE',x.args),/VERIFIER_SCOPE/);await assert.rejects(x.transport.create(x.c,'APPROVE',x.args),/VERIFIER_SCOPE/);await assert.rejects(x.transport.settle(x.c,{phase:'UNKNOWN'}),/MAINNET_RECEIPT_REQUIRED/);assert.equal(x.counts().signed,0);}finally{x.db.close();}});
test('oversized send response is stopped during streaming',async()=>{const x=fixture();try{const t=new DevnetPolicyTransport(x.db,x.signer,async()=>new Response('x'.repeat(32000)));await assert.rejects(t.call('sendTransaction',[]),/DEVNET_SEND_OVERSIZED/);}finally{x.db.close();}});
