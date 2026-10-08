import {getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import {canonical,hash,policyInstruction,policyTransaction,verifyExactSignature,requirePolicy as need} from './research-autonomy-policy.mjs';
import {DevnetPolicyReader} from './research-autonomy-rpc.mjs';

export const DEPLOYED_POLICY='3i5oG6xw28CTDHf4q49MRxkr6z3uzvMwhtf9FK5qH4pr';

// Only the devnet verifier's additional authority belongs here. No mainnet
// wallet key, external transaction bytes or arbitrary program call is accepted.
export class DevnetPolicyTransport extends DevnetPolicyReader {
 constructor(db,signer,fetcher=fetch){
  super(fetcher);this.db=db;this.signer=signer;
  db.exec(`PRAGMA busy_timeout=5000;PRAGMA synchronous=FULL;PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS policy_transports(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,phase TEXT NOT NULL,signature TEXT NOT NULL,document TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_sent INTEGER NOT NULL DEFAULT 0);`);
 }
 async call(method,params=[]){
  if(method!=='sendTransaction')return super.call(method,params);
  // Deliberately no configurable endpoint or mainnet send fallback.
  const r=await this.fetcher('https://api.devnet.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(12000),body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  need(r.ok,'DEVNET_SEND_UNAVAILABLE');const reader=r.body?.getReader();need(reader,'DEVNET_SEND_EMPTY');let size=0;const chunks=[];
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;need(size<32000,'DEVNET_SEND_OVERSIZED');chunks.push(part.value);}}finally{await reader.cancel();}
  const b=JSON.parse(Buffer.concat(chunks).toString());need(!b.error&&b.id===1&&typeof b.result==='string','DEVNET_SEND_REJECTED');return b.result;
 }
 row(id){const r=this.db.prepare('SELECT * FROM policy_transports WHERE id=?').get(id);need(r,'DEVNET_TRANSPORT_MISSING');return{...JSON.parse(r.document),id,phase:r.phase,signature:r.signature,attempts:r.attempts,lastSent:r.last_sent};}
 async create(c,operation,args){
  need(c.program===DEPLOYED_POLICY&&c.verifier===this.signer.address&&['RESERVE','SETTLE'].includes(operation),'VERIFIER_SCOPE');
  const requestHash=hash(canonical({c,operation,args})),id=hash(canonical({policy:c.id,operation,messageHash:args.messageHash}));
  const prior=this.db.prepare('SELECT request_hash FROM policy_transports WHERE id=?').get(id);
  if(prior){need(prior.request_hash===requestHash,'DEVNET_REQUEST_CHANGED');return this.row(id);}
  await this.pin();
  const lifetime=(await this.call('getLatestBlockhash',[{commitment:'confirmed'}])).value;
  const prepared=policyTransaction(c.verifier,[await policyInstruction(c,operation,args)],lifetime);
  const tx=getTransactionDecoder().decode(Buffer.from(prepared.transactionBase64,'base64'));
  const signatureBytes=await this.signer.signDevnet(Buffer.from(tx.messageBytes));
  const wire=Buffer.from(getTransactionEncoder().encode({...tx,signatures:{[c.verifier]:signatureBytes}})).toString('base64');
  const signature=verifyExactSignature(prepared.transactionBase64,wire,c.verifier);
  const document={...prepared,wire,operation,policyId:c.id,createdAt:Date.now()};
  this.db.prepare('INSERT OR IGNORE INTO policy_transports(id,request_hash,phase,signature,document) VALUES(?,?,?,?,?)').run(id,requestHash,'SAVED',signature,JSON.stringify(document));
  const got=this.db.prepare('SELECT request_hash FROM policy_transports WHERE id=?').get(id);need(got.request_hash===requestHash,'DEVNET_REQUEST_CHANGED');
  return this.row(id);
 }
 async status(id){
  let r=this.row(id);if(r.phase==='FINALIZED')return r;
  await this.pin();
  const status=(await this.call('getSignatureStatuses',[[r.signature],{searchTransactionHistory:true}])).value?.[0];
  if(status?.confirmationStatus!=='finalized')return r;
  const tx=await this.call('getTransaction',[r.signature,{commitment:'finalized',encoding:'base64',maxSupportedTransactionVersion:0}]);
  need(tx&&tx.transaction?.[1]==='base64'&&tx.transaction[0]===r.wire&&tx.slot===status.slot&&tx.meta&&JSON.stringify(tx.meta.err)===JSON.stringify(status.err),'DEVNET_RECEIPT_MISMATCH');
  const phase=tx.meta.err?'FAILED_FINALIZED':'FINALIZED';
  const document={...r,slot:tx.slot,feeLamports:String(tx.meta.fee),observedAt:Date.now()};
  this.db.prepare('UPDATE policy_transports SET phase=?,document=? WHERE id=?').run(phase,JSON.stringify(document),id);
  return this.row(id);
 }
 async submit(id){
  const r=await this.status(id);if(r.phase==='FINALIZED')return r;need(r.phase!=='FAILED_FINALIZED','DEVNET_TRANSACTION_FAILED');
  // Reserve the attempt before transport; concurrent workers cannot both send.
  const changed=this.db.prepare("UPDATE policy_transports SET phase='UNKNOWN',attempts=attempts+1,last_sent=? WHERE id=? AND phase IN ('SAVED','UNKNOWN') AND attempts<3 AND last_sent<?").run(Date.now(),id,Date.now()-10000);
  if(changed.changes){try{const got=await this.call('sendTransaction',[r.wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}]);need(got===r.signature,'DEVNET_SIGNATURE_MISMATCH');}catch{/* Unknown is durable; never re-sign or replace the blockhash. */}}
  return this.row(id);
 }
 async finish(id){
  // Persisted transport is polled by the scheduler. Never occupy every agent
  // with a 37-second sleep loop while one devnet receipt is finalizing.
  const r=await this.submit(id);if(r.phase==='FINALIZED')return r.signature;
  need(r.phase!=='FAILED_FINALIZED','DEVNET_TRANSACTION_FAILED');
  throw Object.assign(new Error('DEVNET_CONFIRMATION_PENDING'),{code:'DEVNET_CONFIRMATION_PENDING',transportId:id});
 }
 async reserve(c,row){return this.finish((await this.create(c,'RESERVE',{counter:row.counter,inputAtoms:row.facts.inputAtoms,mint:row.facts.mint,side:row.facts.side,messageHash:row.facts.messageHash})).id);}
 async settle(c,row){need(row.receiptHash&&(['RECONCILED','FAILED_FINALIZED'].includes(row.phase)||(row.phase==='EXPIRED_UNSIGNED'&&row.receipt?.schema==='xtxc.unsigned-expiry/v1'&&!row.signature)||(row.phase==='EXPIRED_NO_FILL'&&row.receipt?.schema==='xtxc.signed-expiry/v1'&&row.receipt.signature===row.signature&&row.engineReconciled)),'MAINNET_RECEIPT_REQUIRED');return this.finish((await this.create(c,'SETTLE',{messageHash:row.facts.messageHash,receiptHash:row.receiptHash,phase:row.phase})).id);}
}
