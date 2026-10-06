import {hash,canonical,validatePolicy,allowOrder,integer,requirePolicy as need,verifyExactSignature} from './research-autonomy-policy.mjs';

// Dedicated FULL/WAL database owned only by the signing gate. The research
// worker and the web process must NOT have write access to this file.
export class AutonomyJournal {
 constructor(db){this.db=db;db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS autonomy_policies(id TEXT PRIMARY KEY,wallet TEXT NOT NULL,owner TEXT NOT NULL,phase TEXT NOT NULL,config TEXT NOT NULL,config_hash TEXT NOT NULL,last_count TEXT NOT NULL,last_reserved TEXT NOT NULL,last_slot INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS autonomy_wallet_active ON autonomy_policies(wallet) WHERE phase='ACTIVE';
 CREATE TABLE IF NOT EXISTS autonomy_orders(id TEXT PRIMARY KEY,policy TEXT NOT NULL,counter TEXT NOT NULL,wallet TEXT NOT NULL,phase TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(policy,counter));
 DROP INDEX IF EXISTS autonomy_wallet_pending;
 CREATE UNIQUE INDEX autonomy_wallet_pending ON autonomy_orders(wallet) WHERE phase NOT IN ('RECONCILED','FAILED_FINALIZED','EXPIRED_UNSIGNED');
 CREATE TABLE IF NOT EXISTS autonomy_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,policy TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);`);}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const x=fn();this.db.exec('COMMIT');return x;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 event(policy,kind,document){this.db.prepare('INSERT INTO autonomy_events(policy,kind,document,created_at) VALUES(?,?,?,?)').run(policy,kind,JSON.stringify(document),Date.now());}
 policy(id){const r=this.db.prepare('SELECT * FROM autonomy_policies WHERE id=?').get(id);need(r,'POLICY_NOT_REGISTERED');return{...r,config:JSON.parse(r.config)};}
 order(id){const r=this.db.prepare('SELECT * FROM autonomy_orders WHERE id=?').get(id);need(r,'ORDER_NOT_FOUND');return{...JSON.parse(r.document),phase:r.phase};}
 // Call only after finalized owner-signed initialization, provider wallet
 // ownership and additional-signer consent have independently been checked.
 register(c,observed){validatePolicy(c);const h=hash(canonical(c));return this.transaction(()=>{
  const old=this.db.prepare('SELECT * FROM autonomy_policies WHERE id=?').get(c.id);
  if(old){need(old.config_hash===h,'APPROVAL_CHANGED');return this.policy(c.id);}
  need(observed.active&&!observed.pending&&observed.count==='0'&&observed.reservedAtoms==='0','NEW_POLICY_NOT_EMPTY');
  this.db.prepare('INSERT INTO autonomy_policies VALUES(?,?,?,?,?,?,?,?,?)').run(c.id,c.wallet,c.owner,'ACTIVE',canonical(c),h,'0','0',observed.slot);this.event(c.id,'ACTIVATED',{configHash:h,devnetSlot:observed.slot});return this.policy(c.id);
 });}
 checkObservation(p,s){need(s.slot>=p.last_slot&&integer(s.count)>=integer(p.last_count)&&integer(s.reservedAtoms)>=integer(p.last_reserved),'DEVNET_STATE_REGRESSED');}
 stage(id,s,prepared,facts){return this.transaction(()=>{
  const p=this.policy(id);need(p.phase==='ACTIVE','POLICY_STOPPED');this.checkObservation(p,s);
  need(s.count===p.last_count&&s.reservedAtoms===p.last_reserved,'UNEXPECTED_EXTERNAL_RESERVATION');
  need(!this.db.prepare("SELECT id FROM autonomy_orders WHERE wallet=? AND phase NOT IN ('RECONCILED','FAILED_FINALIZED','EXPIRED_UNSIGNED')").get(p.wallet),'ORDER_UNRESOLVED');
  allowOrder(p.config,s,facts);
  need(prepared.owner===p.wallet&&prepared.submitAllowed===true&&prepared.transactionBase64&&prepared.preparedId&&prepared.quoteId,'PREPARED_TRADE_MISMATCH');
  const orderId=hash(canonical({policy:id,counter:s.count,messageHash:facts.messageHash}));
  const doc={id:orderId,policy:id,counter:s.count,wallet:p.wallet,configHash:p.config_hash,priorReserved:s.reservedAtoms,prepared,facts,signature:null,signedTransactionBase64:null,relayAttempts:0,createdAt:Date.now()};
  this.db.prepare('INSERT INTO autonomy_orders VALUES(?,?,?,?,?,?)').run(orderId,id,s.count,p.wallet,'RESERVING',JSON.stringify(doc));this.event(id,'RESERVING',{orderId,messageHash:facts.messageHash});return this.order(orderId);
 });}
 put(r,phase){const {phase:_,...doc}=r;this.db.prepare('UPDATE autonomy_orders SET phase=?,document=? WHERE id=?').run(phase,JSON.stringify(doc),r.id);return{...doc,phase};}
 assertReservation(p,r,s){this.checkObservation(p,s);need(s.active&&!s.revoked&&s.pending&&integer(s.count)===integer(r.counter)+1n&&integer(s.reservedAtoms)===integer(r.priorReserved)+(r.facts.side==='SELL'?0n:integer(r.facts.inputAtoms))&&s.messageHash===r.facts.messageHash&&s.pendingMint===r.facts.mint&&s.pendingAtoms===r.facts.inputAtoms&&(p.config.schema!=='xtxc.autonomy-policy/v2'||s.pendingSide===r.facts.side),'DEVNET_RESERVATION_MISMATCH');}
 permitted(id,s,devnetSignature){return this.transaction(()=>{const r=this.order(id),p=this.policy(r.policy);need(p.phase==='ACTIVE'&&r.phase==='RESERVING','ORDER_PHASE');this.assertReservation(p,r,s);need(typeof devnetSignature==='string'&&devnetSignature.length>50,'MISSING_POLICY_RECEIPT');this.db.prepare('UPDATE autonomy_policies SET last_count=?,last_reserved=?,last_slot=? WHERE id=?').run(s.count,s.reservedAtoms,s.slot,p.id);this.event(p.id,'PERMITTED',{orderId:id,devnetSignature,slot:s.slot});return this.put({...r,devnetSignature},'PERMITTED');});}
 beginSigning(id,s){return this.transaction(()=>{const r=this.order(id),p=this.policy(r.policy);need(p.phase==='ACTIVE'&&r.phase==='PERMITTED','SIGNING_NOT_ALLOWED');this.assertReservation(p,r,s);this.event(p.id,'SIGNING',{orderId:id});return this.put(r,'SIGNING');});}
 signed(id,wire){return this.transaction(()=>{const r=this.order(id);need(r.phase==='SIGNING','SIGNING_ALREADY_ATTEMPTED');const signature=verifyExactSignature(r.prepared.transactionBase64,wire,r.wallet);this.event(r.policy,'SIGNED',{orderId:id,signature});return this.put({...r,signature,signedTransactionBase64:wire},'SIGNED');});}
 signingUnknown(id){return this.transaction(()=>{const r=this.order(id);if(r.phase!=='SIGNING')return r;this.event(r.policy,'SIGNING_UNKNOWN',{orderId:id});return this.put(r,'SIGNING_UNKNOWN');});}
 expireUnsigned(id,s){return this.transaction(()=>{
  const r=this.order(id),p=this.policy(r.policy);
  need(['RESERVING','PERMITTED'].includes(r.phase)&&!r.signature&&!r.signedTransactionBase64&&Date.parse(r.prepared.expiresAt)<=Date.now(),'UNSIGNED_EXPIRY_NOT_PROVEN');
  this.assertReservation(p,r,s);
  const receipt={schema:'xtxc.unsigned-expiry/v1',phase:'EXPIRED_UNSIGNED',messageHash:r.facts.messageHash,signature:null,reason:'EXPIRED_BEFORE_ANY_SIGNING_ATTEMPT'};
  this.db.prepare('UPDATE autonomy_policies SET last_count=?,last_reserved=?,last_slot=? WHERE id=?').run(s.count,s.reservedAtoms,s.slot,p.id);
  this.event(r.policy,'EXPIRED_UNSIGNED',{orderId:id,receipt});return this.put({...r,receipt,receiptHash:hash(canonical(receipt))},'EXPIRED_UNSIGNED');
 });}
 beginRelay(id,s){return this.transaction(()=>{const r=this.order(id),p=this.policy(r.policy);need(p.phase==='ACTIVE'&&['SIGNED','UNKNOWN'].includes(r.phase)&&r.signedTransactionBase64&&r.relayAttempts<3,'RELAY_NOT_ALLOWED');this.assertReservation(p,r,s);this.event(r.policy,'RELAY',{orderId:id,signature:r.signature,attempt:r.relayAttempts+1});return this.put({...r,relayAttempts:r.relayAttempts+1,lastRelayAt:Date.now()},'UNKNOWN');});}
 // Receipt must first pass verifyMainnetReceipt. Not reachable from a client
 // 'mark success' request. Mainnet finalization precedes devnet attestation.
 recordReceipt(id,receipt){return this.transaction(()=>{const r=this.order(id);need(['UNKNOWN','SIGNED','RECONCILED','FAILED_FINALIZED'].includes(r.phase)&&receipt.signature===r.signature&&receipt.messageHash===r.facts.messageHash&&['RECONCILED','FAILED_FINALIZED'].includes(receipt.phase),'INVALID_RECEIPT');if(r.receipt){need(canonical(r.receipt)===canonical(receipt),'RECEIPT_CHANGED');return r;}this.event(r.policy,receipt.phase,{orderId:id,receipt});return this.put({...r,receipt,receiptHash:hash(canonical(receipt))},receipt.phase);});}
 stop(id,owner){return this.transaction(()=>{const p=this.policy(id);need(p.owner===owner,'NOT_POLICY_OWNER');this.db.prepare("UPDATE autonomy_policies SET phase='STOPPED' WHERE id=?").run(id);this.event(id,'STOPPED',{});return this.policy(id);});}
 rejection(id,request,code){this.policy(id);this.event(id,'REJECTED',{requestHash:hash(canonical(request)),code});return{phase:'REJECTED',reason:code,mainnetSignature:null};}
}
