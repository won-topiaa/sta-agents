// Compile once, decide in code: an unchanged design prompt reuses the last validated proposal instead of a model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '../lib/research-agent-core.mjs';
import { reusableProposal, proposalMessages, REUSE_MAX_AGE_MS } from '../lib/research-kiln.mjs';
import { processRun } from '../scripts/research-agent-worker.mjs';

const owner='solana:'+'1'.repeat(32);
const brief={name:'Reuse run',objective:'Chip stocks for a year.',budget:'100',instruments:['NVDA','AMD'],weights:[],cashBps:null};
const goal={targetReturnBps:1000,horizonDays:365,maxDrawdownBps:2000,maxWeightBps:5000,minCashBps:1000,costBps:50};
const config={KILN_API_KEY:'test-only-not-a-secret',KILN_BASE_URL:'https://api.bricksum.com/v1',KILN_MODEL_ID:'qwen3-32b'};
// A stand-in evaluator: --inspect returns a fixed design prompt; a full run fails or waits when a marker file says so.
const EVALUATOR=`import {readFileSync,existsSync} from 'node:fs';
const dir=new URL('.',import.meta.url).pathname,input=JSON.parse(readFileSync(0,'utf8'));
if(process.argv.includes('--inspect'))console.log(JSON.stringify({designMessages:[{role:'system',content:'design system'},{role:'user',content:'chips '+input.strategy.objective}]}));
else if(existsSync(dir+'WAIT'))console.log(JSON.stringify({error:'WAITING_DATA: prices are out of date.'}));
else if(existsSync(dir+'FAIL')&&input.proposal.designs.candidates[0].tag===1)console.log(JSON.stringify({error:'design no longer valid'}));
else console.log(JSON.stringify({decision:'REVIEW',candidates:[],dataset:{asOf:'2026-10-07'},tag:input.proposal.designs.candidates[0].tag}));`;

function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'xtxc-reuse-test-'));writeFileSync(join(dir,'evaluate.mjs'),EVALUATOR);
  const s=new AgentStore(join(dir,'state.sqlite'),brief.instruments),strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief});
  const env={py:process.env.XTXC_RESEARCH_PYTHON,ev:process.env.XTXC_RESEARCH_EVALUATOR},realFetch=globalThis.fetch;
  process.env.XTXC_RESEARCH_PYTHON=process.execPath;process.env.XTXC_RESEARCH_EVALUATOR=join(dir,'evaluate.mjs');
  const kiln={calls:0,proposals:0};
  globalThis.fetch=async url=>{kiln.calls++;
    if(String(url).endsWith('/models'))return Response.json({data:[{id:'qwen3-32b'}]});
    return Response.json({usage:{prompt_tokens:100,completion_tokens:50},choices:[{message:{content:JSON.stringify({candidates:[{tag:++kiln.proposals}]})}}]});};
  t.after(()=>{globalThis.fetch=realFetch;process.env.XTXC_RESEARCH_PYTHON=env.py;process.env.XTXC_RESEARCH_EVALUATOR=env.ev;s.close();rmSync(dir,{recursive:true,force:true});});
  const run=async(cfg=config)=>{const id=s.enqueue(owner,strategy.id,goal,randomUUID()),r=s.claim();assert.equal(r.id,id);await processRun(s,r,cfg);
    const row=s.db.prepare('SELECT status,result FROM agent_runs WHERE id=?').get(id);return {id,status:row.status,result:row.result?JSON.parse(row.result):null,claimed:r};};
  return {s,strategy,dir,kiln,run};
}

test('an unchanged prompt reuses the last validated proposal with no model call; the engine still re-tests it',async t=>{
  const {kiln,run}=setup(t);
  const first=await run();
  assert.equal(first.status,'REVIEW');assert.equal(kiln.calls,2);assert.equal(first.result.model.inputTokens,100);assert.equal(first.result.model.reusedFrom,undefined);
  const second=await run();
  assert.equal(second.status,'REVIEW');assert.equal(kiln.calls,2,'no model call');
  assert.equal(second.result.model.reusedFrom,first.id);assert.equal(second.result.model.inputTokens+second.result.model.outputTokens,0);
  assert.deepEqual(second.result.proposal,first.result.proposal);assert.equal(second.result.tag,1,'evaluated again');
  const third=await run();
  assert.equal(third.result.model.reusedFrom,first.id,'points at the run that called the model');assert.equal(kiln.calls,2);
});

test('a reused proposal that no longer evaluates gets one fresh model call; a data wait never calls the model',async t=>{
  const {kiln,run,dir}=setup(t);
  const first=await run();assert.equal(kiln.calls,2);
  writeFileSync(join(dir,'FAIL'),'');
  const retried=await run();
  assert.equal(retried.status,'REVIEW');assert.equal(kiln.calls,4);assert.equal(retried.result.model.reusedFrom,undefined);assert.equal(retried.result.tag,2);
  rmSync(join(dir,'FAIL'));writeFileSync(join(dir,'WAIT'),'');
  const waiting=await run();
  assert.equal(waiting.status,'WAITING_DATA');assert.equal(kiln.calls,4,'no model call while data is stale');
  assert.notEqual(first.id,retried.id);
});

test('reuse needs the same strategy, prompt and model, a recent completed run and an intact proposal',async t=>{
  const {s,strategy,kiln,run}=setup(t);
  const first=await run(),messages=proposalMessages({strategy:first.claimed.input.strategy,goal},[{role:'system',content:'design system'},{role:'user',content:'chips '+brief.objective}]);
  const probe={owner:first.claimed.owner,strategy:strategy.id,id:'probe'};
  assert.equal(reusableProposal(s,probe,messages,'qwen3-32b').trace.reusedFrom,first.id);
  assert.equal(reusableProposal(s,probe,[...messages.slice(0,1),{role:'user',content:'other words'}],'qwen3-32b'),null);
  assert.equal(reusableProposal(s,probe,messages,'another-model'),null);
  assert.equal(reusableProposal(s,{...probe,strategy:randomUUID()},messages,'qwen3-32b'),null);
  assert.equal(reusableProposal(s,{...probe,owner:'someone-else'},messages,'qwen3-32b'),null);
  assert.equal(reusableProposal(s,probe,messages,'qwen3-32b',Date.now()+REUSE_MAX_AGE_MS+60000),null);
  const res=first.result;s.db.prepare('UPDATE agent_runs SET result=? WHERE id=?').run(JSON.stringify({...res,proposal:{...res.proposal,rebalance:'weekly'}}),first.id);
  assert.equal(reusableProposal(s,probe,messages,'qwen3-32b'),null,'an altered proposal is not reused');
  s.db.prepare('UPDATE agent_runs SET result=? WHERE id=?').run(JSON.stringify(res),first.id);
  // the limit counts from the model's original answer, not from the last reuse
  const second=await run();assert.equal(second.result.model.reusedFrom,first.id);assert.equal(second.result.model.proposedAt,first.result.model.proposedAt);
  const old=Date.now()-REUSE_MAX_AGE_MS-60000;
  s.db.prepare('UPDATE agent_runs SET updated_at=? WHERE id=?').run(old,first.id);
  s.db.prepare('UPDATE agent_runs SET result=? WHERE id=?').run(JSON.stringify({...second.result,model:{...second.result.model,proposedAt:old}}),second.id);
  assert.equal(reusableProposal(s,probe,messages,'qwen3-32b'),null,'a 30-day-old design is asked for again');
  assert.equal(kiln.calls,2);
});
