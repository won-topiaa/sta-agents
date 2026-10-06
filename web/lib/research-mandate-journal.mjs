// Durable *unsigned-first* execution boundary. The caller supplies a fresh,
// trusted chain observation and a StockMesh-lowered graph. This module has no
// wallet key, RPC endpoint, LLM call, autonomous schedule or enabled transport.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {getAddressEncoder,getTransactionDecoder,getTransactionEncoder,getBase58Decoder} from '@solana/kit';
import {decodeObservedMandate,tradeInstruction,unsignedMandateTransaction,validateMandate} from './research-mandate.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
export class MandateJournal {
 constructor(db){
  this.db=db;
  this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS bounded_mandate_orders (
    mandate TEXT NOT NULL, counter TEXT NOT NULL, owner TEXT NOT NULL,
    phase TEXT NOT NULL, config_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
    document TEXT NOT NULL, PRIMARY KEY(mandate,counter));
   CREATE TABLE IF NOT EXISTS bounded_mandate_unsigned_history (
    id INTEGER PRIMARY KEY, mandate TEXT NOT NULL, counter TEXT NOT NULL, document TEXT NOT NULL);`);
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 get(mandate,counter){const r=this.db.prepare('SELECT * FROM bounded_mandate_orders WHERE mandate=? AND counter=?').get(mandate,String(counter));return r?{...JSON.parse(r.document),phase:r.phase}:null;}
 async prepare(config,observation,settlement,lifetime,now=Date.now()){
  validateMandate(config);
  if(!Number.isSafeInteger(observation.observedAt)||now-observation.observedAt>15000||observation.observedAt>now+1000)throw new Error('Refresh finalized mandate state.');
  const state=await decodeObservedMandate(config,observation,Math.floor(now/1000));
  // BUY_LIMIT still permits SELL/risk reduction. The program applies side-specific caps.
  if(!['ACTIVE','BUY_LIMIT'].includes(state.phase))throw new Error('Mandate is not trading-enabled.');
  const requestHash=sha(canonical({config,settlement:{...settlement,data:Buffer.from(settlement.data).toString('hex')}}));
  const configHash=sha(canonical(config));
  // One prepare per mandate nonce, including across processes and restarts.
  // A changed quote cannot replace an unresolved signed transaction.
  const existing=this.get(state.state,state.tradeCount);
  if(existing&&existing.phase!=='EXPIRED_UNSIGNED'){if(existing.requestHash!==requestHash)throw new Error('Resolve the existing mandate order before changing its route.');return existing;}
  const wrapped=await tradeInstruction(config,settlement,state.tradeCount);
  const prepared=unsignedMandateTransaction(config.executor,[wrapped],lifetime);
  if(prepared.requiredSigners.length!==1||prepared.requiredSigners[0]!==config.executor)throw new Error('Unexpected mandate signer.');
  const doc={mandate:state.state,counter:state.tradeCount,owner:config.owner,executor:config.executor,
   approvalHash:config.approvalHash,configHash,requestHash,prepared,lifetime,
   observedSlot:state.observedSlot,createdAt:now,signature:null,signedTransactionBase64:null};
  return this.transaction(()=>{
   const same=this.get(state.state,state.tradeCount);if(same&&same.phase!=='EXPIRED_UNSIGNED'){if(same.requestHash!==requestHash)throw new Error('Concurrent preparation changed the route.');return same;}
   const unresolved=this.db.prepare("SELECT counter FROM bounded_mandate_orders WHERE mandate=? AND phase NOT IN ('RECONCILED','FAILED_FINALIZED','EXPIRED_UNSIGNED') LIMIT 1").get(state.state);
   if(unresolved)throw new Error('A previous mandate order still needs reconciliation.');
   if(same){
    if(same.signature||same.configHash!==configHash)throw new Error('Cannot replace a signed or changed mandate.');
    this.db.prepare('INSERT INTO bounded_mandate_unsigned_history(mandate,counter,document) VALUES(?,?,?)').run(state.state,state.tradeCount,JSON.stringify(same));
    this.db.prepare("UPDATE bounded_mandate_orders SET phase='PREPARED',request_hash=?,document=? WHERE mandate=? AND counter=? AND phase='EXPIRED_UNSIGNED'").run(requestHash,JSON.stringify(doc),state.state,state.tradeCount);
   }else this.db.prepare('INSERT INTO bounded_mandate_orders VALUES(?,?,?,?,?,?,?)').run(state.state,state.tradeCount,config.owner,'PREPARED',configHash,requestHash,JSON.stringify(doc));
   return{...doc,phase:'PREPARED'};
  });
 }
 acceptExecutorSignature(mandate,counter,base64){
  if(typeof base64!=='string'||base64.length>1644)throw new Error('Invalid signed mandate wire.');
  return this.transaction(()=>{
   const row=this.get(mandate,counter);if(!row)throw new Error('Order is not prepared.');
   if(row.signedTransactionBase64){if(row.signedTransactionBase64!==base64)throw new Error('Never replace an unresolved signed message.');return row;}
   if(row.phase!=='PREPARED')throw new Error('Order cannot be signed in this phase.');
   const wire=Buffer.from(base64,'base64');if(wire.toString('base64')!==base64||wire.length>1232)throw new Error('Invalid signed mandate wire.');
   const tx=getTransactionDecoder().decode(wire),expected=getTransactionDecoder().decode(Buffer.from(row.prepared.transactionBase64,'base64'));
   if(!Buffer.from(tx.messageBytes).equals(Buffer.from(expected.messageBytes))||Buffer.from(getTransactionEncoder().encode(tx)).toString('base64')!==base64)throw new Error('Executor changed the prepared transaction.');
   const signatures=Object.entries(tx.signatures);if(signatures.length!==1||signatures[0][0]!==row.executor||!signatures[0][1])throw new Error('Only the bounded executor may sign this wire.');
   const sig=Buffer.from(signatures[0][1]),key=createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(getAddressEncoder().encode(row.executor))])});
   if(!verify(null,Buffer.from(tx.messageBytes),key,sig))throw new Error('Invalid executor signature.');
   const doc={...row,signature:getBase58Decoder().decode(sig),signedTransactionBase64:base64};
   this.db.prepare("UPDATE bounded_mandate_orders SET phase='SIGNED',document=? WHERE mandate=? AND counter=? AND phase='PREPARED'").run(JSON.stringify(doc),mandate,String(counter));
   return{...doc,phase:'SIGNED'};
  });
 }
 // Invoke only from a separately enabled operator adapter. The persisted wire
 // is passed verbatim; timeout or crash remains UNKNOWN. No resigner/requote.
 async relayExact(mandate,counter,transport){
  const row=this.transaction(()=>{const r=this.get(mandate,counter);if(!r||!['SIGNED','UNKNOWN'].includes(r.phase)||!r.signature)throw new Error('No exact signed transaction to relay.');this.db.prepare("UPDATE bounded_mandate_orders SET phase='UNKNOWN' WHERE mandate=? AND counter=?").run(mandate,String(counter));return r;});
  const returned=await transport(row.signedTransactionBase64);
  if(returned!==row.signature)throw new Error('Submission returned an unexpected signature; outcome remains unknown.');
  // RPC acknowledgement is not finalization or a token receipt.
  return this.get(mandate,counter);
 }
 expireUnsigned(mandate,counter,observedFinalizedBlockHeight){
  return this.transaction(()=>{const row=this.get(mandate,counter);if(!row||row.phase!=='PREPARED'||row.signature||!Number.isSafeInteger(observedFinalizedBlockHeight)||BigInt(observedFinalizedBlockHeight)<=BigInt(row.lifetime.lastValidBlockHeight))throw new Error('Only demonstrably expired unsigned orders can be released.');
   this.db.prepare("UPDATE bounded_mandate_orders SET phase='EXPIRED_UNSIGNED' WHERE mandate=? AND counter=?").run(mandate,String(counter));return this.get(mandate,counter);});
 }
 // No generic public `mark complete` method. Reconciliation must be wired to
 // the existing exact-message mainnet receipt/holdings verifier before enabling
 // a recurring runner. UNKNOWN and SIGNED are deliberately never timed out here.
}
