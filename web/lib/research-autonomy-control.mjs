import {randomBytes} from 'node:crypto';
import {hash as planHash} from './research-agent-core.mjs';
import {canonical,hash,integer,keyBytes,validatePolicy,tradeTree,policyAddress,ownerApprovalTransaction,verifyExactSignature,observePolicy,requirePolicy as need} from './research-autonomy-policy.mjs';
import {DEPLOYED_POLICY} from './research-autonomy-devnet.mjs';
import {AutonomyRuntime,normalizeTradeQuote} from './research-autonomy-runtime.mjs';
import {assertStepFunds,atomsDecimal,boundedMap} from './research-rebalance.mjs';

export const decimal=n=>{n=integer(n);return `${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`;};
const terminal=phase=>['RECONCILED','FAILED_FINALIZED','EXPIRED_UNSIGNED','EXPIRED_NO_FILL'].includes(phase);

export function approvedAllocation(owner,input,now=Date.now()){
 keyBytes(owner);
 const {id,status,steps,executionMode,...document}=input??{};
 need(document.schema==='xtxc.research-plan/v1'&&document.owner===`solana:${owner}`&&id===planHash(document),'PLAN_IDENTITY_MISMATCH');
 need(status==='APPROVED'&&document.expiresAt>now&&document.createdAt<=now&&document.budgetAsset==='USDC'&&['NEW_CAPITAL','SELECTED_HOLDINGS_PLUS_NEW_CASH'].includes(document.budgetScope),'CURRENT_APPROVED_PLAN_REQUIRED');
 need(!steps?.length&&Array.isArray(document.legs)&&document.legs.length>0&&document.legs.length<=128,'PLAN_ALREADY_USED_OR_TOO_LARGE');
 need(Array.isArray(document.universe)&&document.universe.length<=64&&document.legs.every(l=>['BUY','SELL'].includes(l.side)&&Number.isSafeInteger(l.inputDecimals)&&l.inputDecimals>=0&&l.inputDecimals<=12&&(l.side==='SELL'||l.inputDecimals===6)&&document.universe.includes(l.instrument)&&/^[A-Z0-9.]{1,32}$/.test(l.instrument)&&integer(l.inputAtoms)>0n),'INVALID_PLAN_LEGS');
 const buys=document.legs.filter(l=>l.side==='BUY'),sales=document.legs.filter(l=>l.side==='SELL'),total=buys.reduce((n,l)=>n+integer(l.inputAtoms),0n);
 if(document.budgetScope==='NEW_CAPITAL')need(sales.length===0&&total+integer(document.cashAtoms)===integer(document.budgetAtoms),'PLAN_BUDGET_MISMATCH');
 else{
  need(document.snapshot?.owner&&Array.isArray(document.snapshot.holdings),'HOLDINGS_OWNER_REQUIRED');
  keyBytes(document.snapshot.owner);integer(document.cashFloorAtoms);
  let seenBuy=false;const sold=new Map();
  for(const l of document.legs){if(l.side==='BUY'){seenBuy=true;continue;}need(!seenBuy,'SELLS_MUST_PRECEDE_BUYS');keyBytes(l.productMint);need(integer(l.minimumCashAtoms)>0n,'INVALID_SELL_MINIMUM');
   const held=document.snapshot.holdings.find(h=>h.mint===l.productMint&&h.instrument===l.instrument&&h.rawDecimals===l.inputDecimals);
   const amount=(sold.get(l.productMint)??0n)+integer(l.inputAtoms);need(held&&amount<=integer(held.atoms),'SELL_EXCEEDS_APPROVED_HOLDINGS');sold.set(l.productMint,amount);
  }
  const proceeds=sales.reduce((n,l)=>n+integer(l.minimumCashAtoms),0n);
  need(total+integer(document.cashAtoms)===integer(document.budgetAtoms)+proceeds,'PLAN_BUDGET_MISMATCH');
 }
 need(Number.isSafeInteger(document.maxSlippageBps)&&document.maxSlippageBps>0&&document.maxSlippageBps<=100,'INVALID_SLIPPAGE');
 return {...document,id};
}

// Control accepts plans, never a client-supplied mainnet transaction or mint.
// Only the owner-signed devnet approval activates an immutable plan binding.
export class AutonomyControl {
 constructor({journal,devnet,mainnet,stockmesh,connection,signer,verifier}){
  Object.assign(this,{journal,db:journal.db,devnet,mainnet,stockmesh,connection,signer,verifier});
  this.db.exec(`CREATE TABLE IF NOT EXISTS autonomy_bindings(id TEXT PRIMARY KEY,owner TEXT NOT NULL,plan_id TEXT UNIQUE NOT NULL,phase TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL);
   DROP INDEX IF EXISTS one_running_owner;`);
  this.busy=new Set();
 }
 row(owner,id){keyBytes(owner);const r=this.db.prepare('SELECT * FROM autonomy_bindings WHERE owner=? AND (id=? OR plan_id=?)').get(owner,id,id);need(r,'APPROVAL_NOT_FOUND');return{...JSON.parse(r.document),phase:r.phase};}
 save(r,phase=r.phase){this.db.prepare('UPDATE autonomy_bindings SET phase=?,document=?,updated_at=? WHERE id=?').run(phase,JSON.stringify({...r,phase}),Date.now(),r.config.id);return{...r,phase};}
 orders(id){return this.db.prepare('SELECT id FROM autonomy_orders WHERE policy=? ORDER BY CAST(counter AS INTEGER)').all(id).map(x=>this.journal.order(x.id));}
 async draft(owner,input){
  const old=this.db.prepare('SELECT id FROM autonomy_bindings WHERE owner=? AND plan_id=?').get(owner,input?.plan?.id);
  if(old)return this.public(this.row(owner,old.id));
  const plan=approvedAllocation(owner,input.plan),binding=await this.connection(owner);
  need(binding.owner===owner&&binding.address!==owner,'WALLET_OWNER_MISMATCH');
  if(plan.snapshot)need(plan.snapshot.owner===binding.address,'REVIEW_AGENT_WALLET_HOLDINGS');
  const legs=await boundedMap(plan.legs,async leg=>{
   const quote=await this.stockmesh.quote({instrument:leg.instrument,side:leg.side,inputAtoms:leg.inputAtoms,productMint:leg.productMint,notional:atomsDecimal(leg.inputAtoms,leg.inputDecimals),notionalAsset:'USDC',maxSlippageBps:plan.maxSlippageBps});
   const mint=leg.side==='SELL'?leg.productMint:quote.exposure?.products?.[0]?.mint;
   normalizeTradeQuote(quote,{...leg,mint,maxSlippageBps:plan.maxSlippageBps});
   return {...leg,mint};
  });
  const expiresAt=input.expiresAt??'0';integer(expiresAt);
  need(expiresAt==='0'||integer(expiresAt)>BigInt(Math.floor(Date.now()/1000)+120),'INVALID_EXPIRY');
  const feeBudgetLamports=input.feeBudgetLamports??null;if(feeBudgetLamports!==null)integer(feeBudgetLamports);
  const id=hash(randomBytes(32)),approval={schema:'xtxc.agent-plan-binding/v1',plan,wallet:binding.address,legs,expiresAt,feeBudgetLamports};
  const trades=legs.map(l=>({side:l.side,mint:l.mint,inputAtoms:l.inputAtoms,minimumCashAtoms:l.minimumCashAtoms??'0'})),buys=legs.filter(l=>l.side==='BUY');
  const config=validatePolicy({schema:'xtxc.autonomy-policy/v2',program:DEPLOYED_POLICY,executionChain:'solana:mainnet',evidenceChain:'solana:devnet',id,approvalHash:hash(canonical(approval)),owner,wallet:binding.address,verifier:this.verifier,startsAt:String(Math.floor(Date.now()/1000)),expiresAt,buyBudgetAtoms:String(buys.reduce((n,l)=>n+integer(l.inputAtoms),0n)),perBuyAtoms:String(buys.reduce((n,l)=>integer(l.inputAtoms)>n?integer(l.inputAtoms):n,0n)),maxOrders:String(legs.length),mints:[...new Set(legs.map(l=>l.mint))],trades,tradeRoot:tradeTree(trades).root,maxSlippageBps:plan.maxSlippageBps,feeBudgetLamports});
  const row={config,approval,binding:{...binding,schema:'xtxc.privy-binding/v1',configId:id,configHash:hash(canonical(config)),enabled:false},preparedApproval:null,approvalTransport:null,createdAt:Date.now()};
  this.db.prepare('INSERT INTO autonomy_bindings VALUES(?,?,?,?,?,?)').run(id,owner,plan.id,'DRAFT',JSON.stringify(row),Date.now());
  return this.public({...row,phase:'DRAFT'});
 }
 async prepareApproval(owner,id){
  let r=this.row(owner,id);need(r.phase==='DRAFT'&&!r.approvalTransport,'APPROVAL_ALREADY_SENT');
  // Refreshing an unsigned approval is safe. Signed approvals are never replaced.
  await this.devnet.pin();const lifetime=(await this.devnet.call('getLatestBlockhash',[{commitment:'confirmed'}])).value;
  const prepared=await ownerApprovalTransaction(r.config,lifetime);
  r=this.row(owner,id);need(r.phase==='DRAFT'&&!r.approvalTransport,'APPROVAL_ALREADY_SENT');
  r=this.save({...r,preparedApproval:prepared});
  return{...this.public(r),preparedApproval:prepared};
 }
 async submitApproval(owner,id,signed){
  let r=this.row(owner,id);need(['DRAFT','APPROVAL_PENDING','READY'].includes(r.phase)&&r.preparedApproval,'APPROVAL_NOT_PREPARED');
  const signature=verifyExactSignature(r.preparedApproval.transactionBase64,signed,owner);
  const transportId=hash(canonical({policy:r.config.id,operation:'OWNER_APPROVE'}));
  if(r.approvalTransport){need(this.devnet.row(transportId).wire===signed,'APPROVAL_CHANGED');return this.public(r);}
  const document={...r.preparedApproval,wire:signed,operation:'OWNER_APPROVE',policyId:r.config.id,createdAt:Date.now()};
  this.journal.transaction(()=>{
   this.db.prepare('INSERT INTO policy_transports(id,request_hash,phase,signature,document) VALUES(?,?,?,?,?)').run(transportId,hash(signed),'SAVED',signature,JSON.stringify(document));
   r=this.save({...r,approvalTransport:transportId},'APPROVAL_PENDING');
  });
  // This endpoint returns after durable save. The bounded worker sends devnet.
  return this.public(r);
 }
 async confirmApproval(r){
  const tx=await this.devnet.submit(r.approvalTransport);
  need(tx.phase!=='FAILED_FINALIZED','DEVNET_APPROVAL_FAILED');
  if(tx.phase!=='FINALIZED')return r;
  const state=await observePolicy(r.config,await this.devnet.observe(r.config));
  need(state.active&&!state.pending&&state.count==='0'&&state.reservedAtoms==='0','APPROVAL_STATE_MISMATCH');
  r=this.row(r.config.owner,r.config.id);if(r.phase!=='APPROVAL_PENDING')return r;
  return this.save({...r,approvalSignature:tx.signature,policyAccount:state.state},'READY');
 }
 async start(owner,id,approvalHash){
  let r=this.row(owner,id);need(r.config.approvalHash===approvalHash,'APPROVAL_CHANGED');
  if(r.phase==='RUNNING')return this.public(r);
  need(r.phase==='READY','OWNER_APPROVAL_REQUIRED');
  const b=await this.connection(owner);need(b.walletId===r.binding.walletId&&b.address===r.config.wallet,'WALLET_BINDING_CHANGED');
  const portfolio=await this.holdings(r);
  need(integer(portfolio.cash.find(c=>c.symbol==='USDC')?.atoms)>=integer(r.approval.plan.budgetScope==='NEW_CAPITAL'?r.config.buyBudgetAtoms:r.approval.plan.budgetAtoms),'AGENT_WALLET_NEEDS_USDC');
  if(r.approval.plan.snapshot)assertStepFunds(r.approval.plan,0,{schema:'skew.stockmesh.portfolio/v1',network:'mainnet-beta',...portfolio},r.config.wallet);
  need(integer(portfolio.cash.find(c=>c.symbol==='SOL')?.atoms)>0n,'AGENT_WALLET_NEEDS_SOL');
  const state=await observePolicy(r.config,await this.devnet.observe(r.config));
  // Re-read after all network calls: a simultaneous STOP must win.
  r=this.row(owner,id);need(r.phase==='READY','POLICY_STOPPED');
  this.journal.transaction(()=>{
   r=this.row(owner,id);need(r.phase==='READY','POLICY_STOPPED');
   const reserve=this.reservedElsewhere(r),cash=integer(portfolio.cash.find(c=>c.symbol==='USDC')?.atoms);
   need(cash>=integer(r.approval.plan.budgetAtoms)+reserve.cash,'AGENT_WALLET_BUDGET_RESERVED');
   const sales=new Map();for(const l of r.approval.legs.filter(l=>l.side==='SELL'))sales.set(l.mint,(sales.get(l.mint)??0n)+integer(l.inputAtoms));
   for(const [mint,atoms] of sales)need(integer(portfolio.holdings.find(h=>h.mint===mint)?.atoms??'0')>=atoms+(reserve.tokens.get(mint)??0n),'AGENT_HOLDINGS_RESERVED');
   need(portfolio.stateSlot>=reserve.lastReceiptSlot,'HOLDINGS_CATCHING_UP');
   this.journal.register(r.config,state);
   this.save({...r,binding:{...r.binding,enabled:true},startedAt:Date.now()},'RUNNING');
  });
  return this.public(this.row(owner,id));
 }
 discardUnsignedDraft(owner,id){
  return this.journal.transaction(()=>{
   const r=this.row(owner,id);
   need((r.phase==='DRAFT'||(r.phase==='STOPPED'&&r.stopReason==='UNSIGNED_DRAFT_SUPERSEDED'))&&!r.approvalTransport&&!r.approvalSignature&&!r.startedAt&&!r.binding.enabled,'PREVIOUS_APPROVAL_HAS_AUTHORITY');
   need(!this.orders(r.config.id).length&&!this.db.prepare('SELECT id FROM autonomy_policies WHERE id=?').get(r.config.id)&&!this.db.prepare("SELECT id FROM policy_transports WHERE json_extract(document,'$.policyId')=?").get(r.config.id),'PREVIOUS_APPROVAL_HAS_AUTHORITY');
   this.save({...r,stopReason:'UNSIGNED_DRAFT_SUPERSEDED',stoppedAt:r.stoppedAt??Date.now()},'STOPPED');
   return{id:r.config.id,planId:r.approval.plan.id,phase:'STOPPED',reason:'UNSIGNED_DRAFT_SUPERSEDED'};
  });
 }
 stop(owner,id){let r=this.row(owner,id);if(this.db.prepare('SELECT id FROM autonomy_policies WHERE id=?').get(r.config.id))this.journal.stop(r.config.id,owner);r=this.save({...r,stoppedAt:Date.now()},'STOPPED');return this.public(r);}
 async holdings(r){
  const p=await this.stockmesh.portfolio(r.config.wallet);
  need(p.schema==='skew.stockmesh.portfolio/v1'&&p.network==='mainnet-beta'&&p.owner===r.config.wallet&&Number.isSafeInteger(p.stateSlot)&&p.stateSlot>0&&Date.now()-Date.parse(p.observedAt)<=30000&&Date.parse(p.observedAt)<=Date.now()+3000&&Array.isArray(p.cash)&&Array.isArray(p.holdings),'HOLDINGS_UNAVAILABLE');
  for(const c of p.cash)integer(c.atoms);
  return{owner:p.owner,cash:p.cash,holdings:p.holdings,observedAt:p.observedAt,stateSlot:p.stateSlot};
 }
 reservedElsewhere(r){
  let cash=0n,lastReceiptSlot=0;const tokens=new Map();
  for(const row of this.db.prepare('SELECT id,owner FROM autonomy_bindings WHERE id<>?').all(r.config.id)){
   const other=this.row(row.owner,row.id);if(other.config.wallet!==r.config.wallet)continue;
   const orders=this.orders(row.id);
   for(const o of orders)lastReceiptSlot=Math.max(lastReceiptSlot,o.receipt?.slot??0);
   for(let index=0;index<other.approval.legs.length;index++){
    const leg=other.approval.legs[index],o=orders.find(o=>Number(o.counter)===index);
    if(o?terminal(o.phase):other.phase!=='RUNNING')continue;
    if(leg.side==='BUY')cash+=integer(leg.inputAtoms);else tokens.set(leg.mint,(tokens.get(leg.mint)??0n)+integer(leg.inputAtoms));
   }
   if(other.phase==='RUNNING')cash+=integer(other.approval.plan.cashAtoms);
  }
  return{cash,tokens,lastReceiptSlot};
 }
 walletPending(r){return this.db.prepare("SELECT policy,phase,document FROM autonomy_orders WHERE wallet=?").all(r.config.wallet).some(o=>o.policy!==r.config.id&&(!terminal(o.phase)||!JSON.parse(o.document).engineReconciled));}
 public(r){return{schema:'xtxc.agent-execution/v1',id:r.config.id,planId:r.approval.plan.id,phase:r.phase,wallet:r.config.wallet,approvalHash:r.config.approvalHash,config:r.config,legs:r.approval.legs,approvalSignature:r.approvalSignature??(r.approvalTransport?this.devnet.row(r.approvalTransport).signature:null),policyAccount:r.policyAccount??null,error:r.error??null,orders:this.orders(r.config.id).map(o=>({id:o.id,index:Number(o.counter),phase:o.phase,instrument:o.facts.instrument,mint:o.facts.mint,inputAtoms:o.facts.inputAtoms,signature:o.signature,devnetSignature:o.devnetSignature??null,settlementSignature:o.settlementSignature??null,receipt:o.receipt??null})),rejections:this.db.prepare("SELECT document,created_at FROM autonomy_events WHERE policy=? AND kind='REJECTED' ORDER BY sequence DESC LIMIT 5").all(r.config.id).map(e=>({...JSON.parse(e.document),at:e.created_at}))};}
 async status(owner,id,withHoldings=false){const r=this.row(owner,id),out=this.public(r);if(withHoldings){try{out.portfolio=await this.holdings(r);}catch{out.portfolioUnavailable=true;}}return out;}
 assertRunning(r){const current=this.row(r.config.owner,r.config.id);need(current.phase==='RUNNING'&&current.config.approvalHash===r.config.approvalHash,'POLICY_STOPPED');}
 async tick(id){
  if(this.busy.has(id))return;this.busy.add(id);
  try{
   const record=this.db.prepare('SELECT owner FROM autonomy_bindings WHERE id=?').get(id);let r=this.row(record.owner,id);
   if(r.phase==='APPROVAL_PENDING'){await this.confirmApproval(r);return;}
   if(!['RUNNING','STOPPED','ATTENTION'].includes(r.phase))return;
   const runtime=new AutonomyRuntime({journal:this.journal,devnet:this.devnet,mainnet:this.mainnet,stockmesh:this.stockmesh,signer:this.signer(r.binding),beforeSign:()=>this.assertRunning(r)});
   let orders=this.orders(id),order=orders.at(-1);
   // Recover older receipts as well, not just the latest leg. Before this fence,
   // a filled leg left its router nonce locked while the next leg was signed.
   const incomplete=orders.find(o=>terminal(o.phase)&&(!o.settlementSignature||!o.engineReconciled));
   if(incomplete){await runtime.check(incomplete.id);return;}
   if(order&&['RESERVING','PERMITTED'].includes(order.phase)&&Date.parse(order.prepared.expiresAt)<=Date.now()){
    const state=await runtime.observed(r.config);
    if(state.pending)order=this.journal.expireUnsigned(order.id,state);
   }
   // Recovery always reconciles the last exact transaction before a new leg.
   if(order&&terminal(order.phase)&&(!order.settlementSignature||!order.engineReconciled)){await runtime.check(order.id);return;}
   if(order&&!terminal(order.phase)){
    if(order.phase==='RESERVING'&&r.phase==='RUNNING'){const sig=await this.devnet.reserve(r.config,order);this.assertRunning(r);order=this.journal.permitted(order.id,await runtime.observed(r.config),sig);}
    if(order.phase==='PERMITTED'&&r.phase==='RUNNING'){await runtime.execute(order.id);return;}
    if(order.phase==='SIGNED'||order.phase==='UNKNOWN'){
     order=await runtime.check(order.id);
     if(!terminal(order.phase)&&r.phase==='RUNNING'&&order.relayAttempts<3&&Date.now()-(order.lastRelayAt??0)>10000)await runtime.relay(order.id);
     return;
    }
    if(['SIGNING','SIGNING_UNKNOWN'].includes(order.phase))throw Object.assign(Error('SIGNING_OUTCOME_UNKNOWN'),{code:'SIGNING_OUTCOME_UNKNOWN'});
    return;
   }
   if(order&&['FAILED_FINALIZED','EXPIRED_UNSIGNED','EXPIRED_NO_FILL'].includes(order.phase)){
    // A proven terminal failure ends the remaining allocation; it is not an
    // implicit request to refill, retry, or spend the remainder on another plan.
    this.journal.stop(id,r.config.owner);r=this.row(r.config.owner,id);
    this.save({...r,binding:{...r.binding,enabled:false},error:null,stopReason:'TRADE_NOT_FILLED',stoppedAt:Date.now()},'STOPPED');return;
   }
   if(r.phase!=='RUNNING')return;
   if(orders.length===r.approval.legs.length){this.journal.stop(id,r.config.owner);this.save({...r,binding:{...r.binding,enabled:false},error:null,completedAt:Date.now()},'COMPLETE');return;}
   this.assertRunning(r);
   // Another strategy may be approved/running, but only one unresolved wire
   // may consume this wallet's StockMesh nonce. This queue is not a plan lock.
   if(this.walletPending(r))return;
   const connection=await this.connection(r.config.owner);need(connection.walletId===r.binding.walletId,'WALLET_BINDING_CHANGED');
   this.assertRunning(r);
   const leg=r.approval.legs[orders.length];
   const portfolio=await this.stockmesh.portfolio(r.config.wallet);
   assertStepFunds(r.approval.plan,orders.length,portfolio,r.config.wallet);
   const reserve=this.reservedElsewhere(r);need(portfolio.stateSlot>=reserve.lastReceiptSlot,'HOLDINGS_CATCHING_UP');
   if(leg.side==='BUY')need(integer(portfolio.cash.find(c=>c.symbol==='USDC')?.atoms)>=integer(leg.inputAtoms)+reserve.cash+integer(r.approval.plan.cashFloorAtoms??'0'),'AGENT_WALLET_BUDGET_RESERVED');
   else need(integer(portfolio.holdings.find(h=>h.mint===leg.mint)?.atoms??'0')>=integer(leg.inputAtoms)+(reserve.tokens.get(leg.mint)??0n),'AGENT_HOLDINGS_RESERVED');
   order=await runtime.prepare(id,leg);this.assertRunning(r);await runtime.execute(order.id);
  }catch(e){
   const current=this.db.prepare('SELECT owner FROM autonomy_bindings WHERE id=?').get(id);if(current){const r=this.row(current.owner,id),code=typeof e.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:'EXECUTION_NEEDS_REVIEW';
    // Pending finalized evidence is retryable; unknown signing is never re-signed.
    if(['DEVNET_CONFIRMATION_PENDING','STOCKMESH_RECONCILIATION_PENDING','HOLDINGS_CATCHING_UP','ORDER_UNRESOLVED'].includes(code))this.save({...r,error:code});
    else if(r.phase==='RUNNING')this.save({...r,error:code},'ATTENTION');
    else if(r.phase==='APPROVAL_PENDING')this.save({...r,error:code});
   }
  }finally{this.db.prepare('UPDATE autonomy_bindings SET updated_at=? WHERE id=?').run(Date.now(),id);this.busy.delete(id);}
 }
 async tickNext(){const row=this.db.prepare(`SELECT id FROM autonomy_bindings b WHERE phase IN ('APPROVAL_PENDING','RUNNING','ATTENTION') OR (phase='STOPPED' AND EXISTS (SELECT 1 FROM autonomy_orders o WHERE o.policy=b.id AND (o.phase NOT IN ('RECONCILED','FAILED_FINALIZED','EXPIRED_UNSIGNED','EXPIRED_NO_FILL') OR json_extract(o.document,'$.settlementSignature') IS NULL OR json_extract(o.document,'$.engineReconciled') IS NULL))) ORDER BY updated_at LIMIT 1`).get();if(row)await this.tick(row.id);}
}
