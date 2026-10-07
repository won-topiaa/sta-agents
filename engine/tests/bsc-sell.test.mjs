import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore,sellLegs} from '../lib/research-agent-core.mjs';
import {presetBody} from '../lib/research-agent-profile.mjs';
import {bindAgentic,startAgentic,agenticTick} from '../lib/research-agentic.mjs';
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
function strategyWith(s,{approval='PER_TRADE',weights=[{instrument:'NVDA',weightBps:2500},{instrument:'AMD',weightBps:2500}],exit=null}={}){
  const a=s.saveAgent(owner,{operation:'CREATE',requestId:randomUUID(),profile:{...presetBody('Seller'),approval}});
  const strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,agentId:a.id}});
  s.enqueue(owner,strategy.id,goal,randomUUID());const run=s.claim();
  s.finish(run,'REVIEW',{candidates:[{id:'c1',verdict:'ELIGIBLE',weights,...(exit?{design:{exit}}:{}),agentChecks:a.rules.map(r=>({rule:r.id,params:r.params,status:'pass'}))}]});
  const r=s.view(owner,strategy.id).runs[0];
  return {strategy,agent:a,run:r};
}
function reconcile(s,planId,index,at){
  s.bscPrepared(owner,planId,index,'SWAP',{tx:{from:'0x1',to:'0xrouter',data:'0xad43f73d',value:'0'}},String(index));
  s.bscSent(owner,planId,index,hash(index+10));
  if(at){const row=s.db.prepare('SELECT document FROM agent_steps WHERE plan_id=? AND step=?').get(planId,index),doc=JSON.parse(row.document);doc.sent.at=at;s.db.prepare('UPDATE agent_steps SET document=? WHERE plan_id=? AND step=?').run(JSON.stringify(doc),planId,index);}
  s.bscReceipt(owner,planId,index,{status:'SUCCESS',blockNumber:index+1});
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
    if(path.endsWith('/aggregator/swap'))return {executionMode:'SWAP',tx:{from:user,to:router,data:'0xad43f73d'+word(stock)+word(BSC_USDT)+hex(amount)+'00'.repeat(32),value:'0',gas:'450000',minReceiveAmount:'356400000000000000000'}};
    throw new Error('unexpected '+path);},post:async path=>{seen.push(path);return {status:'SUCCESS',balanceChanges:[]};}},
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
