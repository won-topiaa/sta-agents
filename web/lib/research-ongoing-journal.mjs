import {canonical,hash,integer,requirePolicy as need,verifyExactSignature} from './research-autonomy-policy.mjs';
import {validateOperatingMandate,verifyOperatingSignature,mandateActive} from './research-ongoing-policy.mjs';

export const settledPhase = phase=>['RECONCILED','FAILED_FINALIZED','EXPIRED_NO_FILL','EXPIRED_UNSIGNED'].includes(phase);
export class OngoingJournal {
  constructor(db) {
    this.db=db;
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS ongoing_mandates(id TEXT PRIMARY KEY,owner TEXT NOT NULL,wallet TEXT NOT NULL,phase TEXT NOT NULL,config TEXT NOT NULL,config_hash TEXT NOT NULL,document TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS ongoing_wallet_authority ON ongoing_mandates(wallet) WHERE phase IN ('ACTIVE','PAUSED','RISK_EXIT');
      CREATE TABLE IF NOT EXISTS ongoing_execution_orders(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,mandate TEXT NOT NULL,wallet TEXT NOT NULL,counter TEXT NOT NULL,phase TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(mandate,counter));
      CREATE UNIQUE INDEX IF NOT EXISTS ongoing_wallet_pending ON ongoing_execution_orders(wallet) WHERE phase NOT IN ('RECONCILED','FAILED_FINALIZED','EXPIRED_NO_FILL','EXPIRED_UNSIGNED');
      CREATE TABLE IF NOT EXISTS ongoing_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,mandate TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  transaction(fn) {
    need(!this.db.isTransaction, 'NESTED_OPERATING_TRANSACTION');
    this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  event(id,kind,doc) {this.db.prepare('INSERT INTO ongoing_events(mandate,kind,document,created_at) VALUES(?,?,?,?)').run(id,kind,JSON.stringify(doc),Date.now());}
  row(id,owner=null) {
    const r=this.db.prepare('SELECT * FROM ongoing_mandates WHERE id=?').get(id);
    need(r && (owner===null||r.owner===owner), 'OPERATING_MANDATE_NOT_FOUND');
    return {...JSON.parse(r.document),config:JSON.parse(r.config),phase:r.phase};
  }
  save(r,phase=r.phase) {this.db.prepare('UPDATE ongoing_mandates SET phase=?,document=? WHERE id=?').run(phase,JSON.stringify({...r,phase}),r.config.id);return {...r,phase};}
  draft(config,binding) {
    validateOperatingMandate(config);const h=hash(canonical(config));
    need(binding.owner===config.owner && binding.address===config.wallet, 'WALLET_BINDING_CHANGED');
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT config_hash FROM ongoing_mandates WHERE id=?').get(config.id);
      if(old){need(old.config_hash===h, 'MANDATE_CHANGED');return this.row(config.id,config.owner);}
      const doc={config,binding:{...binding,schema:'xtxc.privy-binding/v1',configId:config.id,configHash:h,enabled:false},
        approvalSignature:null,usage:{buyReservedAtoms:'0',feeReservedLamports:'0',orders:'0'},risk:null,nextAt:0,createdAt:Date.now()};
      this.db.prepare('INSERT INTO ongoing_mandates VALUES(?,?,?,?,?,?,?)').run(config.id,config.owner,config.wallet,'DRAFT',canonical(config),h,JSON.stringify(doc));
      this.event(config.id,'DRAFT',{});return this.row(config.id,config.owner);
    });
  }
  activate(id,owner,signature,binding) {
    return this.transaction(()=>{
      const r=this.row(id,owner),identity=verifyOperatingSignature(r.config,signature);
      need(mandateActive(r.config), 'MANDATE_EXPIRED');
      need(binding.walletId===r.binding.walletId && binding.address===r.config.wallet && binding.owner===owner &&
        binding.providerPolicyHash===r.binding.providerPolicyHash && binding.signerId===r.binding.signerId &&
        binding.authorizationKeyHash===r.binding.authorizationKeyHash && binding.policyId===r.binding.policyId, 'WALLET_BINDING_CHANGED');
      if(r.approvalSignature){need(r.approvalSignature===signature && !['REVOKED','EXPIRED'].includes(r.phase), 'MANDATE_ALREADY_CONSUMED');return r;}
      need(r.phase==='DRAFT', 'INVALID_ACTIVATION_PHASE');
      if(this.db.prepare("SELECT name FROM sqlite_master WHERE name='autonomy_bindings'").get()) {
        const legacy=this.db.prepare("SELECT document FROM autonomy_bindings WHERE phase IN ('RUNNING','ATTENTION')").all();
        need(!legacy.some(b=>JSON.parse(b.document).config.wallet===r.config.wallet),'LEGACY_AUTHORITY_STILL_RUNNING');
      }
      need(!this.legacyPending(r.config.wallet),'ORDER_UNRESOLVED');
      const same=this.db.prepare("SELECT id FROM ongoing_mandates WHERE wallet=? AND phase IN ('ACTIVE','PAUSED','RISK_EXIT')").get(r.config.wallet);
      need(!same, 'WALLET_ALREADY_MANAGED');
      this.event(id,'OWNER_AUTHORIZED',{identity});
      return this.save({...r,approvalSignature:signature,authorityHash:identity,binding:{...r.binding,enabled:true},activatedAt:Date.now()},'ACTIVE');
    });
  }
  assertActive(id,side=null) {
    const r=this.row(id);
    need(['ACTIVE','RISK_EXIT'].includes(r.phase) && r.binding.enabled && r.approvalSignature, 'MANDATE_INACTIVE');
    verifyOperatingSignature(r.config,r.approvalSignature);
    need(mandateActive(r.config), 'MANDATE_EXPIRED');
    need(side!=='BUY'||!r.risk?.latched, 'RISK_REDUCTION_ONLY');return r;
  }
  orders(id) {return this.db.prepare('SELECT * FROM ongoing_execution_orders WHERE mandate=? ORDER BY sequence').all(id).map(r=>({...JSON.parse(r.document),sequence:r.sequence,phase:r.phase}));}
  order(id) {const r=this.db.prepare('SELECT * FROM ongoing_execution_orders WHERE id=?').get(id);need(r,'OPERATING_ORDER_NOT_FOUND');return {...JSON.parse(r.document),sequence:r.sequence,phase:r.phase};}
  put(r,phase) {this.db.prepare('UPDATE ongoing_execution_orders SET phase=?,document=? WHERE id=?').run(phase,JSON.stringify({...r,phase}),r.id);return {...r,phase};}
  legacyPending(wallet) {
    const exists=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='autonomy_orders'").get();
    return exists && !!this.db.prepare(`SELECT id FROM autonomy_orders WHERE wallet=? AND
      (phase NOT IN ('RECONCILED','FAILED_FINALIZED','EXPIRED_UNSIGNED','EXPIRED_NO_FILL') OR
       (phase IN ('RECONCILED','FAILED_FINALIZED') AND json_extract(document,'$.engineReconciled') IS NULL)) LIMIT 1`).get(wallet);
  }
  legacyReserved(wallet) {
    if(!this.db.prepare("SELECT name FROM sqlite_master WHERE name='autonomy_bindings'").get())return 0n;
    let reserved=0n;
    for(const b of this.db.prepare("SELECT id,document FROM autonomy_bindings WHERE phase IN ('RUNNING','ATTENTION')").all()) {
      const d=JSON.parse(b.document);if(d.config.wallet!==wallet)continue;
      const rows=this.db.prepare('SELECT counter,phase FROM autonomy_orders WHERE policy=?').all(b.id);
      for(const [i,l] of d.approval.legs.entries()) {
        const order=rows.find(x=>Number(x.counter)===i);
        if(l.side==='BUY' && (!order||!settledPhase(order.phase)))reserved+=integer(l.inputAtoms);
      }
      reserved+=integer(d.approval.plan.cashAtoms);
    }
    return reserved;
  }
  stage(id,decision,prepared,facts) {
    return this.transaction(()=>{
      const r=this.assertActive(id,decision.leg.side),c=r.config,l=decision.leg;
      need(!this.legacyPending(c.wallet) && !this.db.prepare("SELECT id FROM ongoing_execution_orders WHERE wallet=? AND phase NOT IN ('RECONCILED','FAILED_FINALIZED','EXPIRED_NO_FILL','EXPIRED_UNSIGNED')").get(c.wallet), 'ORDER_UNRESOLVED');
      need(integer(l.inputAtoms)>0n && facts.side===l.side && facts.mint===l.mint && facts.inputAtoms===l.inputAtoms && c.assets.some(a=>a.mint===l.mint && a.instrument===l.instrument), 'ORDER_OUTSIDE_MANDATE');
      need(prepared.owner===c.wallet && prepared.submitAllowed===true && prepared.transactionBase64 && prepared.preparedId && prepared.quoteId && Date.parse(prepared.expiresAt)>Date.now()+4000, 'INVALID_PREPARED_ORDER');
      const usage={...r.usage,orders:String(integer(r.usage.orders)+1n),feeReservedLamports:String(integer(r.usage.feeReservedLamports)+integer(facts.networkFeeLamports))};
      need(integer(usage.orders)<=integer(c.maxOrders), 'ORDER_LIMIT');
      if(!r.risk?.latched)need(integer(usage.orders)+BigInt(c.assets.length)<=integer(c.maxOrders),'RISK_EXIT_ORDER_RESERVE');
      if(c.feeBudgetLamports!==null)need(integer(usage.feeReservedLamports)<=integer(c.feeBudgetLamports), 'FEE_BUDGET_EXHAUSTED');
      if(l.side==='BUY') {
        need(integer(l.inputAtoms)>0n && integer(l.inputAtoms)<=integer(c.perBuyAtoms), 'PER_ORDER_LIMIT');
        usage.buyReservedAtoms=String(integer(usage.buyReservedAtoms)+integer(l.inputAtoms));
        need(integer(usage.buyReservedAtoms)<=integer(c.buyTurnoverAtoms), 'BUY_TURNOVER_EXHAUSTED');
      }
      const orderId=hash(canonical({mandate:id,counter:r.usage.orders,messageHash:facts.messageHash}));
      const doc={id:orderId,mandate:id,wallet:c.wallet,counter:r.usage.orders,decision,prepared,facts,signature:null,signedTransactionBase64:null,relayAttempts:0,createdAt:Date.now()};
      this.db.prepare('INSERT INTO ongoing_execution_orders(id,mandate,wallet,counter,phase,document) VALUES(?,?,?,?,?,?)').run(orderId,id,c.wallet,r.usage.orders,'PREPARED',JSON.stringify(doc));
      this.save({...r,usage});this.event(id,'ORDER_RESERVED',{orderId,side:l.side,inputAtoms:l.inputAtoms});return this.order(orderId);
    });
  }
  beginSigning(id) {return this.transaction(()=>{const r=this.order(id);this.assertActive(r.mandate,r.facts.side);need(r.phase==='PREPARED','SIGNING_ALREADY_ATTEMPTED');return this.put(r,'SIGNING');});}
  signed(id,wire) {return this.transaction(()=>{const r=this.order(id);need(r.phase==='SIGNING','SIGNING_ALREADY_ATTEMPTED');const signature=verifyExactSignature(r.prepared.transactionBase64,wire,r.wallet);this.event(r.mandate,'SIGNED',{orderId:id,signature});return this.put({...r,signature,signedTransactionBase64:wire},'SIGNED');});}
  signingUnknown(id) {return this.transaction(()=>{const r=this.order(id);return r.phase==='SIGNING'?this.put(r,'SIGNING_UNKNOWN'):r;});}
  beginRelay(id) {return this.transaction(()=>{const r=this.order(id);this.assertActive(r.mandate,r.facts.side);need(['SIGNED','UNKNOWN'].includes(r.phase)&&r.signature&&r.relayAttempts<3,'RELAY_NOT_ALLOWED');return this.put({...r,relayAttempts:r.relayAttempts+1,lastRelayAt:Date.now()},'UNKNOWN');});}
  receipt(id,receipt) {return this.transaction(()=>{const r=this.order(id);need(['SIGNED','UNKNOWN','RECEIPT_PENDING'].includes(r.phase)&&receipt.signature===r.signature&&receipt.messageHash===r.facts.messageHash,'INVALID_RECEIPT');if(r.receipt)need(canonical(r.receipt)===canonical(receipt),'RECEIPT_CHANGED');return this.put({...r,receipt},'RECEIPT_PENDING');});}
  reconciled(id,engine) {return this.transaction(()=>{const r=this.order(id);need(r.phase==='RECEIPT_PENDING'&&r.receipt,'MISSING_RECEIPT');const phase=r.receipt.phase;
    need(engine?.signature===r.signature && (phase==='RECONCILED'?engine.phase==='RECONCILED'&&engine.receiptVerified===true:engine.phase==='FAILED'), 'STOCKMESH_RECONCILIATION_PENDING');
    this.event(r.mandate,'SETTLEMENT_VERIFIED',{orderId:id,receipt:r.receipt});return this.put({...r,engineReconciled:true},phase);});}
  expiredSigned(id,proof) {return this.transaction(()=>{const r=this.order(id);need(['SIGNED','UNKNOWN'].includes(r.phase)&&proof?.schema==='xtxc.signed-expiry/v1'&&proof.phase==='EXPIRED_NO_FILL'&&proof.signature===r.signature&&proof.messageHash===r.facts.messageHash&&proof.blockhashExpired===true&&proof.historyAbsent===true&&Number.isSafeInteger(proof.slot)&&BigInt(proof.slot)>integer(r.facts.deadlineSlot)&&proof.reason==='FINALIZED_UNCHANGED_STOCKMESH_NONCE','SIGNED_EXPIRY_NOT_PROVEN');return this.put({...r,receipt:proof,engineReconciled:true},'EXPIRED_NO_FILL');});}
  expireUnsigned(id) {return this.transaction(()=>{const r=this.order(id);need(r.phase==='PREPARED'&&!r.signature&&Date.parse(r.prepared.expiresAt)<=Date.now(),'UNSIGNED_EXPIRY_NOT_PROVEN');return this.put(r,'EXPIRED_UNSIGNED');});}
  stop(owner,id,revoke=false) {return this.transaction(()=>{const r=this.row(id,owner);need(r.phase!=='DRAFT'||revoke,'MANDATE_NOT_AUTHORIZED');if(['REVOKED','EXPIRED'].includes(r.phase))return r;this.event(id,revoke?'REVOKED':'PAUSED',{});return this.save({...r,binding:{...r.binding,enabled:false}},revoke?'REVOKED':'PAUSED');});}
  resume(owner,id) {return this.transaction(()=>{const r=this.row(id,owner);need(r.phase==='PAUSED'&&mandateActive(r.config)&&r.approvalSignature,'MANDATE_NOT_RESUMABLE');verifyOperatingSignature(r.config,r.approvalSignature);return this.save({...r,binding:{...r.binding,enabled:true}},r.risk?.latched?'RISK_EXIT':'ACTIVE');});}
}
