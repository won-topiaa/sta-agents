import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore} from '../lib/research-agent-core.mjs';
import {presetBody} from '../lib/research-agent-profile.mjs';
import {bindAgentic,startAgentic,agenticTick} from '../lib/research-agentic.mjs';
import {createSellPlan,exitWatch,heldForRun} from '../lib/research-bsc-sell.mjs';
import {bscProduct} from '../lib/bsc-research-universe.mjs';

// Review fixes (2026-10-08): a leg is never bought twice on the evidence of a failed or re-quoted swap, stale sales no
// longer silence stops, automatic exits sell only what the strategy filled, and runs treat only the strategy's own
// purchases as held.
const owner='eip155:56:0x1111111111111111111111111111111111111111',agenticWallet='0x3333333333333333333333333333333333333333';
const brief={name:'BSC review',objective:'Chips on BNB Chain.',budget:'60',instruments:['NVDA','AMD'],weights:[],cashBps:null};
const goal={targetReturnBps:1000,horizonDays:365,maxDrawdownBps:3000,maxWeightBps:5000,minCashBps:500,costBps:50};
const hash=n=>'0x'+String(n).padStart(64,'0');
const nvda=bscProduct('NVDA').contract.toLowerCase(),amd=bscProduct('AMD').contract.toLowerCase();
const tokens=n=>(BigInt(n)*10n**18n).toString();
function setup(t){const dir=mkdtempSync(join(tmpdir(),'xtxc-bsc-review-'));const s=new AgentStore(join(dir,'db.sqlite'),['NVDA','AMD']);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
function strategyWith(s,{approval='PER_TRADE',exit=null}={}){
  const a=s.saveAgent(owner,{operation:'CREATE',requestId:randomUUID(),profile:{...presetBody('Seller'),approval}});
  const strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,agentId:a.id}});
  s.enqueue(owner,strategy.id,goal,randomUUID());const run=s.claim();
  s.finish(run,'REVIEW',{candidates:[{id:'c1',verdict:'ELIGIBLE',weights:[{instrument:'NVDA',weightBps:2500},{instrument:'AMD',weightBps:2500}],...(exit?{design:{exit}}:{}),agentChecks:a.rules.map(r=>({rule:r.id,params:r.params,status:'pass'}))}]});
  return {strategy,run:s.view(owner,strategy.id).runs[0]};
}
const approveTx={from:'0x1111111111111111111111111111111111111111',to:'0xusdt',data:'0x095ea7b3',value:'0'};
const swapTx=(tag,minOut=tokens(2))=>({from:'0x1111111111111111111111111111111111111111',to:'0xrouter',data:`0xad43f73d${tag}`,value:'0',minReceiveAmount:minOut});
let seq=500;
function approved(s,planId){   // this step's own exact approval, confirmed on chain
  s.bscPrepared(owner,planId,0,'APPROVE',{tx:approveTx},'5');s.bscSent(owner,planId,0,hash(seq++));s.bscReceipt(owner,planId,0,{status:'SUCCESS'});
}
const setDoc=(s,planId,patch)=>{const row=s.db.prepare('SELECT document FROM agent_plans WHERE id=?').get(planId);s.db.prepare('UPDATE agent_plans SET document=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.document),...patch}),planId);};

test('BNB Chain plans state 1% slippage, the cap BSC_PREPARE enforces',t=>{
  const s=setup(t),{run}=strategyWith(s);
  assert.equal(s.approve(owner,run.id,'c1',run.result.reportHash).maxSlippageBps,100);
});

test('a swap reported as failed after the approval was spent is never re-approved; the swap that went through can be reported',t=>{
  const s=setup(t),{run}=strategyWith(s),plan=s.approve(owner,run.id,'c1',run.result.reportHash);
  approved(s,plan.id);
  const {guard}=s.assertBscPreparable(owner,plan.id,0,'6');
  s.bscPrepared(owner,plan.id,0,'SWAP',{tx:swapTx('01')},'6',guard);
  // The wallet confirmed the swap twice: the first bought, the second (reported) reverted on the spent allowance.
  const first=hash(seq++),second=hash(seq++);
  s.bscSent(owner,plan.id,0,second);s.bscReceipt(owner,plan.id,0,{status:'FAILED'});
  assert.equal(s.bscStep(owner,plan.id,0).phase,'FAILED');
  const again=s.assertBscPreparable(owner,plan.id,0,'8');
  assert.throws(()=>s.bscPrepared(owner,plan.id,0,'APPROVE',{tx:approveTx},'8',again.guard),/allowance approved for this trade has been used/);
  const p1=s.bscStep(owner,plan.id,0).doc.preparedAll.at(-1);   // the route matched the sent hash to this earlier swap
  assert.throws(()=>s.bscSent(owner,plan.id,0,second,p1),/already recorded/);
  s.bscSent(owner,plan.id,0,first,p1);
  assert.equal(s.bscStep(owner,plan.id,0).phase,'SUBMITTED');
  assert.throws(()=>s.bscSent(owner,plan.id,0,hash(seq++),p1),/in flight/);
  s.bscReceipt(owner,plan.id,0,{status:'SUCCESS'});
  const done=s.bscStep(owner,plan.id,0);
  assert.equal(done.phase,'RECONCILED');assert.equal(done.doc.prepared.tx.minReceiveAmount,tokens(2));   // sizes this position's exit
});

test('a swap that reverted on price keeps its allowance and is simply quoted again',t=>{
  const s=setup(t),{run}=strategyWith(s),plan=s.approve(owner,run.id,'c1',run.result.reportHash);
  approved(s,plan.id);
  s.bscPrepared(owner,plan.id,0,'SWAP',{tx:swapTx('01')},'6');s.bscSent(owner,plan.id,0,hash(seq++));s.bscReceipt(owner,plan.id,0,{status:'FAILED'});
  const {guard}=s.assertBscPreparable(owner,plan.id,0,'7');
  assert.equal(s.bscPrepared(owner,plan.id,0,'SWAP',{tx:swapTx('02')},'7',guard).kind,'SWAP');
});

test('an unreported swap is rebuilt after the wallet moved on only while this step\'s exact approval is unused',t=>{
  const s=setup(t),{run}=strategyWith(s),plan=s.approve(owner,run.id,'c1',run.result.reportHash);
  approved(s,plan.id);
  s.bscPrepared(owner,plan.id,0,'SWAP',{tx:swapTx('01')},'6');
  const {guard}=s.assertBscPreparable(owner,plan.id,0,'7');   // the wallet sent something since
  assert.equal(guard.allowanceMustRemain,true);
  assert.throws(()=>s.bscPrepared(owner,plan.id,0,'APPROVE',{tx:approveTx},'7',guard),/allowance approved for this trade has been used/);
  const p2=s.bscPrepared(owner,plan.id,0,'SWAP',{tx:swapTx('02')},'7',guard);
  assert.equal(p2.kind,'SWAP');
  assert.deepEqual(s.bscStep(owner,plan.id,0).doc.preparedAll.map(e=>[e.kind,e.tx.data.slice(-2),e.nonce]),[['APPROVE','b3','5'],['SWAP','01','6'],['SWAP','02','7']]);
  // The router allowance is the wallet's: while this plan has a trade in flight, another plan cannot prepare one.
  const other=strategyWith(s),plan2=s.approve(owner,other.run.id,'c1',other.run.result.reportHash);
  assert.throws(()=>s.assertBscPreparable(owner,plan2.id,0,'7'),/Another plan has a trade in progress/);
  s.revoke(owner,plan.id);
  // Without an approval of its own (the router already had allowance), nothing proves the first swap did not run.
  s.bscPrepared(owner,plan2.id,0,'SWAP',{tx:swapTx('03')},'6');
  assert.throws(()=>s.assertBscPreparable(owner,plan2.id,0,'7'),/sent a transaction after/);
  // A step that prepared a swap is never approved again: its approval may have run unreported and the swap been sent.
  assert.throws(()=>s.bscPrepared(owner,plan2.id,0,'APPROVE',{tx:approveTx},'7'),/may already have gone through/);
  s.revoke(owner,plan2.id);
  // An unreported approval may always be rebuilt: approving the same amount twice is harmless.
  const third=strategyWith(s),plan3=s.approve(owner,third.run.id,'c1',third.run.result.reportHash);
  s.bscPrepared(owner,plan3.id,0,'APPROVE',{tx:approveTx},'6');
  assert.equal(s.assertBscPreparable(owner,plan3.id,0,'9').guard.allowanceMustRemain,false);
});

test('an unsigned sale past its expiry no longer blocks exits; one in flight does; another strategy may sell its own tokens',t=>{
  const s=setup(t),a=strategyWith(s,{exit:{stop_loss:0.1}}),b=strategyWith(s,{exit:{stop_loss:0.1}});
  const sell=strategy=>createSellPlan(s,owner,strategy.id,{kind:'EXIT',holdings:[{instrument:'NVDA',contract:nvda,raw:tokens(1)}]});
  const open=sell(a.strategy);
  assert.throws(()=>sell(a.strategy),e=>e.planId===open.id&&/already open/.test(e.message));
  assert.ok(sell(b.strategy).id);   // each strategy sells its own tokens
  setDoc(s,open.id,{expiresAt:Date.now()-1});
  const fresh=sell(a.strategy);   // the stale approval no longer silences the stop
  s.bscPrepared(owner,fresh.id,0,'APPROVE',{tx:approveTx},'1');s.bscSent(owner,fresh.id,0,hash(seq++));
  setDoc(s,fresh.id,{expiresAt:Date.now()-1});
  assert.throws(()=>sell(a.strategy),/already open/);   // its approval is still confirming on chain
});

test('exit watch: an open sale is reported with its plan; an unanswered ticker is retried a few times before the release is done',async t=>{
  const s=setup(t),{strategy,run}=strategyWith(s,{exit:{stop_loss:0.1}}),buy=s.approve(owner,run.id,'c1',run.result.reportHash);
  s.bscPrepared(owner,buy.id,0,'SWAP',{tx:swapTx('01')},'1');s.bscSent(owner,buy.id,0,hash(seq++));s.bscReceipt(owner,buy.id,0,{status:'SUCCESS'});
  s.bscPrepared(owner,buy.id,1,'SWAP',{tx:swapTx('02')},'2');s.bscSent(owner,buy.id,1,hash(seq++));s.bscReceipt(owner,buy.id,1,{status:'SUCCESS'});
  const open=createSellPlan(s,owner,strategy.id,{kind:'CLOSE',holdings:[{instrument:'NVDA',contract:nvda,raw:tokens(2)}]});
  const gw=async()=>({holdings:[{contract:nvda,raw:tokens(2)},{contract:amd,raw:tokens(2)}]});
  // NVDA's stop fired; AMD's history is unavailable this time.
  const check=async i=>{if(i.positions.length>1||i.positions[0].ticker==='AMD')throw new Error('no history');return {asOf:'2026-10-09',positions:[{ticker:'NVDA',triggered:'stop_loss'}]};};
  const first=await exitWatch(s,{gw,check,release:'rel-9'});
  assert.deepEqual(first.skipped,[{strategyId:strategy.id,reason:'ALREADY_OPEN',planId:open.id}]);
  assert.equal(first.retry,true);
  for(let i=0;i<4;i++)assert.equal((await exitWatch(s,{gw,check,release:'rel-9'})).retry,true);
  const last=await exitWatch(s,{gw,check,release:'rel-9'});
  assert.equal(last.retry,undefined);
  assert.deepEqual(await exitWatch(s,{gw,check,release:'rel-9'}),{skipped:'DONE'});
});

test('exit watch: an automatic exit without the filled quantity is proposed, never sold from the shared Agentic Wallet on its own',async t=>{
  const s=setup(t),{strategy,run}=strategyWith(s,{approval:'AUTO_WITHIN_LIMITS',exit:{trailing_stop:0.15}});
  bindAgentic(s,owner,agenticWallet);
  const buy=s.approve(owner,run.id,'c1',run.result.reportHash);
  startAgentic(s,owner,buy.id,1000);
  let n=0;const fill=async(method,path)=>method==='POST'?{orderId:`o-${++n}`}:path.startsWith('/v1/agentic/address')?{addresses:[{binanceChainId:'56',address:agenticWallet}]}
    :path.startsWith('/v1/agentic/order')?{orderId:new URL('http://g'+path).searchParams.get('orderId'),status:'FINISHED'}:{quotaLeft:1000};   // no filledTokenAtoms in this reply
  for(let i=0;i<4;i++)await agenticTick(s,fill);
  const r=await exitWatch(s,{gw:async()=>({holdings:[{contract:nvda,raw:tokens(5)}]}),check:async i=>({asOf:'2026-10-10',positions:i.positions.map(p=>({ticker:p.ticker,triggered:'trailing_stop'}))}),release:'r1'});
  assert.deepEqual(r.proposals.map(p=>p.auto),[false]);
  const exit=s.view(owner,strategy.id).plans.find(p=>p.kind==='EXIT');
  assert.equal(exit.status,'PROPOSED');assert.equal(exit.legs[0].inputAtoms,tokens(5));
  assert.equal(s.db.prepare('SELECT count(*) n FROM agent_agentic_runs WHERE plan_id=?').get(exit.id).n,0);
});

test('a run treats as held only this strategy\'s own purchases still in the wallet, not dust or tokens from elsewhere',t=>{
  const s=setup(t),{strategy,run}=strategyWith(s),buy=s.approve(owner,run.id,'c1',run.result.reportHash);
  assert.deepEqual(heldForRun(s,owner,strategy,'PERSONAL',{holdings:[{contract:nvda,raw:tokens(2)},{contract:amd,raw:tokens(3)}]}),[]);   // nothing bought yet
  s.bscPrepared(owner,buy.id,0,'SWAP',{tx:swapTx('01',tokens(2))},'1');s.bscSent(owner,buy.id,0,hash(seq++));s.bscReceipt(owner,buy.id,0,{status:'SUCCESS'});
  const leg0=buy.legs[0].instrument,c0=leg0==='NVDA'?nvda:amd,c1=leg0==='NVDA'?amd:nvda;
  assert.deepEqual(heldForRun(s,owner,strategy,'PERSONAL',{holdings:[{contract:c0,raw:tokens(2)},{contract:c1,raw:tokens(3)}]}),[leg0]);
  assert.deepEqual(heldForRun(s,owner,strategy,'PERSONAL',{holdings:[{contract:c0,raw:(BigInt(tokens(2))/50n).toString()}]}),[]);   // a fiftieth left: sold down
  assert.deepEqual(heldForRun(s,owner,strategy,'AGENTIC',{holdings:[{contract:c0,raw:tokens(2)}]}),[]);   // bought in the other wallet
});
