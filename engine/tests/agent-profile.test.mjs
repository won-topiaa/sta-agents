import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AgentStore,briefHash} from '../lib/research-agent-core.mjs';
import {normalizeProfile,presetBody,clampGoal,PROFILE_SCHEMA} from '../lib/research-agent-profile.mjs';
import {resolveSuggestions} from '../lib/research-agent-suggest.mjs';
import {AGENT_RULES} from '../lib/agent-rules.mjs';
import {SHARED,catalogModule} from '../../dev/sync-shared.mjs';

const owner='solana:'+'1'.repeat(32),other='solana:'+'2'.repeat(32);
const brief={name:'Evidence run',objective:'Compare cost-adjusted strategies.',budget:'100',instruments:['NVDA','AMD'],weights:[],cashBps:null};
const goal={targetReturnBps:1000,horizonDays:365,maxDrawdownBps:3000,maxWeightBps:5000,minCashBps:500,costBps:50};
const root=fileURLToPath(new URL('../..',import.meta.url));
function setup(t){const dir=mkdtempSync(join(tmpdir(),'xtxc-agent-profile-'));const s=new AgentStore(join(dir,'state.sqlite'),brief.instruments);t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});return{s,dir};}
const save=(s,profile,extra={})=>s.saveAgent(owner,{operation:'CREATE',requestId:randomUUID(),profile,...extra});
function researched(s,agentBody,checks){
  const agent=save(s,agentBody),strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,agentId:agent.id}});
  const id=s.enqueue(owner,strategy.id,goal,randomUUID()),run=s.claim();assert.equal(run.id,id);
  s.finish(run,'REVIEW',{candidates:[{id:'c1',verdict:'ELIGIBLE',weights:[{instrument:'NVDA',weightBps:2500},{instrument:'AMD',weightBps:2500}],agentChecks:checks??agent.rules.map(r=>({rule:r.id,params:r.params,status:'pass'}))}]});
  return{agent,strategy,run:s.view(owner,strategy.id).runs[0],input:run.input};
}

test('shared modules and the rule catalog are identical in the web app and the worker',()=>{
  for(const f of SHARED)assert.equal(readFileSync(root+'engine/lib/'+f,'utf8'),readFileSync(root+'web/lib/'+f,'utf8'),f);
  for(const f of ['web/lib/agent-rules.mjs','engine/lib/agent-rules.mjs'])assert.equal(readFileSync(root+f,'utf8'),catalogModule(),f);
});

test('strategies without an agent keep their brief hash',()=>{
  // Pinned with the code before agents existed (baseline 17ab831).
  assert.equal(briefHash(brief),'6228e16718f42b2837451f7645ee7dd9b564f3a641c26639d08e5948f4f5a77f');
  assert.notEqual(briefHash({...brief,agentId:randomUUID()}),briefHash(brief));
});

test('every preset is valid and goals are never looser than the agent',()=>{
  for(const [style,s] of Object.entries(AGENT_RULES.styles))for(const preset of Object.keys(s.presets)){
    const p=normalizeProfile({...presetBody('A',style,preset),schema:PROFILE_SCHEMA,id:randomUUID(),revision:1});
    assert.equal(p.approval,'PER_TRADE');
  }
  const risk={maxWeightBps:2000,minCashBps:1500,maxDrawdownBps:1000};
  assert.deepEqual(clampGoal(goal,{risk}),{...goal,maxWeightBps:2000,minCashBps:1500,maxDrawdownBps:1000});
  assert.deepEqual(clampGoal({...goal,maxWeightBps:1000,minCashBps:2000,maxDrawdownBps:500},{risk}),{...goal,maxWeightBps:1000,minCashBps:2000,maxDrawdownBps:500});
});

test('JS and Python validate and canonicalise agents the same way',{skip:!process.env.STA_PYTHON&&'STA_PYTHON not set'},()=>{
  const base={...presetBody('Trend rider'),schema:PROFILE_SCHEMA,id:'0b6a3c1e-8f0d-4c55-9a43-2f7d7f1d9a10',revision:3};
  const cases=[base,{...base,name:'  Spaced  '},{...base,rules:[{id:'max_holdings',params:{n:4.0}},{id:'near_high',params:{within:0.07}},{id:'calm_only'}]},
    {...base,rules:[{id:'lower_band',params:{z_max:-1.25}}]},{...base,rules:[{id:'oversold_only',params:{rsi_max:37}}]},{...base,rules:[{id:'golden_cross',params:{fast:50,slow:20}}]},
    {...base,rules:[{id:'uptrend_only',params:{days:150}}]},{...base,style:'value'},{...base,approval:'ALWAYS'},{...base,risk:{...base.risk,maxWeightBps:1.5}},
    {...base,rules:[{id:'uptrend_only'},{id:'uptrend_only'}]},{...base,name:'x‮y'},{...base,philosophy:'Buy what keeps rising.'}];
  const js=cases.map(c=>{try{return normalizeProfile(c);}catch{return null;}});
  const r=spawnSync(process.env.STA_PYTHON,['-c',`import json,sys
from xtxc_agent.research.agent_profile import normalize_profile
out=[]
for c in json.load(sys.stdin):
    try: out.append(normalize_profile(c))
    except ValueError: out.append(None)
print(json.dumps(out))`],{input:JSON.stringify(cases),env:{...process.env,PYTHONPATH:root+'engine/agent'},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.deepEqual(JSON.parse(r.stdout),js);
  assert.ok(js.filter(Boolean).length>=4&&js.filter(x=>x===null).length>=7);
});

test('agents are owner-scoped, versioned and idempotent',t=>{
  const{s}=setup(t),requestId=randomUUID(),body=presetBody('Dip buyer','technical','dip');
  const a=s.saveAgent(owner,{operation:'CREATE',requestId,profile:body});
  assert.equal(s.saveAgent(owner,{operation:'CREATE',requestId,profile:body}).id,a.id);
  assert.throws(()=>s.saveAgent(owner,{operation:'CREATE',requestId,profile:{...body,name:'Other'}}),/already used/);
  assert.throws(()=>s.agentProfile(s.owner(other),a.id),/not found/);
  assert.deepEqual(s.agents(other),[]);
  const b=s.saveAgent(owner,{operation:'UPDATE',requestId:randomUUID(),id:a.id,revision:1,profile:{...body,approval:'AUTO_WITHIN_LIMITS'}});
  assert.equal(b.revision,2);
  assert.throws(()=>s.saveAgent(owner,{operation:'UPDATE',requestId:randomUUID(),id:a.id,revision:1,profile:body}),/another tab/);
  assert.throws(()=>s.saveAgent(other,{operation:'UPDATE',requestId:randomUUID(),id:a.id,revision:2,profile:body}),/not found/);
  assert.throws(()=>save(s,{...body,rules:[{id:'sell_everything'}]}),/Unknown agent rule/);
  assert.throws(()=>save(s,{...body,style:'value'}),/starting style/);           // value style needs a value preset
  assert.throws(()=>save(s,{...body,style:'growth'}),/not available/);
  assert.equal(save(s,presetBody('Buffett-ish','value','quality_value')).style,'value');
  assert.throws(()=>save(s,{...body,id:randomUUID(),revision:99,name:''}),/name/);
  for(let i=2;i<10;i++)save(s,body);
  assert.throws(()=>save(s,body),/10 agents/);
});

test('research copies the current agent and clamps the goal to its limits',t=>{
  const{s}=setup(t);
  const{agent,input}=researched(s,{...presetBody('Trend rider'),risk:{maxWeightBps:2500,minCashBps:1000,maxDrawdownBps:2000}});
  assert.equal(input.agent.id,agent.id);assert.equal(input.agent.revision,1);
  assert.equal(input.goal.maxWeightBps,2500);assert.equal(input.goal.minCashBps,1000);assert.equal(input.goal.maxDrawdownBps,2000);
  const foreign=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,agentId:randomUUID()}});
  assert.throws(()=>s.enqueue(owner,foreign.id,goal,randomUUID()),/Agent not found/);
  assert.throws(()=>s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,agentId:'not-a-uuid'}}),/agents/);
});

test('changing the agent supersedes running research and blocks old approvals',t=>{
  const{s}=setup(t),body=presetBody('Trend rider');
  const agent=save(s,body),strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,agentId:agent.id}});
  s.enqueue(owner,strategy.id,goal,randomUUID());const run=s.claim();
  s.saveAgent(owner,{operation:'UPDATE',requestId:randomUUID(),id:agent.id,revision:1,profile:{...body,rebalance:'weekly'}});
  s.finish(run,'REVIEW',{candidates:[]});
  assert.equal(s.view(owner,strategy.id).runs[0].status,'SUPERSEDED');
  const r=researched(s,body);
  s.saveAgent(owner,{operation:'UPDATE',requestId:randomUUID(),id:r.agent.id,revision:1,profile:{...body,name:'Renamed'}});
  assert.throws(()=>s.approve(owner,r.run.id,'c1',r.run.result.reportHash),/agent changed/);
  assert.throws(()=>s.reviewCandidate(owner,r.run.id,'c1',r.run.result.reportHash),/agent changed/);
});

test('approval needs every agent rule to be shown as kept; the plan records the agent',t=>{
  const{s}=setup(t),body=presetBody('Trend rider');
  const missing=researched(s,body,[{rule:'uptrend_only',params:{days:200},status:'pass'}]);
  assert.throws(()=>s.approve(owner,missing.run.id,'c1',missing.run.result.reportHash),/every agent rule/);
  const failed=researched(s,body,body.rules.map(r=>({rule:r.id,params:r.params,status:'fail'})));
  assert.throws(()=>s.approve(owner,failed.run.id,'c1',failed.run.result.reportHash),/every agent rule/);
  const ok=researched(s,body),plan=s.approve(owner,ok.run.id,'c1',ok.run.result.reportHash);
  assert.deepEqual(plan.agent,{id:ok.agent.id,revision:1,name:'Trend rider',style:'technical',approval:'PER_TRADE'});
});

test('an agent that approves every trade cannot hand a plan to the agent wallet',t=>{
  const{s}=setup(t),body=presetBody('Trend rider');
  const r=researched(s,body),plan=s.approve(owner,r.run.id,'c1',r.run.result.reportHash),policy='ab'.repeat(32);
  assert.throws(()=>s.claimAutonomy(owner,plan.id,policy),/approve every trade/);
  assert.throws(()=>s.assertAutonomyAllowed(owner,plan),/approve every trade/);
  s.reserveStep(owner,plan.id,0);                                   // per-trade signing still works
  const auto=researched(s,{...body,approval:'AUTO_WITHIN_LIMITS'}),p2=s.approve(owner,auto.run.id,'c1',auto.run.result.reportHash);
  s.claimAutonomy(owner,p2.id,'cd'.repeat(32));
  // Switching the agent back to per-trade approval blocks a later Start.
  s.saveAgent(owner,{operation:'UPDATE',requestId:randomUUID(),id:auto.agent.id,revision:1,profile:{...body,approval:'PER_TRADE'}});
  assert.throws(()=>s.assertAutonomyAllowed(owner,s.plan(owner,p2.id)),/approve every trade/);
});

test('plans without an agent keep working as before',t=>{
  const{s}=setup(t),strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief});
  const id=s.enqueue(owner,strategy.id,goal,randomUUID()),run=s.claim();assert.equal(run.input.agent,undefined);assert.equal(run.id,id);
  s.finish(run,'REVIEW',{candidates:[{id:'c1',verdict:'ELIGIBLE',weights:[{instrument:'NVDA',weightBps:4500}]}]});
  const r=s.view(owner,strategy.id).runs[0],plan=s.approve(owner,r.id,'c1',r.result.reportHash);
  assert.equal(plan.agent,undefined);s.claimAutonomy(owner,plan.id,'ef'.repeat(32));
});

test('rule suggestions must quote the owner and stay inside the catalog',()=>{
  const text='I only want stocks in an uptrend, never anything overbought. Also cheap P/E ratios please.';
  const out=resolveSuggestions({rules:[
    {id:'uptrend_only',params:{days:200},evidence:'only want stocks in an uptrend'},
    {id:'not_overbought',params:{rsi_max:70},evidence:'never anything overbought'},
    {id:'not_overbought',params:{rsi_max:80},evidence:'never anything overbought'},           // repeated
    {id:'market_guard',params:{exposure:0.2},evidence:'sell when the market crashes'},        // not in the text
    {id:'oversold_only',params:{rsi_max:99},evidence:'uptrend'},                              // out of range
    {id:'buy_everything',params:{},evidence:'stocks'}],                                       // not a rule
    unsupported:['cheap P/E ratios','invented phrase']},text,'technical');
  assert.deepEqual(out.suggestions.map(s=>[s.id,s.params]),[['uptrend_only',{days:200}],['not_overbought',{rsi_max:70}]]);
  assert.deepEqual(out.unsupported,['cheap P/E ratios']);
  assert.throws(()=>resolveSuggestions({rules:[],code:'x'},text,'technical'));
});
