import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { address, appendTransactionMessageInstruction, compileTransaction, createTransactionMessage,
  getAddressEncoder, getBase58Decoder, getTransactionDecoder, getTransactionEncoder,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import { reject } from './research-agent-core.mjs';

export const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MEMO_PROGRAM='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// Explicit constant, not a configurable program or customer-supplied transaction.
const MEMO=MEMO_PROGRAM;
const DOMAIN='xtxc:research-approval:v1:';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function anchorCanonical(value){
  if(value===null||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='string')return JSON.stringify(value.normalize('NFC'));
  if(typeof value==='number'){if(!Number.isSafeInteger(value))reject('Anchor numbers must be safe integers.');return String(value);}
  if(Array.isArray(value))return '['+value.map(anchorCanonical).join(',')+']';
  if(value&&typeof value==='object'){
    const keys=Object.keys(value).sort();if(keys.some(k=>k!==k.normalize('NFC')))reject('Invalid anchor key.');
    return '{'+keys.map(k=>JSON.stringify(k)+':'+anchorCanonical(value[k])).join(',')+'}';
  }
  reject('Invalid approval record.');
}
export function approvalCommitment(plan,salt){
  if(!/^[a-f0-9]{64}$/.test(salt))reject('Invalid approval nonce.');
  const {status,steps,...document}=plan;
  return sha(DOMAIN+anchorCanonical({document,nonce:salt}));
}
export function buildApprovalWire(owner,commitment,lifetime){
  if(!/^[a-f0-9]{64}$/.test(commitment))reject('Invalid approval hash.');
  const payer=address(owner);
  let message=createTransactionMessage({version:'legacy'});
  message=setTransactionMessageFeePayer(payer,message);
  message=setTransactionMessageLifetimeUsingBlockhash({blockhash:lifetime.blockhash,lastValidBlockHeight:BigInt(lifetime.lastValidBlockHeight)},message);
  message=appendTransactionMessageInstruction({programAddress:address(MEMO),accounts:[{address:payer,role:3}],data:new TextEncoder().encode(DOMAIN+commitment)},message);
  const tx=compileTransaction(message);
  return {transactionBase64:Buffer.from(getTransactionEncoder().encode(tx)).toString('base64'),messageBase64:Buffer.from(tx.messageBytes).toString('base64')};
}
export function verifyApprovalWire(prepared,base64){
  if(typeof base64!=='string'||base64.length>1644||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))reject('Invalid approval transaction.');
  const wire=Buffer.from(base64,'base64');
  if(wire.length>1232||wire.toString('base64')!==base64)reject('Invalid approval transaction.');
  let tx;try{tx=getTransactionDecoder().decode(wire);}catch{reject('Invalid approval transaction.');}
  const expected=getTransactionDecoder().decode(Buffer.from(prepared.transactionBase64,'base64'));
  if(!Buffer.from(tx.messageBytes).equals(Buffer.from(expected.messageBytes))||Buffer.from(getTransactionEncoder().encode(tx)).toString('base64')!==base64)reject('The wallet changed the approval record. Nothing was sent.');
  const entries=Object.entries(tx.signatures);
  if(entries.length!==1||entries[0][0]!==prepared.owner||!entries[0][1])reject('The approval must be signed by its owner.');
  const sig=Buffer.from(entries[0][1]);
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(getAddressEncoder().encode(address(prepared.owner)))]),format:'der',type:'spki'});
  if(sig.length!==64||!verify(null,Buffer.from(tx.messageBytes),key,sig))reject('The approval signature is invalid.');
  return getBase58Decoder().decode(sig);
}
export function verifyAnchorReceipt(row,tx,status){
  if(!tx||!status||!['confirmed','finalized'].includes(status.confirmationStatus))return null;
  if(status.err!==null||!tx.meta||tx.meta.err!==null)reject('The devnet approval transaction failed.',409);
  if(!Array.isArray(tx.transaction)||tx.transaction[1]!=='base64'||tx.transaction[0]!==row.signedTransactionBase64||!Number.isSafeInteger(tx.slot)||tx.slot<1||status.slot!==tx.slot)reject('The devnet receipt does not match this approval.',409);
  if(verifyApprovalWire(row,tx.transaction[0])!==row.signature)reject('The recorded approval signature changed.',409);
  if(!Number.isSafeInteger(tx.meta.fee)||tx.meta.fee<0||tx.meta.fee>50000)reject('Unexpected devnet approval fee.',409);
  return {type:'ApprovalAnchorReceipt',cluster:'devnet',genesisHash:DEVNET_GENESIS,commitment:row.commitment,planId:row.planId,signature:row.signature,slot:tx.slot,feeLamports:String(tx.meta.fee),confirmation:status.confirmationStatus,observedAt:new Date().toISOString(),explorerUrl:`https://explorer.solana.com/tx/${row.signature}?cluster=devnet`,transactionHash:sha(Buffer.from(tx.transaction[0],'base64'))};
}
export class DevnetRpc {
  constructor(fetcher=fetch){this.fetcher=fetcher;}
  async call(method,params=[]){
    const allowed=['getGenesisHash','getLatestBlockhash','getFeeForMessage','getBalance','getBlockHeight','getSignatureStatuses','getTransaction','sendTransaction'];
    if(!allowed.includes(method))reject('Unsupported approval RPC.');
    const response=await this.fetcher('https://api.devnet.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(12000),body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if(!response.ok)reject('Devnet is temporarily unavailable. Your trading wallet is unchanged.',503);
    const reader=response.body.getReader();let length=0;const chunks=[];
    try{while(true){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>128000){await reader.cancel();reject('Oversized devnet response.',503);}chunks.push(r.value);}}finally{reader.releaseLock();}
    const body=JSON.parse(Buffer.concat(chunks).toString());if(body.error||body.id!==1||!('result'in body))reject('Devnet could not complete the approval request.',503);return body.result;
  }
  async pin(){if(await this.call('getGenesisHash')!==DEVNET_GENESIS)reject('Approval records require Solana devnet.',503);}
}
export class AnchorService {
  constructor(store,rpc=new DevnetRpc()){
    this.store=store;this.db=store.db;this.rpc=rpc;
    this.db.exec(`CREATE TABLE IF NOT EXISTS research_anchors(id TEXT PRIMARY KEY,owner TEXT NOT NULL,plan_id TEXT NOT NULL,phase TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS anchor_plan ON research_anchors(owner,plan_id,created_at);
      CREATE TABLE IF NOT EXISTS anchor_rate(owner TEXT PRIMARY KEY,window INTEGER NOT NULL,requests INTEGER NOT NULL);`);
  }
  rate(address){const owner=this.store.owner(address),window=Math.floor(Date.now()/60000);this.store.transaction(()=>{const r=this.db.prepare('SELECT * FROM anchor_rate WHERE owner=?').get(owner);if(r?.window===window&&r.requests>=30)reject('Check this record again shortly.',429);this.db.prepare('INSERT INTO anchor_rate VALUES(?,?,1) ON CONFLICT(owner) DO UPDATE SET window=excluded.window,requests=CASE WHEN window=excluded.window THEN requests+1 ELSE 1 END').run(owner,window);});}
  rows(address,planId){this.store.plan(address,planId);return this.db.prepare('SELECT * FROM research_anchors WHERE owner=? AND plan_id=? ORDER BY created_at DESC').all(this.store.owner(address),planId).map(r=>({...JSON.parse(r.document),phase:r.phase}));}
  public(row){const {salt,signedTransactionBase64,messageBase64,...rest}=row;return rest;}
  list(address,planId){return this.rows(address,planId).map(r=>this.public(r));}
  get(address,id){const row=this.db.prepare('SELECT * FROM research_anchors WHERE id=? AND owner=?').get(id,this.store.owner(address));if(!row)reject('Approval record not found.',404);return {...JSON.parse(row.document),phase:row.phase};}
  put(row,phase){const current=this.db.prepare('SELECT phase FROM research_anchors WHERE id=?').get(row.id);if(current?.phase==='FINALIZED'||(current?.phase==='CONFIRMED'&&['UNKNOWN','SUBMITTED','PREPARED'].includes(phase)))return;this.db.prepare('UPDATE research_anchors SET phase=?,document=? WHERE id=?').run(phase,JSON.stringify({...row,phase:undefined}),row.id);}
  async prepare(address,planId){
    this.rate(address);const plan=this.store.plan(address,planId);if(['REVOKED'].includes(plan.status))reject('This plan has been revoked.',409);
    const previous=this.rows(address,planId)[0];if(previous&&!['EXPIRED_UNSENT','FAILED'].includes(previous.phase))return this.public(previous);
    if(this.rows(address,planId).length>=3)reject('This plan reached its approval-record attempt limit.',409);
    await this.rpc.pin();
    const life=(await this.rpc.call('getLatestBlockhash',[{commitment:'confirmed'}])).value;
    if(!Number.isSafeInteger(life.lastValidBlockHeight)||life.lastValidBlockHeight<1)reject('Invalid devnet blockhash.',503);
    const salt=previous?.salt??randomBytes(32).toString('hex'),commitment=approvalCommitment(plan,salt),owner=address.slice(7),wire=buildApprovalWire(owner,commitment,life);
    const [fee,balance]=await Promise.all([this.rpc.call('getFeeForMessage',[wire.messageBase64,{commitment:'confirmed'}]),this.rpc.call('getBalance',[owner,{commitment:'confirmed'}])]);
    if(!Number.isSafeInteger(fee.value)||fee.value<=0||fee.value>50000||!Number.isSafeInteger(balance.value))reject('Devnet fee could not be verified.',503);
    const row={id:randomUUID(),planId,owner,commitment,salt,...wire,cluster:'devnet',genesisHash:DEVNET_GENESIS,lastValidBlockHeight:life.lastValidBlockHeight,createdAt:Date.now(),feeLamports:String(fee.value),balanceLamports:String(balance.value),shortfallLamports:String(Math.max(0,fee.value-balance.value)),attempts:0};
    return this.store.transaction(()=>{if(this.store.plan(address,planId).status==='REVOKED')reject('This plan has been revoked.',409);const rows=this.rows(address,planId),old=rows[0];if(old&&!['EXPIRED_UNSENT','FAILED'].includes(old.phase))return this.public(old);if(rows.length>=3)reject('Approval-record attempt limit reached.',409);this.db.prepare('INSERT INTO research_anchors VALUES(?,?,?,?,?,?)').run(row.id,this.store.owner(address),planId,'PREPARED',JSON.stringify(row),row.createdAt);this.store.event(this.store.owner(address),plan.strategyId,'ANCHOR_PREPARED',{planId,anchorId:row.id});return this.public({...row,phase:'PREPARED'});});
  }
  async submit(address,id,wire){
    this.rate(address);let row=this.get(address,id);const plan=this.store.plan(address,row.planId);
    if(plan.status==='REVOKED')reject('This approval was revoked.',409);
    const signature=verifyApprovalWire(row,wire);if(row.signature&&(signature!==row.signature||wire!==row.signedTransactionBase64))reject('Retry only the same approval transaction.',409);
    if(['CONFIRMED','FINALIZED'].includes(row.phase))return this.public(row);
    if(!['PREPARED','UNKNOWN','SUBMITTED'].includes(row.phase))reject('Check the approval record before signing again.',409);
    await this.rpc.pin();const height=await this.rpc.call('getBlockHeight',[{commitment:'confirmed'}]);
    if(!Number.isSafeInteger(height))reject('Devnet height is unavailable.',503);
    if(height>row.lastValidBlockHeight){if(!row.signature)this.put(row,'EXPIRED_UNSENT');return this.status(address,id,false);}
    this.store.transaction(()=>{row=this.get(address,id);if(this.store.plan(address,row.planId).status==='REVOKED'||!['PREPARED','UNKNOWN','SUBMITTED'].includes(row.phase))reject('This approval is no longer available for submission.',409);if(row.signature&&row.signature!==signature)reject('A different signature is already recorded.',409);if(row.attempts>=3||Date.now()-(row.lastSentAt??0)<10000)reject('Check this approval transaction before retrying.',409);row={...row,signature,signedTransactionBase64:wire,attempts:row.attempts+1,lastSentAt:Date.now()};this.put(row,'UNKNOWN');});
    try{const got=await this.rpc.call('sendTransaction',[wire,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}]);if(got!==signature)reject('Devnet returned a different signature.',503);const latest=this.get(address,id);if(!['CONFIRMED','FINALIZED'].includes(latest.phase))this.put(latest,'SUBMITTED');}catch{/* Persisted signature is the only retry handle. Never replace on timeout. */}
    return this.public(this.get(address,id));
  }
  async status(address,id,rate=true){
    if(rate)this.rate(address);const row=this.get(address,id);if(row.phase==='FINALIZED')return this.public(row);
    await this.rpc.pin();
    if(!row.signature){const height=await this.rpc.call('getBlockHeight',[{commitment:'confirmed'}]);if(height>row.lastValidBlockHeight)this.put(row,'EXPIRED_UNSENT');return this.public(this.get(address,id));}
    const status=(await this.rpc.call('getSignatureStatuses',[[row.signature],{searchTransactionHistory:true}])).value?.[0];
    if(status?.err){this.put({...row,failedAt:Date.now()},'FAILED');return this.public(this.get(address,id));}
    if(status&&['confirmed','finalized'].includes(status.confirmationStatus)){
      const tx=await this.rpc.call('getTransaction',[row.signature,{encoding:'base64',commitment:status.confirmationStatus,maxSupportedTransactionVersion:0}]);const receipt=verifyAnchorReceipt(row,tx,status);
      if(receipt){this.put({...row,receipt},status.confirmationStatus.toUpperCase());const p=this.store.plan(address,row.planId);this.store.event(this.store.owner(address),p.strategyId,'ANCHOR_RECEIPT',{planId:row.planId,receipt});}
    }
    // A missing status is not proof of no execution. Keep UNKNOWN across expiry/reset.
    return this.public(this.get(address,id));
  }
}
