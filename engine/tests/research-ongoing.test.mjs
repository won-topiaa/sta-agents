import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {sign} from 'node:crypto';
import {canonical,hash,MAINNET} from '../lib/research-autonomy-policy.mjs';
import {hash as reportHash} from '../lib/research-agent-core.mjs';
import {AgentStore,briefHash} from '../lib/research-agent-core.mjs';
import {flushOperatingResearch} from '../lib/research-ongoing-feed.mjs';
import {validateOperatingMandate,operatingMessage,verifyOperatingSignature} from '../lib/research-ongoing-policy.mjs';
import {OngoingJournal} from '../lib/research-ongoing-journal.mjs';
import {OngoingControl} from '../lib/research-ongoing-control.mjs';
import {OngoingRuntime} from '../lib/research-ongoing-runtime.mjs';
import {chooseOperatingResearch,operatingRisk,decideOperatingTrade,checkedOperatingPortfolio,observeOperatingPortfolio} from '../lib/research-ongoing-decision.mjs';
import {inspectStockMeshTrade} from '../lib/research-autonomy-wire.mjs';
import {fixture,key,preparedTrade,observation,finalReceipt} from './fixtures/ongoing.mjs';

function active(x,db=new DatabaseSync(':memory:')) {const j=new OngoingJournal(db);j.draft(x.c,x.binding);j.activate(x.c.id,x.c.owner,x.signature(),x.binding);return j;}
function wake(j,c){j.transaction(()=>{const r=j.row(c.id);j.save({...r,nextAt:0});});}
test('operating mandate is one exact owner-signed authority; chains, budgets and assets cannot change',()=>{
 const x=fixture();assert.equal(validateOperatingMandate(x.c),x.c);assert.equal(verifyOperatingSignature(x.c,x.signature()).length,64);
 for(const patch of [{capitalAtoms:'4000001'},{executionChain:'evm:arbitrum'},{wallet:key(2)},{riskAction:'REDUCE'},{expiresAt:'1'},{assets:[x.c.assets[1]]}])assert.throws(()=>verifyOperatingSignature({...x.c,...patch},x.signature()));
 const wrong=sign(null,Buffer.from(operatingMessage(x.c)),x.walletPair.privateKey).toString('base64');assert.throws(()=>verifyOperatingSignature(x.c,wrong));
 for(const patch of [{capitalAtoms:4},{perBuyAtoms:'4000001'},{pollMs:1},{extra:'unsafe'},{maxOrders:'0'},{goal:{...x.c.goal,maxDrawdownBps:3000}}])assert.throws(()=>validateOperatingMandate({...x.c,...patch}));
});
test('pause preserves authority; revoke cannot be resumed or replayed',()=>{
 const x=fixture(),j=active(x);try{j.stop(x.c.owner,x.c.id);assert.throws(()=>j.assertActive(x.c.id),/MANDATE_INACTIVE/);assert.equal(j.resume(x.c.owner,x.c.id).phase,'ACTIVE');j.stop(x.c.owner,x.c.id,true);assert.throws(()=>j.resume(x.c.owner,x.c.id));assert.throws(()=>j.activate(x.c.id,x.c.owner,x.signature(),x.binding));assert.throws(()=>j.row(x.c.id,key(99)));}finally{j.db.close();}
});
test('research must match immutable goal, owner, universe, report hash, age and independent eligibility checks',()=>{
 const x=fixture(),r=x.research();assert.equal(chooseOperatingResearch(x.c,r).candidate.id,'a');
 for(const patch of [{owner:key(20)},{updatedAt:Date.now()-86400001},{strategy:{...r.strategy,budget:'9'}},{input:{...r.input,goal:{...r.input.goal,minCashBps:100}}}])assert.throws(()=>chooseOperatingResearch(x.c,{...r,...patch}));
 const bad=structuredClone(r);bad.result.candidates[0].holdoutDrawdownBps=5000;const {reportHash:_,...body}=bad.result;bad.result.reportHash=reportHash(body);assert.throws(()=>chooseOperatingResearch(x.c,bad),/failed calculation/);
 const reordered=structuredClone(r);reordered.result.candidates[1].holdoutReturnBps=999999;const {reportHash:a,...b}=reordered.result;reordered.result.reportHash=reportHash(b);assert.equal(chooseOperatingResearch(x.c,reordered).candidate.id,'a');
});
test('automatic loss accounting reconciles fills and separates cash transfers from investment performance',()=>{
 const x=fixture(),h={...x.c.assets[0],atoms:'200',valueAtoms:'2000000'};
 const initial=operatingRisk(null,observation(x.c,'4000000'),[],2000);
 const after=operatingRisk(initial,observation(x.c,'2000000',[h]),[{phase:'RECONCILED',side:'BUY',mint:h.mint,inputAtoms:'2000000',outputAtoms:'200'}],2000);assert.equal(after.drawdownBps,0);
 const cashOut=operatingRisk(after,observation(x.c,'1000000',[h]),[],2000);assert.equal(cashOut.flowAtoms,'-1000000');assert.equal(cashOut.drawdownBps,0);
 const lost=operatingRisk(cashOut,observation(x.c,'1000000',[{...h,valueAtoms:'1000000'}]),[],2000);assert.equal(lost.drawdownBps,3333);assert.equal(lost.latched,true);
 assert.equal(operatingRisk(lost,observation(x.c,'1000000',[h]),[],2000).latched,true);
 assert.throws(()=>operatingRisk(after,observation(x.c,'2000000',[{...h,atoms:'300'}]),[],2000),/EXTERNAL_STOCK_MOVEMENT/);
});
test('rebalance sells first; liquidations bypass normal dust and reduction freezes target token quantities',()=>{
 const x=fixture(),a=x.c.assets[0],o=observation(x.c,'2000000',[{...a,atoms:'200',valueAtoms:'2000000'}]);
 const selection=chooseOperatingResearch(x.c,x.research('MSFT'));
 assert.equal(decideOperatingTrade(x.c,o,selection,{latched:false},{buyReservedAtoms:'0'}).leg.side,'SELL');
 const dust=observation(x.c,'3000000',[{...a,atoms:'1',valueAtoms:'1'}]);
 assert.equal(decideOperatingTrade(x.c,dust,null,{latched:true},{riskTargets:{}}).leg.inputAtoms,'1');
 const c={...x.c,riskAction:'REDUCE'},r={latched:true};
 assert.equal(decideOperatingTrade(c,o,null,r,{riskTargets:{[a.mint]:'100'}}).leg.inputAtoms,'100');
 assert.equal(decideOperatingTrade(c,observation(c,'2000000',[{...a,atoms:'100',valueAtoms:'2000000'}]),null,r,{riskTargets:{[a.mint]:'100'}}).action,'HOLD');
});
test('portfolio reader rejects other owners, stale state, unknown positions and duplicate cash identity',()=>{
 const x=fixture(),p={schema:'skew.stockmesh.portfolio/v1',owner:x.c.wallet,network:'mainnet-beta',stateSlot:10,observedAt:new Date().toISOString(),cash:[{symbol:'USDC',atoms:'4'}],holdings:[]};assert.equal(checkedOperatingPortfolio(x.c,p).cashAtoms,'4');
 for(const patch of [{owner:key(3)},{observedAt:new Date(Date.now()-40000).toISOString()},{holdings:[{...x.c.assets[0],mint:key(4),atoms:'1'}]},{cash:[...p.cash,...p.cash]},{otherStockHoldings:[{mint:key(5)}]}])assert.throws(()=>checkedOperatingPortfolio(x.c,{...p,...patch}));
});
test('valuation expiry is rechecked after the final portfolio read; an old price cannot become a fresh risk state',async()=>{
 const x=fixture(),a=x.c.assets[0];let reads=0;const stockmesh={portfolio:async()=>{
  reads++;if(reads===2)await new Promise(r=>setTimeout(r,60));
  return {schema:'skew.stockmesh.portfolio/v1',network:'mainnet-beta',owner:x.c.wallet,stateSlot:100,observedAt:new Date().toISOString(),cash:[{symbol:'USDC',atoms:'2000000'}],holdings:[{...a,atoms:'200'}]};
 },quote:async()=>({schema:'skew.stockmesh.liquidation-quote/v1',quoteId:'fresh',instrument:a.instrument,side:'SELL',inputProduct:{mint:a.mint,inputAtoms:'200'},output:{symbol:'USDC',decimals:6,minimumAtoms:'2000000',estimatedAtoms:'2000000'},expiresAt:new Date(Date.now()+40).toISOString()})};
 await assert.rejects(observeOperatingPortfolio(x.c,stockmesh),/VALUATION_EXPIRED/);
});
test('ongoing report feed is scoped, monotonic and idempotent without another owner signature',()=>{
 const x=fixture(),j=active(x),ctl=new OngoingControl({journal:j}),r=x.research();try{assert.equal(ctl.feed(x.c.owner,x.c.id,r).accepted,true);assert.equal(ctl.feed(x.c.owner,x.c.id,r).duplicate,true);assert.throws(()=>ctl.feed(x.c.owner,x.c.id,x.research('NVDA',r.updatedAt-1)),/OUT_OF_ORDER/);assert.throws(()=>ctl.feed(x.c.owner,x.c.id,x.research('MSFT',r.updatedAt)),/CONFLICT/);assert.equal(j.row(x.c.id).phase,'ACTIVE');}finally{j.db.close();}
});
test('full simulated chain path: one owner authorization -> buy -> research update -> sell -> buy -> loss liquidation -> ongoing watch',async()=>{
 const x=fixture(),j=active(x);let cash=4000000n,held=new Map(),prices=new Map(x.c.assets.map(a=>[a.mint,10000n])),slot=1000,counter=0,current=null,signedCount=0;const records=new Map(),trace=[];
 const portfolio=async()=>({schema:'skew.stockmesh.portfolio/v1',network:'mainnet-beta',owner:x.c.wallet,stateSlot:slot,observedAt:new Date().toISOString(),cash:[{symbol:'USDC',atoms:String(cash)}],holdings:x.c.assets.filter(a=>(held.get(a.mint)??0n)>0n).map(a=>({...a,atoms:String(held.get(a.mint))}))});
 const stockmesh={portfolio,quote:async q=>{
  const a=x.c.assets.find(a=>a.instrument===q.instrument),input=BigInt(q.inputAtoms??String(BigInt(q.notional.split('.')[0])*1000000n+BigInt((q.notional.split('.')[1]??'').padEnd(6,'0'))));
  const output=q.side==='BUY'?input/prices.get(a.mint):input*prices.get(a.mint);
  if(q.side==='SELL')return {schema:'skew.stockmesh.liquidation-quote/v1',quoteId:`q${counter}`,instrument:a.instrument,side:'SELL',inputProduct:{mint:a.mint,inputAtoms:String(input)},output:{symbol:'USDC',decimals:6,minimumAtoms:String(output),estimatedAtoms:String(output)},expiresAt:new Date(Date.now()+120000).toISOString()};
  return {schema:'skew.stockmesh.exposure-quote/v2',quoteId:`q${counter}`,instrument:a.instrument,inputSymbol:'USDC',inAmountAtoms:String(input),exposure:{estimatedQ32:'1000',minimumQ32:'1000',products:[{mint:a.mint,rawOutputAtoms:String(output)}]},expiresAt:new Date(Date.now()+120000).toISOString()};
 },prepare:async()=>{
  const r=j.row(x.c.id),selection=chooseOperatingResearch(x.c,r.research),obs={...checkedOperatingPortfolio(x.c,await portfolio()),holdings:(await portfolio()).holdings.map(h=>({...h,valueAtoms:String(BigInt(h.atoms)*prices.get(h.mint))})),equityAtoms:String(cash+[...held].reduce((n,[m,v])=>n+v*prices.get(m),0n))};
  const decision=decideOperatingTrade(x.c,obs,selection,r.risk,r.usage),leg=decision.leg,output=leg.side==='BUY'?BigInt(leg.inputAtoms)/prices.get(leg.mint):BigInt(leg.inputAtoms)*prices.get(leg.mint);
  current=await preparedTrade(x,{...leg,minimumOutputAtoms:String(output)},counter++);return current.prepared;
 },submit:async request=>{
  const order=j.orders(x.c.id).at(-1);assert.equal(request.signedTransactionBase64,current.signed);
  const input=BigInt(order.facts.inputAtoms),output=BigInt(order.facts.minimumOutputAtoms),n=held.get(order.facts.mint)??0n;
  const before=order.facts.side==='BUY'?[cash,n]:[n,cash];
  if(order.facts.side==='BUY'){cash-=input;held.set(order.facts.mint,n+output);}else{cash+=output;held.set(order.facts.mint,n-input);}
  const after=order.facts.side==='BUY'?[cash,held.get(order.facts.mint)]:[held.get(order.facts.mint),cash];
  records.set(order.signature,finalReceipt(order,current.signed,before,after,++slot));trace.push(`${order.facts.side}:${order.facts.instrument}`);return {signature:current.signature};
 },order:async()=>({signature:current.signature,phase:'RECONCILED',receiptVerified:true})};
 const mainnet={pin:async m=>assert.equal(m,MAINNET),lookup:async()=>null,simulate:async wire=>{const orderFacts=await inspectStockMeshTrade(wire,x.c.wallet,{side:decideOperatingTrade(x.c,j.row(x.c.id).risk.observation,chooseOperatingResearch(x.c,j.row(x.c.id).research),j.row(x.c.id).risk,j.row(x.c.id).usage).leg.side,mint:decideOperatingTrade(x.c,j.row(x.c.id).risk.observation,chooseOperatingResearch(x.c,j.row(x.c.id).research),j.row(x.c.id).risk,j.row(x.c.id).usage).leg.mint,inputAtoms:decideOperatingTrade(x.c,j.row(x.c.id).risk.observation,chooseOperatingResearch(x.c,j.row(x.c.id).research),j.row(x.c.id).risk,j.row(x.c.id).usage).leg.inputAtoms,minimumOutputAtoms:'1'},async()=>null);return {genesisHash:MAINNET,messageHash:orderFacts.messageHash,err:null};},blockhashValid:async()=>true,transaction:async s=>records.get(s)??null,expiredNoFill:async()=>null};
 const signer=()=>({assertBinding:async()=>{},signTransaction:async()=>{signedCount++;return current.signed;}});
 const runtime=new OngoingRuntime({journal:j,mainnet,stockmesh,signer}),ctl=new OngoingControl({journal:j,runtime,stockmesh,signer});
 try {
  ctl.feed(x.c.owner,x.c.id,x.research('NVDA',Date.now()-2000));await ctl.tick(x.c.id);assert.deepEqual(trace,['BUY:NVDA']);
  ctl.feed(x.c.owner,x.c.id,x.research('MSFT',Date.now()-1000));await ctl.tick(x.c.id);assert.deepEqual(trace,['BUY:NVDA','SELL:NVDA']);
  wake(j,x.c);await ctl.tick(x.c.id);assert.deepEqual(trace,['BUY:NVDA','SELL:NVDA','BUY:MSFT']);
  prices.set(x.c.assets[1].mint,5000n);wake(j,x.c);await ctl.tick(x.c.id);assert.deepEqual(trace,['BUY:NVDA','SELL:NVDA','BUY:MSFT','SELL:MSFT']);
  wake(j,x.c);await ctl.tick(x.c.id);assert.equal(ctl.status(x.c.owner,x.c.id).progress,'WATCHING');assert.equal(j.row(x.c.id).phase,'RISK_EXIT');assert.equal(cash,3000000n);assert.equal(signedCount,4);assert.equal(j.orders(x.c.id).filter(o=>o.phase==='RECONCILED').length,4);assert.equal(j.db.prepare("SELECT count(*) n FROM ongoing_events WHERE kind='OWNER_AUTHORIZED'").get().n,1);
 }finally{j.db.close();}
});

async function staged(x,j,side='BUY') {
 const a=x.c.assets[0],leg={side,instrument:a.instrument,mint:a.mint,inputAtoms:side==='BUY'?'2000000':'200',inputDecimals:side==='BUY'?6:0,minimumCashAtoms:side==='BUY'?'0':'1'};
 const p=await preparedTrade(x,{...leg,minimumOutputAtoms:side==='BUY'?'200':'2000000'});
 const facts=await inspectStockMeshTrade(p.prepared.transactionBase64,x.c.wallet,{...leg,minimumOutputAtoms:'1'},async()=>null);
 return {...p,row:j.stage(x.c.id,{action:'TRADE',leg},p.prepared,{...facts,instrument:a.instrument})};
}
test('durable order reservations survive restart and reject duplicate pending buys without refunding allowance',async()=>{
 const x=fixture(),dir=mkdtempSync(join(tmpdir(),'sta-operating-')),path=join(dir,'gate.sqlite');let j=active(x,new DatabaseSync(path));
 try{const s=await staged(x,j);assert.equal(j.row(x.c.id).usage.buyReservedAtoms,'2000000');await assert.rejects(staged(x,j),/ORDER_UNRESOLVED/);j.beginSigning(s.row.id);j.db.close();j=new OngoingJournal(new DatabaseSync(path));assert.equal(j.order(s.row.id).phase,'SIGNING');j.signingUnknown(s.row.id);assert.throws(()=>j.beginSigning(s.row.id),/ALREADY_ATTEMPTED/);assert.equal(j.row(x.c.id).usage.buyReservedAtoms,'2000000');}finally{j.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('one active operating authority per wallet, even across different strategies',()=>{
 const x=fixture(),j=active(x),other={...x.c,id:'dc'.repeat(32),strategyId:randomUUID()};try{j.draft(other,x.binding);const sig=sign(null,Buffer.from(operatingMessage(other)),x.ownerPair.privateKey).toString('base64');assert.throws(()=>j.activate(other.id,other.owner,sig,x.binding),/WALLET_ALREADY_MANAGED/);j.stop(x.c.owner,x.c.id,true);assert.equal(j.activate(other.id,other.owner,sig,x.binding).phase,'ACTIVE');}finally{j.db.close();}
});
test('normal trading retains transaction slots for loss exits; risk sells cannot exceed total owner authority',async()=>{
 const x=fixture();x.c.maxOrders='3';const j=active(x);try{await staged(x,j);const r=j.row(x.c.id);j.save({...r,usage:{...r.usage,orders:'1'}});await assert.rejects(staged(x,j),/ORDER_UNRESOLVED/);const o=j.orders(x.c.id)[0];j.put(o,'EXPIRED_UNSIGNED');await assert.rejects(staged(x,j),/RISK_EXIT_ORDER_RESERVE/);const current=j.row(x.c.id);j.save({...current,risk:{latched:true}},'RISK_EXIT');assert.equal((await staged(x,j,'SELL')).row.phase,'PREPARED');}finally{j.db.close();}
});
test('mainnet receipt alone does not unlock another trade until the venue has independently reconciled it',async()=>{
 const x=fixture(),j=active(x);try{const s=await staged(x,j);j.beginSigning(s.row.id);j.signed(s.row.id,s.signed);const order=j.order(s.row.id);j.receipt(order.id,{signature:order.signature,messageHash:order.facts.messageHash,phase:'RECONCILED',inputAtoms:'2000000',outputAtoms:'200'});assert.throws(()=>j.reconciled(order.id,{signature:order.signature,phase:'SUBMITTED',receiptVerified:false}),/RECONCILIATION_PENDING/);await assert.rejects(staged(x,j),/ORDER_UNRESOLVED/);assert.equal(j.reconciled(order.id,{signature:order.signature,phase:'RECONCILED',receiptVerified:true}).phase,'RECONCILED');}finally{j.db.close();}
});
test('owner pause during delegated signing records the signature but prevents relay; later receipt recovery still works',async()=>{
 const x=fixture(),j=active(x);try{
  const s=await staged(x,j),p=observation(x.c,'4000000'),r=j.row(x.c.id);j.save({...r,risk:operatingRisk(null,p,[],2000)});let submits=0;
  const stockmesh={portfolio:async()=>({schema:'skew.stockmesh.portfolio/v1',network:'mainnet-beta',owner:x.c.wallet,stateSlot:1000,observedAt:new Date().toISOString(),cash:[{symbol:'USDC',atoms:'4000000'}],holdings:[]}),submit:async()=>{submits++;},order:async()=>({signature:s.signature,phase:'RECONCILED',receiptVerified:true})};
  const cashHash=checkedOperatingPortfolio(x.c,await stockmesh.portfolio()).balanceHash;const old=j.row(x.c.id);j.save({...old,risk:{...old.risk,observation:{...old.risk.observation,balanceHash:cashHash}}});
  const runtime=new OngoingRuntime({journal:j,stockmesh,mainnet:{pin:async()=>{},blockhashValid:async()=>true,transaction:async()=>finalReceipt(j.order(s.row.id),s.signed,['4000000','0'],['2000000','200']),expiredNoFill:async()=>null},signer:()=>({assertBinding:async()=>{},signTransaction:async()=>{j.stop(x.c.owner,x.c.id);return s.signed;}})});
  await assert.rejects(runtime.execute(s.row.id),/MANDATE_INACTIVE/);assert.equal(submits,0);assert.equal(j.order(s.row.id).signature,s.signature);assert.equal((await runtime.check(s.row.id)).phase,'RECONCILED');assert.equal(j.row(x.c.id).phase,'PAUSED');
 }finally{j.db.close();}
});
test('pause while price observation is pending cannot be overwritten by a late controller update',async()=>{
 const x=fixture(),j=active(x);let release;const wait=new Promise(r=>{release=r;});const ctl=new OngoingControl({journal:j,runtime:{prepare:()=>{throw Error('must not prepare');}},observe:async()=>{await wait;return observation(x.c,'4000000');}});
 try{const running=ctl.tick(x.c.id);j.stop(x.c.owner,x.c.id);release();await running;assert.equal(j.row(x.c.id).phase,'PAUSED');assert.equal(j.orders(x.c.id).length,0);}finally{j.db.close();}
});
test('loss liquidation operates with unavailable or stale research and does not wait for model inference',async()=>{
 const x=fixture(),j=active(x),a=x.c.assets[0];let selected;
 try{const baseline=observation(x.c,'2000000',[{...a,atoms:'200',valueAtoms:'2000000'}]),r=j.row(x.c.id);j.save({...r,risk:operatingRisk(null,baseline,[],2000)});
  const ctl=new OngoingControl({journal:j,observe:async()=>observation(x.c,'2000000',[{...a,atoms:'200',valueAtoms:'1000000'}]),runtime:{prepare:async(id,d)=>{selected=d;return{id:'fixture'};},execute:async()=>{}}});await ctl.tick(x.c.id);assert.equal(selected.leg.reason,'LOSS_LIMIT_EXIT');assert.equal(selected.leg.inputAtoms,'200');assert.equal(j.row(x.c.id).phase,'RISK_EXIT');
 }finally{j.db.close();}
});
test('unfilled signed order needs finalized unchanged nonce proof; expiry cannot reset used allowances',async()=>{
 const x=fixture(),j=active(x);try{const s=await staged(x,j);j.beginSigning(s.row.id);j.signed(s.row.id,s.signed);const o=j.order(s.row.id),proof={schema:'xtxc.signed-expiry/v1',phase:'EXPIRED_NO_FILL',signature:s.signature,messageHash:o.facts.messageHash,blockhashExpired:true,historyAbsent:true,slot:Number(o.facts.deadlineSlot)+1,reason:'FINALIZED_UNCHANGED_STOCKMESH_NONCE'};
 for(const patch of [{historyAbsent:false},{blockhashExpired:false},{signature:'foreign'},{slot:1}])assert.throws(()=>j.expiredSigned(o.id,{...proof,...patch}));j.expiredSigned(o.id,proof);assert.equal(j.row(x.c.id).usage.buyReservedAtoms,'2000000');assert.equal(j.order(o.id).phase,'EXPIRED_NO_FILL');}finally{j.db.close();}
});
test('a signed operating monitor queues research durably and retries delivery without a second model run',async()=>{
 const x=fixture(),dir=mkdtempSync(join(tmpdir(),'sta-monitor-')),s=new AgentStore(join(dir,'research.sqlite'),x.strategy.instruments);
 try{const address=`solana:${x.c.owner}`,strategy=s.mutate(address,{operation:'CREATE',requestId:randomUUID(),brief:x.strategy});x.c.strategyId=strategy.id;x.c.briefHash=briefHash(strategy);
  const execution={id:x.c.id,authorized:true,phase:'ACTIVE',config:x.c};assert.equal(s.operatingMonitor(address,execution).expiresAt,0);
  const id=s.enqueue(address,strategy.id,x.c.goal,randomUUID()),run=s.claim();assert.equal(run.id,id);const result=x.research().result;const {reportHash:_,...body}=result;assert.equal(s.finish(run,'REVIEW',body),true);
  assert.equal(s.db.prepare('SELECT count(*) n FROM agent_operating_outbox').get().n,1);let calls=0;await flushOperatingResearch(s,async()=>{calls++;throw Error('OPERATING_GATE_UNAVAILABLE');});assert.equal(s.db.prepare('SELECT attempts FROM agent_operating_outbox').get().attempts,1);
  await flushOperatingResearch(s,async(owner,op,input)=>{calls++;assert.equal(owner,x.c.owner);assert.equal(op,'ONGOING_FEED');assert.equal(input.research.runId,id);},Date.now()+6000);
  assert.equal(s.db.prepare('SELECT count(*) n FROM agent_operating_outbox').get().n,0);assert.equal(calls,2);assert.equal(s.view(address,strategy.id).runs.length,1);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
