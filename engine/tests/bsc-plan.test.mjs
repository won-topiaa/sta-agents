import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentStore} from '../lib/research-agent-core.mjs';
import {presetBody} from '../lib/research-agent-profile.mjs';
import {bindAgentic,startAgentic,stopAgentic,agenticRun,agenticTick as tickOnce,decimal18} from '../lib/research-agentic.mjs';

// The gateway's Agentic session must be signed in to the bound wallet; these fakes answer as the bound one.
const boundAddress=s=>s.db.prepare('SELECT address FROM agent_agentic_binding LIMIT 1').get()?.address;
const agenticTick=(s,gw,...rest)=>tickOnce(s,async(m,p,b)=>p.startsWith('/v1/agentic/address')?{addresses:[{binanceChainId:'56',address:boundAddress(s)}]}:gw(m,p,b),...rest);
import {bscProduct} from '../lib/bsc-research-universe.mjs';

const owner='eip155:56:0x1111111111111111111111111111111111111111',other='eip155:56:0x2222222222222222222222222222222222222222';
const brief={name:'BSC run',objective:'Chips on BNB Chain.',budget:'60',instruments:['NVDA','AMD'],weights:[],cashBps:null};
const goal={targetReturnBps:1000,horizonDays:365,maxDrawdownBps:3000,maxWeightBps:5000,minCashBps:500,costBps:50};
const hash=n=>'0x'+String(n).padStart(64,'0');
function setup(t){const dir=mkdtempSync(join(tmpdir(),'xtxc-bsc-'));const s=new AgentStore(join(dir,'db.sqlite'),['NVDA','AMD']);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return s;}
function approved(s,{approval='PER_TRADE',agent=true}={}){
  const a=agent?s.saveAgent(owner,{operation:'CREATE',requestId:randomUUID(),profile:{...presetBody('Chip dipper'),approval}}):null;
  const strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,...(a?{agentId:a.id}:{})}});
  s.enqueue(owner,strategy.id,goal,randomUUID());const run=s.claim();
  s.finish(run,'REVIEW',{candidates:[{id:'c1',verdict:'ELIGIBLE',weights:[{instrument:'NVDA',weightBps:2500},{instrument:'AMD',weightBps:2500}],
    agentChecks:a?a.rules.map(r=>({rule:r.id,params:r.params,status:'pass'})):undefined}]});
  const r=s.view(owner,strategy.id).runs[0];
  return {plan:s.approve(owner,r.id,'c1',r.result.reportHash),agent:a};
}

test('BNB Chain principals budget in USDT (18 decimals) and their plans are marked eip155:56',t=>{
  const s=setup(t),{plan}=approved(s);
  assert.equal(plan.chain,'eip155:56');assert.equal(plan.budgetAsset,'USDT');assert.equal(plan.budgetAtoms,(60n*10n**18n).toString());
  assert.deepEqual(plan.legs.map(l=>[l.instrument,l.inputAtoms,l.inputDecimals]),[['NVDA',(15n*10n**18n).toString(),18],['AMD',(15n*10n**18n).toString(),18]]);
  assert.throws(()=>s.owner('eip155:56:0xnot-an-address'),/Sign in/);
  assert.throws(()=>s.reserveStep(owner,plan.id,0),/BNB Chain trade steps/);   // the Solana path never serves a BSC plan
  assert.ok(bscProduct('NVDA')&&bscProduct('AMD'));
});

test('a BSC leg: exact approval, then a swap; receipts move it forward and finish the plan',t=>{
  const s=setup(t),{plan}=approved(s);
  s.assertBscPreparable(owner,plan.id,0,'5');
  assert.throws(()=>s.assertBscPreparable(owner,plan.id,1,'5'),/previous trade/);
  s.bscPrepared(owner,plan.id,0,'APPROVE',{tx:{from:'0x1',to:'0xusdt',data:'0x095ea7b3',value:'0'}},'5');
  s.bscSent(owner,plan.id,0,hash(1));
  assert.equal(s.bscStep(owner,plan.id,0).phase,'APPROVE_SENT');
  assert.throws(()=>s.assertBscPreparable(owner,plan.id,0,'6'),/Check this trade/);
  s.bscReceipt(owner,plan.id,0,null);                                   // pending is neither success nor failure
  assert.equal(s.bscStep(owner,plan.id,0).phase,'APPROVE_SENT');
  s.bscReceipt(owner,plan.id,0,{status:'SUCCESS',blockNumber:1});
  assert.equal(s.bscStep(owner,plan.id,0).phase,'ALLOWANCE_READY');
  s.assertBscPreparable(owner,plan.id,0,'6');
  s.bscPrepared(owner,plan.id,0,'SWAP',{tx:{from:'0x1',to:'0xrouter',data:'0xad43f73d',value:'0'},quote:{toTokenAmount:'1'}},'6');
  s.bscSent(owner,plan.id,0,hash(2));
  assert.equal(s.plan(owner,plan.id).status,'UNKNOWN');
  s.bscReceipt(owner,plan.id,0,{status:'SUCCESS',blockNumber:2});
  assert.equal(s.bscStep(owner,plan.id,0).phase,'RECONCILED');assert.equal(s.plan(owner,plan.id).status,'PARTIAL');
  assert.throws(()=>s.assertBscPreparable(owner,plan.id,0,'7'),/Check this trade/);
  s.assertBscPreparable(owner,plan.id,1,'7');
  s.bscPrepared(owner,plan.id,1,'SWAP',{tx:{from:'0x1',to:'0xrouter',data:'0xad43f73d',value:'0'}},'7');
  s.bscSent(owner,plan.id,1,hash(3));s.bscReceipt(owner,plan.id,1,{status:'SUCCESS',blockNumber:3});
  assert.equal(s.plan(owner,plan.id).status,'COMPLETE');
  assert.throws(()=>s.bscStep(other,plan.id,0),/not found/i);
});

test('a prepared trade is never rebuilt after the wallet has sent anything; a failed swap can be retried',t=>{
  const s=setup(t),{plan}=approved(s);
  s.bscPrepared(owner,plan.id,0,'SWAP',{tx:{from:'0x1',to:'0xrouter',data:'0xad43f73d',value:'0'}},'9');
  s.assertBscPreparable(owner,plan.id,0,'9');                          // nothing sent since: a fresh quote is fine
  assert.throws(()=>s.assertBscPreparable(owner,plan.id,0,'10'),/sent a transaction after this trade was prepared/);
  s.bscSent(owner,plan.id,0,hash(4));s.bscReceipt(owner,plan.id,0,{status:'FAILED',blockNumber:4});
  assert.equal(s.bscStep(owner,plan.id,0).phase,'FAILED');
  s.assertBscPreparable(owner,plan.id,0,'10');                         // a reverted swap filled nothing
});

test('agentic runs need an agent that may trade on its own, a bound wallet and enough daily limit',t=>{
  const s=setup(t);
  const perTrade=approved(s).plan;
  bindAgentic(s,owner,'0x3333333333333333333333333333333333333333');
  assert.throws(()=>startAgentic(s,owner,perTrade.id,1000),/approve every trade/);
  assert.throws(()=>bindAgentic(s,other,'0x4444444444444444444444444444444444444444'),/another account/);
  const auto=approved(s,{approval:'AUTO_WITHIN_LIMITS'}).plan;
  assert.throws(()=>startAgentic(s,owner,auto.id,10),/daily limit left/);
  const plain=approved(s,{agent:false}).plan;
  assert.throws(()=>startAgentic(s,owner,plain.id,1000),/designed by your agent/);
  assert.equal(startAgentic(s,owner,auto.id,100).status,'RUNNING');
  assert.throws(()=>s.assertBscPreparable(owner,auto.id,0,'1'),/Agentic Wallet/);   // no manual signing alongside
});

test('the worker submits legs in order, marks before ordering, and never resubmits after an interruption',async t=>{
  const s=setup(t);bindAgentic(s,owner,'0x3333333333333333333333333333333333333333');
  const plan=approved(s,{approval:'AUTO_WITHIN_LIMITS'}).plan;startAgentic(s,owner,plan.id,100);
  const calls=[];let orderStatus='PENDING';
  const gw=async(method,path,body)=>{calls.push([method,path.split('?')[0],body]);
    if(path==='/v1/agentic/quota')return {quotaLeft:'100'};
    if(path==='/v1/agentic/swap')return {orderId:`o-${calls.filter(c=>c[1]==='/v1/agentic/swap').length}`};
    if(path.startsWith('/v1/agentic/order'))return [{orderId:new URL('http://g'+path).searchParams.get('orderId'),status:orderStatus}];
    throw new Error('unexpected '+path);};
  await agenticTick(s,gw);
  const swaps=()=>calls.filter(c=>c[1]==='/v1/agentic/swap');
  assert.equal(swaps().length,1);assert.equal(swaps()[0][2].fromTokenQty,'15');assert.equal(swaps()[0][2].toToken,bscProduct('NVDA').contract);
  await agenticTick(s,gw);assert.equal(swaps().length,1);              // pending order: wait, do not send leg 2
  orderStatus='FINISHED';await agenticTick(s,gw);
  assert.equal(swaps().length,2);assert.equal(swaps()[1][2].toToken,bscProduct('AMD').contract);
  await agenticTick(s,gw);assert.equal(agenticRun(s,plan.id).status,'COMPLETE');assert.equal(s.plan(owner,plan.id).status,'COMPLETE');
  // Interrupted between the durable mark and the order id: UNKNOWN, never a second order.
  const p2=approved(s,{approval:'AUTO_WITHIN_LIMITS'}).plan;startAgentic(s,owner,p2.id,100);
  s.db.prepare("INSERT INTO agent_steps VALUES(?,0,'AGENTIC_SUBMITTING',?)").run(p2.id,JSON.stringify({leg:p2.legs[0]}));
  const before=swaps().length;await agenticTick(s,gw);
  assert.equal(swaps().length,before);assert.equal(agenticRun(s,p2.id).status,'ATTENTION');
  assert.equal(s.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=? AND step=0').get(p2.id).phase,'UNKNOWN');
  // A daily limit below the next leg pauses the run instead of ordering.
  const p3=approved(s,{approval:'AUTO_WITHIN_LIMITS'}).plan;startAgentic(s,owner,p3.id,100);
  const low=async(m,p,b)=>p==='/v1/agentic/quota'?{quotaLeft:'5'}:gw(m,p,b);
  const n=swaps().length;await agenticTick(s,low);
  assert.equal(swaps().length,n);assert.equal(agenticRun(s,p3.id).status,'PAUSED');
  stopAgentic(s,owner,p3.id);
  assert.equal(decimal18('15000000000000000000'),'15');assert.equal(decimal18('1500000000000000001'),'1.500000000000000001');
});

test('BSC purchases below the minimum order stay in cash; a plan of only tiny legs is refused',t=>{
  const s=setup(t);
  const strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,budget:'20'}});
  s.enqueue(owner,strategy.id,goal,randomUUID());const run=s.claim();
  s.finish(run,'REVIEW',{candidates:[{id:'c1',verdict:'ELIGIBLE',weights:[{instrument:'NVDA',weightBps:4000},{instrument:'AMD',weightBps:1000}]}]});
  const r=s.view(owner,strategy.id).runs[0],plan=s.approve(owner,r.id,'c1',r.result.reportHash);
  assert.deepEqual(plan.legs.map(l=>l.instrument),['NVDA']);assert.deepEqual(plan.belowMinimum,['AMD']);
  assert.equal(plan.cashAtoms,(12n*10n**18n).toString());   // 20 - 8 (NVDA) = 12, of which 2 from AMD
  const tiny=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,budget:'6'}});
  s.enqueue(owner,tiny.id,goal,randomUUID());const run2=s.claim();
  s.finish(run2,'REVIEW',{candidates:[{id:'c1',verdict:'ELIGIBLE',weights:[{instrument:'NVDA',weightBps:4000},{instrument:'AMD',weightBps:4000}]}]});
  const r2=s.view(owner,tiny.id).runs[0];
  assert.throws(()=>s.approve(owner,r2.id,'c1',r2.result.reportHash),/minimum order/);
});

test('Agentic: a changed gateway wallet, a lapsed approval or a refused order never trades or leaves a leg uncertain',async t=>{
  const s=setup(t);bindAgentic(s,owner,'0x3333333333333333333333333333333333333333');
  let plan=approved(s,{approval:'AUTO_WITHIN_LIMITS'}).plan;startAgentic(s,owner,plan.id,100);
  const swaps=[];
  const other=async(m,p,b)=>{if(p.startsWith('/v1/agentic/address'))return {addresses:[{binanceChainId:'56',address:'0x9999999999999999999999999999999999999999'}]};
    if(p==='/v1/agentic/quota')return {quotaLeft:'100'};if(p==='/v1/agentic/swap'){swaps.push(b);return {orderId:'o-1'};}throw new Error('unexpected '+p);};
  await tickOnce(s,other);
  assert.equal(swaps.length,0);assert.equal(agenticRun(s,plan.id).reason,'WALLET_CHANGED');
  // A refusal before any order (the gateway's price check) leaves the leg READY and pauses the run.
  const s2=setup(t);bindAgentic(s2,owner,'0x3333333333333333333333333333333333333333');
  plan=approved(s2,{approval:'AUTO_WITHIN_LIMITS'}).plan;startAgentic(s2,owner,plan.id,100);
  const refuse=code=>async(m,p)=>{if(p==='/v1/agentic/quota')return {quotaLeft:'100'};if(p==='/v1/agentic/swap')throw Object.assign(new Error('refused'),{code});throw new Error('unexpected '+p);};
  await agenticTick(s2,refuse('PRICE'));
  assert.equal(agenticRun(s2,plan.id).status,'PAUSED');assert.equal(agenticRun(s2,plan.id).reason,'PRICE_CHECK');
  assert.equal(s2.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=?').get(plan.id).phase,'READY');
  // An unclear answer (timeout) may have placed an order: UNKNOWN, never retried.
  const s3=setup(t);bindAgentic(s3,owner,'0x3333333333333333333333333333333333333333');
  plan=approved(s3,{approval:'AUTO_WITHIN_LIMITS'}).plan;startAgentic(s3,owner,plan.id,100);
  await agenticTick(s3,refuse('AGENTIC_UNKNOWN'));
  assert.equal(agenticRun(s3,plan.id).status,'ATTENTION');
  assert.equal(s3.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=?').get(plan.id).phase,'UNKNOWN');
  // Past the approval deadline the run stops instead of buying on an old result.
  const s4=setup(t);bindAgentic(s4,owner,'0x3333333333333333333333333333333333333333');
  plan=approved(s4,{approval:'AUTO_WITHIN_LIMITS'}).plan;startAgentic(s4,owner,plan.id,100);
  const row=s4.db.prepare('SELECT document FROM agent_plans WHERE id=?').get(plan.id),doc=JSON.parse(row.document);
  s4.db.prepare('UPDATE agent_plans SET document=? WHERE id=?').run(JSON.stringify({...doc,expiresAt:Date.now()-1}),plan.id);
  const sent=[];await agenticTick(s4,async(m,p,b)=>{if(p==='/v1/agentic/quota')return {quotaLeft:'100'};if(p==='/v1/agentic/swap'){sent.push(b);return {orderId:'o-1'};}throw new Error('unexpected '+p);});
  assert.equal(sent.length,0);assert.equal(agenticRun(s4,plan.id).reason,'PLAN_EXPIRED');
});
