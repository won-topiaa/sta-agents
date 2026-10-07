import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,sellLegs} from '../lib/research-agent-core.mjs';
import {presetBody} from '../lib/research-agent-profile.mjs';
import {bindAgentic,startAgentic,stopAgentic,agenticTick,agenticRun} from '../lib/research-agentic.mjs';
import {createSellPlan,approveProposed,strategyContracts,holdingsFor,exitWatch,exitPositions} from '../lib/research-bsc-sell.mjs';
import {bscProduct} from '../lib/bsc-research-universe.mjs';
import {BSC_ROUTER} from '../lib/bsc-execution.mjs';
import {createGateway} from '../bnb-gateway/server.mjs';
import {BSC_USDT} from '../lib/binance-web3.mjs';

const owner='eip155:56:0x1111111111111111111111111111111111111111',agenticWallet='0x3333333333333333333333333333333333333333';
const brief={name:'BSC sells',objective:'Chips on BNB Chain.',budget:'60',instruments:['NVDA','AMD'],weights:[],cashBps:null};
const goal={targetReturnBps:1000,horizonDays:365,maxDrawdownBps:3000,maxWeightBps:5000,minCashBps:500,costBps:50};
const hash=n=>'0x'+String(n).padStart(64,'0');
const nvda=bscProduct('NVDA').contract.toLowerCase(),amd=bscProduct('AMD').contract.toLowerCase();
const tokens=n=>(BigInt(n)*10n**18n).toString();
function setup(t){const dir=mkdtempSync(join(tmpdir(),'xtxc-bsc-sell-'));const s=new AgentStore(join(dir,'db.sqlite'),['NVDA','AMD']);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
function strategyWith(s,{approval='PER_TRADE',weights=[{instrument:'NVDA',weightBps:2500},{instrument:'AMD',weightBps:2500}],exit=null,who=owner,budget='60'}={}){
  const a=s.saveAgent(who,{operation:'CREATE',requestId:randomUUID(),profile:{...presetBody('Seller'),approval}});
  const strategy=s.mutate(who,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,budget,agentId:a.id}});
  s.enqueue(who,strategy.id,goal,randomUUID());const run=s.claim();
  s.finish(run,'REVIEW',{candidates:[{id:'c1',verdict:'ELIGIBLE',weights,...(exit?{design:{exit}}:{}),agentChecks:a.rules.map(r=>({rule:r.id,params:r.params,status:'pass'}))}]});
  const r=s.view(who,strategy.id).runs[0];
  return {strategy,agent:a,run:r};
}
let sentSeq=100;
function reconcile(s,planId,index,at,{who=owner,minOut=null}={}){
  s.bscPrepared(who,planId,index,'SWAP',{tx:{from:'0x1',to:'0xrouter',data:'0xad43f73d',value:'0',...(minOut?{minReceiveAmount:minOut}:{})}},String(index));
  s.bscSent(who,planId,index,hash(sentSeq++));
  if(at){const row=s.db.prepare('SELECT document FROM agent_steps WHERE plan_id=? AND step=?').get(planId,index),doc=JSON.parse(row.document);doc.sent.at=at;s.db.prepare('UPDATE agent_steps SET document=? WHERE plan_id=? AND step=?').run(JSON.stringify(doc),planId,index);}
  s.bscReceipt(who,planId,index,{status:'SUCCESS',blockNumber:index+1});
}

test('sale legs: only this strategy\'s listed contracts, whole holdings, nothing for zero balances',()=>{
  const s={instruments:['NVDA','AMD']};
  const legs=sellLegs(s,[{instrument:'NVDA',contract:nvda,raw:tokens(2)},{instrument:'AMD',contract:amd,raw:'0'}]);
  assert.deepEqual(legs.map(l=>[l.side,l.instrument,l.productContract.toLowerCase(),l.inputAtoms,l.inputDecimals]),[['SELL','NVDA',nvda,tokens(2),18]]);
  assert.throws(()=>sellLegs(s,[{instrument:'NVDA',contract:amd,raw:'1'}]),/not a listed/);                       // another stock's token
  assert.throws(()=>sellLegs(s,[{instrument:'TSLA',contract:nvda,raw:'1'}]),/not part of this strategy/);
  assert.throws(()=>sellLegs(s,[{instrument:'NVDA',contract:nvda,raw:'1'},{instrument:'NVDA',contract:nvda,raw:'2'}]),/once per plan/);
  assert.deepEqual(holdingsFor(s,{holdings:[{contract:nvda.toUpperCase().replace('0X','0x'),raw:'5'},{contract:amd,raw:'0'}]}).map(h=>[h.instrument,h.raw]),[['NVDA','5']]);
  assert.ok(strategyContracts(s).some(c=>c.contract===amd));
});

test('closing positions: an approved sale plan whose legs are signed like purchases; one open sale per holding',t=>{
  const s=setup(t),{strategy}=strategyWith(s);
  const plan=createSellPlan(s,owner,strategy.id,{kind:'CLOSE',holdings:[{instrument:'NVDA',contract:nvda,raw:tokens(3)},{instrument:'AMD',contract:amd,raw:tokens(1)}]});
  assert.equal(plan.status,'APPROVED');assert.equal(plan.kind,'CLOSE');assert.equal(plan.wallet,'PERSONAL');assert.equal(plan.budgetAtoms,'0');
  assert.deepEqual(plan.legs.map(l=>[l.side,l.instrument]),[['SELL','NVDA'],['SELL','AMD']]);
  assert.throws(()=>createSellPlan(s,owner,strategy.id,{kind:'CLOSE',holdings:[{instrument:'NVDA',contract:nvda,raw:tokens(3)}]}),/already open/);
  assert.throws(()=>createSellPlan(s,owner,strategy.id,{kind:'CLOSE',holdings:[{instrument:'NVDA',contract:nvda,raw:'0'}]}),/Nothing to sell/);
  reconcile(s,plan.id,0);reconcile(s,plan.id,1);
  assert.equal(s.plan(owner,plan.id).status,'COMPLETE');
  assert.equal(createSellPlan(s,owner,strategy.id,{kind:'CLOSE',holdings:[{instrument:'NVDA',contract:nvda,raw:tokens(1)}]}).status,'APPROVED');   // finished sales free the holding
});

test('rebalance: holdings the approved design no longer holds are sold first, then the purchases follow',t=>{
  const s=setup(t),{run}=strategyWith(s,{weights:[{instrument:'NVDA',weightBps:2500}]});
  const plan=s.approve(owner,run.id,'c1',run.result.reportHash,null,{sells:[{instrument:'NVDA',contract:nvda,raw:tokens(1)},{instrument:'AMD',contract:amd,raw:tokens(4)}],wallet:'PERSONAL'});
  assert.deepEqual(plan.legs.map(l=>[l.side,l.instrument]),[['SELL','AMD'],['BUY','NVDA']]);   // NVDA stays in the target: not sold
  assert.equal(plan.sells,1);assert.equal(plan.wallet,'PERSONAL');
  s.assertBscPreparable(owner,plan.id,0,'1');
  assert.throws(()=>s.assertBscPreparable(owner,plan.id,1,'1'),/previous trade/);   // the sale settles before buying
});

test('rebalance needs a run that knew the holdings when the design keeps holdings (entry filters, hold buffer)',t=>{
  const s=setup(t),a=s.saveAgent(owner,{operation:'CREATE',requestId:randomUUID(),profile:{...presetBody('Patterns'),approval:'PER_TRADE'}});
  const strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,agentId:a.id}});
  const result=(held,design)=>({candidates:[{id:'c1',verdict:'ELIGIBLE',weights:[{instrument:'NVDA',weightBps:2500}],design,agentChecks:a.rules.map(r=>({rule:r.id,params:r.params,status:'pass'}))}],...(held?{heldInstruments:held}:{})});
  const run=(held,design,given=null)=>{s.enqueue(owner,strategy.id,goal,randomUUID(),given);const c=s.claim();s.finish(c,'REVIEW',result(held,design));return s.view(owner,strategy.id).runs[0];};
  const sells={sells:[{instrument:'AMD',contract:amd,raw:tokens(1)}],wallet:'PERSONAL'};
  const entry={filters:[{signal:'breakout',lookback:55,rule:'above',value:0,entry:true}]};
  let r=run(null,entry);
  assert.throws(()=>s.approve(owner,r.id,'c1',r.result.reportHash,null,sells),/did not account for your current holdings/);
  r=run(null,{filters:[],hold_buffer:2});
  assert.throws(()=>s.approve(owner,r.id,'c1',r.result.reportHash,null,sells),/did not account/);
  r=run(['AMD'],entry);
  assert.deepEqual(s.approve(owner,r.id,'c1',r.result.reportHash,null,sells).legs.map(l=>l.side+' '+l.instrument),['SELL AMD','BUY NVDA']);
  r=run(null,{filters:[{signal:'trend',lookback:200,rule:'above',value:0}]});                     // no kept holdings: no guard
  assert.equal(s.approve(owner,r.id,'c1',r.result.reportHash,null,sells).legs.length,2);
});

test('a run records the holdings it was given: within the strategy, unique, sorted',t=>{
  const s=setup(t),{strategy}=strategyWith(s);
  s.enqueue(owner,strategy.id,goal,randomUUID(),['NVDA','TSLA','AMD','NVDA']);
  assert.deepEqual(s.claim().input.heldInstruments,['AMD','NVDA']);
  s.enqueue(owner,strategy.id,goal,randomUUID(),[]);assert.deepEqual(s.claim().input.heldInstruments,[]);   // read, holds none
  s.enqueue(owner,strategy.id,goal,randomUUID());assert.equal('heldInstruments' in s.claim().input,false);  // not read
  assert.throws(()=>s.enqueue(owner,strategy.id,goal,randomUUID(),[1]),/Invalid holdings/);
});

test('exit watch: a fired stop loss proposes a sale to a per-trade owner, once per price release',async t=>{
  const s=setup(t),{strategy,run}=strategyWith(s,{exit:{stop_loss:0.1,trailing_stop:null}});
  const buy=s.approve(owner,run.id,'c1',run.result.reportHash);
  reconcile(s,buy.id,0,Date.parse('2026-10-08T15:00:00Z'));
  assert.deepEqual(exitPositions(s).map(p=>[p.instrument,p.since,p.wallet]),[['NVDA','2026-10-08','PERSONAL']]);
  const reads=[],checks=[];
  const gw=async(method,path)=>{reads.push(path);return {holdings:[{contract:nvda,raw:tokens(2)}]};};
  const check=async input=>{checks.push(input);return {asOf:'2026-10-09',positions:[{ticker:'NVDA',entryClose:100,peakClose:104,lastClose:89,lastDate:'2026-10-09',triggered:'stop_loss'}]};};
  const r=await exitWatch(s,{gw,check,release:'rel-1'});
  assert.equal(r.proposals.length,1);assert.equal(r.proposals[0].auto,false);
  assert.match(reads[0],/^\/v1\/holdings\?address=0x1111111111111111111111111111111111111111&tokens=/);
  assert.deepEqual(checks[0],{positions:[{ticker:'NVDA',since:'2026-10-08',stop_loss:0.1,trailing_stop:null}]});
  const proposed=s.view(owner,strategy.id).plans.find(p=>p.kind==='EXIT');
  assert.equal(proposed.status,'PROPOSED');assert.equal(proposed.reason.rules[0].rule,'stop_loss');assert.equal(proposed.legs[0].inputAtoms,tokens(2));
  assert.throws(()=>s.assertBscPreparable(owner,proposed.id,0,'1'),/no longer current/);   // nothing is signed before the owner accepts
  assert.deepEqual(await exitWatch(s,{gw,check,release:'rel-1'}),{skipped:'DONE'});
  assert.equal(approveProposed(s,owner,proposed.id).status,'APPROVED');
  s.assertBscPreparable(owner,proposed.id,0,'1');
  assert.throws(()=>approveProposed(s,owner,proposed.id),/no longer open/);
  const again=await exitWatch(s,{gw,check,release:'rel-2'});   // the open sale already covers the holding
  assert.equal(again.proposals.length,0);
});

test('exit watch: an agent that trades on its own sells from the Agentic Wallet at once; no trigger, no plan',async t=>{
  const s=setup(t),{strategy,run}=strategyWith(s,{approval:'AUTO_WITHIN_LIMITS',exit:{stop_loss:null,trailing_stop:0.15}});
  bindAgentic(s,owner,agenticWallet);
  const buy=s.approve(owner,run.id,'c1',run.result.reportHash);
  startAgentic(s,owner,buy.id,1000);
  const orders=[];
  const fill=async(method,path,body)=>{if(method==='POST'){orders.push(body);return {orderId:`o-${orders.length}`};}if(path.startsWith('/v1/agentic/order'))return {status:'FINISHED'};return {quotaLeft:1000};};
  for(let i=0;i<4;i++)await agenticTick(s,fill);
  assert.equal(s.plan(owner,buy.id).status,'COMPLETE');
  const quiet=await exitWatch(s,{gw:async()=>({holdings:[{contract:nvda,raw:tokens(1)},{contract:amd,raw:tokens(1)}]}),check:async i=>({asOf:'2026-10-09',positions:i.positions.map(p=>({ticker:p.ticker,triggered:null}))}),release:'r1'});
  assert.equal(quiet.positions,2);assert.equal(quiet.proposals.length,0);
  const fired=await exitWatch(s,{gw:async(m,path)=>{assert.match(path,new RegExp(agenticWallet));return {holdings:[{contract:nvda,raw:tokens(1)},{contract:amd,raw:'0'}]};},
    check:async i=>({asOf:'2026-10-10',positions:i.positions.map(p=>({ticker:p.ticker,entryClose:10,peakClose:12,lastClose:10,lastDate:'2026-10-10',triggered:'trailing_stop'}))}),release:'r2'});
  assert.equal(fired.proposals.length,1);assert.equal(fired.proposals[0].auto,true);
  const exit=s.view(owner,strategy.id).plans.find(p=>p.kind==='EXIT');
  assert.equal(exit.wallet,'AGENTIC');assert.equal(exit.status,'APPROVED');
  orders.length=0;await agenticTick(s,fill);
  assert.deepEqual(orders[0],{fromToken:exit.legs[0].productContract,toToken:BSC_USDT,fromTokenQty:'1'});   // token -> USDT
  const personal=createSellPlan(s,owner,strategy.id,{kind:'CLOSE',wallet:'PERSONAL',holdings:[{instrument:'AMD',contract:amd,raw:tokens(1)}]});
  assert.throws(()=>startAgentic(s,owner,personal.id,1000),/own wallet/);   // tokens in the owner's wallet are never sold by the agent
});

test('exit watch: a stock without verified history does not block the others',async t=>{
  const s=setup(t),{strategy,run}=strategyWith(s,{exit:{stop_loss:0.1,trailing_stop:null}});
  const buy=s.approve(owner,run.id,'c1',run.result.reportHash);
  reconcile(s,buy.id,0,Date.parse('2026-10-08T15:00:00Z'));reconcile(s,buy.id,1,Date.parse('2026-10-08T16:00:00Z'));
  const check=async({positions})=>{if(positions.some(p=>p.ticker==='AMD'))throw new Error('WAITING_DATA: Missing verified history for AMD');
    return {asOf:'2026-10-09',positions:positions.map(p=>({ticker:p.ticker,entryClose:100,peakClose:100,lastClose:85,lastDate:'2026-10-09',triggered:'stop_loss'}))};};
  const r=await exitWatch(s,{gw:async()=>({holdings:[{contract:nvda,raw:tokens(1)},{contract:amd,raw:tokens(1)}]}),check,release:'r1'});
  assert.equal(r.positions,2);assert.equal(r.proposals.length,1);
  assert.deepEqual(s.view(owner,strategy.id).plans.find(p=>p.kind==='EXIT').legs.map(l=>l.instrument),['NVDA']);
});

// ---- Review fixes: plan state guards, Agentic runs, exit watch isolation.
const tx0={from:'0x1',to:'0xrouter',data:'0xad43f73d',value:'0'};
test('revoking or stopping an Agentic plan ends its remaining trades; the worker never revives it',async t=>{
  const s=setup(t);bindAgentic(s,owner,agenticWallet);
  const orders=[];const gw=async(m,path,body)=>{if(m==='POST'){orders.push(body);return {orderId:`o-${orders.length}`};}if(path.startsWith('/v1/agentic/order'))return {orderId:'o-1',status:'FINISHED'};return {quotaLeft:1000};};
  for(const end of ['revoke','stop']){
    orders.length=0;
    const {run}=strategyWith(s,{approval:'AUTO_WITHIN_LIMITS'}),plan=s.approve(owner,run.id,'c1',run.result.reportHash);startAgentic(s,owner,plan.id,1000);
    await agenticTick(s,gw);                                   // leg 0 is sent
    if(end==='revoke')s.revoke(owner,plan.id);else stopAgentic(s,owner,plan.id);
    await agenticTick(s,gw);await agenticTick(s,gw);           // leg 0 settles; leg 1 is never sent
    assert.equal(orders.length,1,end);assert.equal(s.plan(owner,plan.id).status,'REVOKED',end);
    assert.equal(s.db.prepare("SELECT phase FROM agent_steps WHERE plan_id=? AND step=0").get(plan.id).phase,'RECONCILED',end);
  }
});
test('a started Agentic plan never expires; a revoked or finished plan stays as it is',t=>{
  const s=setup(t),{run}=strategyWith(s,{approval:'AUTO_WITHIN_LIMITS'});bindAgentic(s,owner,agenticWallet);
  const plan=s.approve(owner,run.id,'c1',run.result.reportHash);startAgentic(s,owner,plan.id,1000);
  assert.deepEqual(s.expireUnusedPlans(owner,Date.now()+7200000),[]);assert.equal(s.plan(owner,plan.id).status,'APPROVED');
  const other=strategyWith(s),done=s.approve(owner,other.run.id,'c1',other.run.result.reportHash);reconcile(s,done.id,0);reconcile(s,done.id,1);
  s.revoke(owner,done.id);assert.equal(s.plan(owner,done.id).status,'COMPLETE');
});
test('a BSC preparation is refused when the step changed, the plan ended or the agent took it over meanwhile',t=>{
  const s=setup(t),{run}=strategyWith(s),plan=s.approve(owner,run.id,'c1',run.result.reportHash);
  const g1=s.assertBscPreparable(owner,plan.id,0,'1').guard,g2=s.assertBscPreparable(owner,plan.id,0,'1').guard;   // two tabs
  s.bscPrepared(owner,plan.id,0,'SWAP',{tx:tx0},'1',g1);
  assert.throws(()=>s.bscPrepared(owner,plan.id,0,'SWAP',{tx:tx0},'1',g2),/changed while/);   // never overwrite the other tab's step
  const g3=s.assertBscPreparable(owner,plan.id,0,'1').guard;s.bscSent(owner,plan.id,0,hash(900));
  assert.throws(()=>s.bscPrepared(owner,plan.id,0,'SWAP',{tx:tx0},'1',g3),/changed while|no longer current/);   // sent meanwhile: not re-prepared
  const r2=strategyWith(s).run,p2=s.approve(owner,r2.id,'c1',r2.result.reportHash),g4=s.assertBscPreparable(owner,p2.id,0,'1').guard;
  s.revoke(owner,p2.id);assert.throws(()=>s.bscPrepared(owner,p2.id,0,'SWAP',{tx:tx0},'1',g4),/no longer current/);
  bindAgentic(s,owner,agenticWallet);
  const r3=strategyWith(s,{approval:'AUTO_WITHIN_LIMITS'}).run,p3=s.approve(owner,r3.id,'c1',r3.result.reportHash),g5=s.assertBscPreparable(owner,p3.id,0,'1').guard;
  startAgentic(s,owner,p3.id,1000);assert.throws(()=>s.bscPrepared(owner,p3.id,0,'SWAP',{tx:tx0},'1',g5),/Agentic Wallet/);
});
test('one transaction hash settles one step only',t=>{
  const s=setup(t),{run}=strategyWith(s),plan=s.approve(owner,run.id,'c1',run.result.reportHash);
  s.bscPrepared(owner,plan.id,0,'SWAP',{tx:tx0},'1');s.bscSent(owner,plan.id,0,hash(777));s.bscReceipt(owner,plan.id,0,{status:'SUCCESS',blockNumber:1});
  s.bscPrepared(owner,plan.id,1,'SWAP',{tx:tx0},'2');
  assert.throws(()=>s.bscSent(owner,plan.id,1,hash(777).toUpperCase().replace('0X','0x')),/already recorded/);
});
test('Agentic purchases above the 200 USDT leg cap are refused up front; an owner may sell Agentic holdings whatever the agent setting',t=>{
  const s=setup(t);bindAgentic(s,owner,agenticWallet);
  const big=strategyWith(s,{approval:'AUTO_WITHIN_LIMITS',budget:'1000'}).run,plan=s.approve(owner,big.id,'c1',big.result.reportHash);
  assert.throws(()=>startAgentic(s,owner,plan.id,5000),/capped at 200 USDT/);
  const {strategy}=strategyWith(s);   // a per-trade agent
  const sale=createSellPlan(s,owner,strategy.id,{kind:'CLOSE',wallet:'AGENTIC',holdings:[{instrument:'NVDA',contract:nvda,raw:tokens(1)}]});
  assert.equal(startAgentic(s,owner,sale.id,0).status,'RUNNING');
});
test('a paused Agentic run tries again after an hour; a cancelled order fails the leg instead of hanging',async t=>{
  const s=setup(t),{run}=strategyWith(s,{approval:'AUTO_WITHIN_LIMITS'});bindAgentic(s,owner,agenticWallet);
  const plan=s.approve(owner,run.id,'c1',run.result.reportHash);startAgentic(s,owner,plan.id,1000);
  let quota=1;const gw=async(m,path)=>{if(m==='POST')return {orderId:'o-9'};if(path.startsWith('/v1/agentic/order'))return {list:[{orderId:'o-8',status:'FINISHED'},{orderId:'o-9',status:'CANCELED'}]};return {leftQuota:quota};};
  await agenticTick(s,gw);assert.equal(agenticRun(s,plan.id).status,'PAUSED');            // 1 USD left: paused, nothing sent
  quota=1000;await agenticTick(s,gw);assert.equal(agenticRun(s,plan.id).status,'PAUSED');  // not before an hour
  await agenticTick(s,gw,Date.now()+3700000);                                                // resumes and sends leg 0
  await agenticTick(s,gw);
  assert.equal(s.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=? AND step=0').get(plan.id).phase,'FAILED');   // o-9 matched by id
  assert.equal(agenticRun(s,plan.id).status,'ATTENTION');
});
test('exit watch: sells only what this strategy bought, keeps going past one unreadable wallet, and never marks an unchecked release done',async t=>{
  const s=setup(t),other='eip155:56:0x2222222222222222222222222222222222222222';
  const a=strategyWith(s,{exit:{stop_loss:0.1,trailing_stop:null}}),pa=s.approve(owner,a.run.id,'c1',a.run.result.reportHash);
  reconcile(s,pa.id,0,Date.parse('2026-10-08T15:00:00Z'),{minOut:tokens(2)});
  const b=strategyWith(s,{exit:{stop_loss:0.1,trailing_stop:null},who:other}),pb=s.approve(other,b.run.id,'c1',b.run.result.reportHash);
  reconcile(s,pb.id,0,Date.parse('2026-10-08T15:00:00Z'),{who:other});
  const check=async({positions})=>({asOf:'2026-10-09',positions:positions.map(p=>({ticker:p.ticker,entryClose:100,peakClose:100,lastClose:80,lastDate:'2026-10-09',triggered:'stop_loss'}))});
  const gw=async(m,path)=>{if(path.includes('0x2222'))throw new Error('gateway down');return {holdings:[{contract:nvda,raw:tokens(9)}]};};
  const r=await exitWatch(s,{gw,check,release:'r1'});
  assert.equal(r.retry,true);assert.equal(r.proposals.length,1);
  const exit=s.view(owner,a.strategy.id).plans.find(p=>p.kind==='EXIT');
  assert.equal(exit.legs[0].inputAtoms,tokens(2));            // the 2 this strategy bought, not the wallet's 9
  assert.notDeepEqual(await exitWatch(s,{gw,check,release:'r1'}),{skipped:'DONE'});   // retried, not marked done
  await assert.rejects(exitWatch(s,{gw:async()=>({holdings:[{contract:nvda,raw:tokens(1)}]}),check:async()=>{throw new Error('spawn failed');},release:'r2'}),/unavailable/);
});

// Gateway: sales prepare the same way as purchases (exact token approval, checked swap, dry run); holdings are read
// on chain for listed stock tokens only.
async function call(server,method,path,body){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const {port}=server.address();
  try{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Authorization:'Bearer t0k','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};}
  finally{server.close();}
}
test('gateway: a stock -> USDT sale gets an exact token approval, then a checked swap; holdings read balanceOf',async()=>{
  const user='0x1111111111111111111111111111111111111111',stock='0x02fca66c1d1afb4e2a7884261eb00f63598a7436',router=BSC_ROUTER;
  const amount=tokens(2),word=a=>a.toLowerCase().slice(2).padStart(64,'0'),hex=v=>BigInt(v).toString(16).padStart(64,'0');
  const fake=({allowance=0n})=>{const seen=[];return {seen,client:{get:async path=>{seen.push(path);
    if(path.endsWith('/rwa/tokens'))return [{tokenContractAddress:stock,tokenSymbol:'NVDAB',decimals:'18',underlyingTicker:'NVDA',tokenToShareRatio:'1',statusInfo:{reasonCode:'TRADING'}}];
    if(path.endsWith('/aggregator/quote'))return [{quoteId:'q1',vendorName:'LiquidMesh',toTokenAmount:'360000000000000000000',isBest:true}];
    if(path.endsWith('/approve-transaction'))return {0:{data:'0x095ea7b3'+word(router)+hex(amount),dexContractAddress:router,gasLimit:'70000'}};
    // Swap head words: 1 receiver (0 = the sender), 3 input token, 4 amount, 5 output token, 6 minimum received.
    if(path.endsWith('/aggregator/swap'))return {executionMode:'SWAP',tx:{from:user,to:router,data:'0xad43f73d'+hex(0)+hex(0)+hex(0)+word(stock)+hex(amount)+word(BSC_USDT)+hex('356400000000000000000'),value:'0',gas:'450000',minReceiveAmount:'356400000000000000000'}};
    throw new Error('unexpected '+path);},post:async path=>{seen.push(path);return {status:'SUCCESS',balanceChanges:[{owner:user,contractAddress:stock,tokenType:'ERC20',change:'-'+amount},{owner:user,contractAddress:BSC_USDT,tokenType:'ERC20',change:'358000000000000000000'}]};}},
    rpc:async(method,params)=>{if(method==='eth_getBalance')return '0x'+(10n**16n).toString(16);if(method==='eth_call')return '0x'+(params[0].data.startsWith('0x70a08231')?10n**19n:allowance).toString(16);return null;}};};
  let f=fake({});
  let r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:stock,toToken:BSC_USDT,amount});
  assert.equal(r.body.data.step,'APPROVE');assert.equal(r.body.data.tx.to,stock);assert.equal(r.body.data.quote.fromSymbol,'NVDAB');assert.equal(r.body.data.quote.toSymbol,'USDT');
  f=fake({allowance:BigInt(amount)});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:stock,toToken:BSC_USDT,amount});
  assert.equal(r.body.data.step,'SWAP');assert.equal(r.body.data.tx.minReceiveAmount,'356400000000000000000');
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:stock,toToken:BSC_USDT,amount:tokens(1000)});
  assert.equal(r.body.error.code,'NO_FUNDS');   // the 200 USDT purchase cap does not apply to sales; the held balance does
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'GET',`/v1/holdings?address=${user}&tokens=${stock}`);
  assert.deepEqual(r.body.data.holdings,[{contract:stock,raw:(10n**19n).toString()}]);
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'GET',`/v1/holdings?address=${user}&tokens=0x4444444444444444444444444444444444444444`);
  assert.equal(r.body.error.code,'TOKEN');
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'GET',`/v1/holdings?address=${user}&tokens=${BSC_USDT}`);
  assert.equal(r.body.error.code,'TOKEN');
});
