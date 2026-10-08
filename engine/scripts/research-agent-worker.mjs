import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AgentStore, briefHash } from '../lib/research-agent-core.mjs';
import { kilnProposal, AgentUnavailable, proposalMessages, reusableProposal, modelId } from '../lib/research-kiln.mjs';
import { agenticTick } from '../lib/research-agentic.mjs';
import { exitWatch } from '../lib/research-bsc-sell.mjs';
import { dirname, join } from 'node:path';
import {flushOperatingResearch} from '../lib/research-ongoing-feed.mjs';

export function evaluate(input,inspect=false,signal) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.XTXC_RESEARCH_PYTHON,[process.env.XTXC_RESEARCH_EVALUATOR,...(inspect?['--inspect']:[])],{
      env:{PATH:'/usr/bin:/bin',PYTHONPATH:process.env.XTXC_RESEARCH_PYTHONPATH,PYTHONDONTWRITEBYTECODE:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',XTXC_RESEARCH_DATA_ROOT:process.env.XTXC_RESEARCH_DATA_ROOT,XTXC_CATALOG_REPORT:process.env.XTXC_CATALOG_REPORT,XTXC_RESEARCH_DESIGNS:process.env.XTXC_RESEARCH_DESIGNS,TMPDIR:process.env.XTXC_RESEARCH_TMPDIR||'/tmp'},
      stdio:['pipe','pipe','pipe'],signal,timeout:240000,killSignal:'SIGKILL'});
    let out='',size=0;
    child.stdout.on('data',data=>{size+=data.length;if(size>2000000){child.kill('SIGKILL');return;}out+=data;});
    child.stderr.resume(); // Error messages from data libraries are not user-visible logs.
    child.on('error',()=>reject(new AgentUnavailable('FAILED','Research compute could not start.')));
    child.on('close',code=>{try{const value=JSON.parse(out);if(code!==0||value.error)throw new AgentUnavailable(String(value.error).startsWith('WAITING_DATA:')?'WAITING_DATA':'FAILED',value.error??'Research calculation failed.');resolve(value);}catch(e){reject(e instanceof AgentUnavailable?e:new AgentUnavailable('FAILED','Research result failed validation.'));}});
    child.stdin.end(JSON.stringify(input));
  });
}
// The engine's exit check (engine/compute/exit_check.py): the same stop-loss / trailing-stop definition as the
// backtest, on the same verified price release.
export function exitCheck(input) {
  return new Promise((resolve,reject)=>{
    const script=process.env.XTXC_RESEARCH_EXIT_CHECK??join(dirname(process.env.XTXC_RESEARCH_EVALUATOR??''),'exit_check.py');
    const child=spawn(process.env.XTXC_RESEARCH_PYTHON,[script,process.env.XTXC_RESEARCH_DATA_ROOT],{cwd:dirname(script),
      env:{PATH:'/usr/bin:/bin',PYTHONPATH:process.env.XTXC_RESEARCH_PYTHONPATH,PYTHONDONTWRITEBYTECODE:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'},
      stdio:['pipe','pipe','pipe'],timeout:120000,killSignal:'SIGKILL'});
    let out='';child.stdout.on('data',d=>{if(out.length<2000000)out+=d;});child.stderr.resume();
    child.on('error',()=>reject(new Error('Exit check could not start.')));
    child.on('close',code=>{try{const v=JSON.parse(out);if(code!==0||v.error)throw new Error(String(v.error??'Exit check failed.'));resolve(v);}catch(e){reject(e instanceof Error?e:new Error('Exit check failed.'));}});
    child.stdin.end(JSON.stringify(input));
  });
}
const releaseId=()=>{try{return JSON.parse(readFileSync(process.env.XTXC_RESEARCH_DATA_ROOT+'/prices/quant_release.json','utf8')).release_id;}catch{return null;}};
export async function processRun(store,run,config) {
  const abort=new AbortController();
  const timer=setInterval(()=>{
    const r=store.db.prepare('SELECT status,lease_token FROM agent_runs WHERE id=?').get(run.id);
    if(r?.status!=='RUNNING'||r.lease_token!==run.leaseToken)abort.abort();
    else store.db.prepare('UPDATE agent_runs SET lease_until=? WHERE id=? AND lease_token=?').run(Date.now()+300000,run.id,run.leaseToken);
  },5000);
  try{
    const inspected=await evaluate(run.input,true,abort.signal),designMessages=inspected.designMessages??null;
    // An unchanged prompt reuses the last validated proposal (0 tokens); a reused one that no longer evaluates gets
    // one fresh model call. A data wait does not: the design needs those prices or statistics, and the same prompt at
    // temperature 0 asks for the same design (an agent's guard is forced in either way).
    let model=reusableProposal(store,run,proposalMessages(run.input,designMessages),modelId(config))??await kilnProposal(run.input,config,store,fetch,designMessages);
    if(abort.signal.aborted)return;
    let result;
    try{result=await evaluate({...run.input,proposal:model.proposal},false,abort.signal);}
    catch(e){
      if(!model.trace.reusedFrom||abort.signal.aborted||e.stage==='WAITING_DATA')throw e;
      model=await kilnProposal(run.input,config,store,fetch,designMessages);
      if(abort.signal.aborted)return;
      result=await evaluate({...run.input,proposal:model.proposal},false,abort.signal);
    }
    result.model=model.trace;result.proposal=model.proposal;
    result.engineVersion=result.engineVersion??'xtxc-pinned-backtest-20260929';
    store.finish(run,result.decision,result);
  }catch(e){if(!abort.signal.aborted)store.finish(run,e.stage??'FAILED',null,e.message?.slice(0,350)??'Research failed.');}
  finally{clearInterval(timer);}
}
export function monitors(store) {
  let release;
  try{release=JSON.parse(readFileSync(process.env.XTXC_RESEARCH_DATA_ROOT+'/prices/quant_release.json','utf8')).release_id;}catch{return;}
  for(const row of store.db.prepare('SELECT * FROM agent_monitors WHERE next_at<=? LIMIT 20').all(Date.now())){
    const m=JSON.parse(row.document);
    store.db.prepare('UPDATE agent_monitors SET next_at=? WHERE owner=? AND strategy=?').run(Date.now()+900000,row.owner,row.strategy);
    if(!m.enabled)continue;
    if(m.expiresAt!==0&&m.expiresAt<=Date.now()){m.enabled=false;m.reason='EXPIRED';store.db.prepare('UPDATE agent_monitors SET document=? WHERE owner=? AND strategy=?').run(JSON.stringify(m),row.owner,row.strategy);continue;}
    const strategy=store.get(row.owner,row.strategy);
    if(briefHash(strategy)!==m.briefHash){m.enabled=false;m.reason='BRIEF_CHANGED';}
    else if(m.lastRelease!==release||(m.mode==='CONTINUOUS_TRADING'&&Date.now()-(m.lastResearchAt??0)>m.maxResearchAgeMs/2)){
      if(store.db.prepare("SELECT id FROM agent_runs WHERE owner=? AND strategy=? AND status IN ('QUEUED','RUNNING','WAITING_DATA','WAITING_MODEL')").get(row.owner,row.strategy))continue;
      try{m.lastRunId=store.enqueue(m.owner,row.strategy,m.goal,randomUUID());m.lastRelease=release;m.lastResearchAt=Date.now();store.event(row.owner,row.strategy,'MONITOR_RESEARCH',{runId:m.lastRunId});}catch{continue;}
    }
    store.db.prepare('UPDATE agent_monitors SET document=? WHERE owner=? AND strategy=?').run(JSON.stringify(m),row.owner,row.strategy);
  }
}
// Calls the BNB gateway (Binance Web3 API + Agentic Wallet), which runs in a permitted region.
export async function gatewayCall(method,path,body){
  const r=await fetch(process.env.XTXC_BNB_GATEWAY_URL+path,{method,headers:{Authorization:`Bearer ${process.env.XTXC_BNB_GATEWAY_TOKEN}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(130000)});
  const j=await r.json().catch(()=>null);if(r.ok&&j&&'data' in j)return j.data;
  // The gateway's error code (MARKET, PRICE, AGENTIC_UNKNOWN …) and any order id travel with the error.
  throw Object.assign(new Error(j?.error?.message??`Gateway HTTP ${r.status}`),{code:j?.error?.code??null,status:r.status,orderId:j?.error?.orderId??null});
}
async function main() {
  const store=new AgentStore(process.env.XTXC_RESEARCH_DB,[]);
  let stopping=false,exitAt=0;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  // Agentic orders settle on their own timer, so a research run (minutes) never holds them up; one tick at a time.
  let ticking=false;
  const tick=async()=>{if(ticking||!process.env.XTXC_BNB_GATEWAY_URL)return;ticking=true;
    try{await agenticTick(store,gatewayCall);}catch(e){process.stderr.write(`Agentic tick failed: ${String(e?.message??'').slice(0,200)}\n`);}finally{ticking=false;}};
  const timer=setInterval(()=>{void tick();},5000);
  while(!stopping){
    try{await flushOperatingResearch(store);monitors(store);await tick();const run=store.claim();if(run)await processRun(store,run,process.env);await flushOperatingResearch(store);}
    catch{process.stderr.write('Research worker cycle failed; no transaction was sent.\n');}
    // Daily exit rules (once per price release). A failure retries after 10 minutes; nothing is sent from here
    // except Agentic Wallet sales of an agent allowed to trade on its own (through agenticTick on the next cycle).
    if(process.env.XTXC_BNB_GATEWAY_URL&&Date.now()>=exitAt){
      try{const r=await exitWatch(store,{gw:gatewayCall,check:exitCheck,release:releaseId()});exitAt=Date.now()+(r?.retry?600000:60000);}
      catch(e){exitAt=Date.now()+600000;process.stderr.write(`Exit check failed; it retries later. ${String(e?.message??'').slice(0,160)}\n`);}
    }
    if(process.argv.includes('--once'))break;
    await new Promise(r=>setTimeout(r,3000));
  }
  clearInterval(timer);while(ticking)await new Promise(r=>setTimeout(r,200));
  store.close();
}
if(process.argv[1]?.endsWith('research-agent-worker.mjs'))await main();
