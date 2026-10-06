import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AgentStore, briefHash } from '../lib/research-agent-core.mjs';
import { kilnProposal, AgentUnavailable } from '../lib/research-kiln.mjs';
import { agenticTick } from '../lib/research-agentic.mjs';

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
export async function processRun(store,run,config) {
  const abort=new AbortController();
  const timer=setInterval(()=>{
    const r=store.db.prepare('SELECT status,lease_token FROM agent_runs WHERE id=?').get(run.id);
    if(r?.status!=='RUNNING'||r.lease_token!==run.leaseToken)abort.abort();
    else store.db.prepare('UPDATE agent_runs SET lease_until=? WHERE id=? AND lease_token=?').run(Date.now()+300000,run.id,run.leaseToken);
  },5000);
  try{
    const inspected=await evaluate(run.input,true,abort.signal);
    const model=await kilnProposal(run.input,config,store,fetch,inspected.designMessages??null);
    if(abort.signal.aborted)return;
    const result=await evaluate({...run.input,proposal:model.proposal},false,abort.signal);
    result.model=model.trace;result.proposal=model.proposal;
    result.engineVersion=result.engineVersion??'xtxc-pinned-backtest-20260929';
    store.finish(run,result.decision,result);
  }catch(e){if(!abort.signal.aborted)store.finish(run,e.stage??'FAILED',null,e.message?.slice(0,350)??'Research failed.');}
  finally{clearInterval(timer);}
}
function monitors(store) {
  let release;
  try{release=JSON.parse(readFileSync(process.env.XTXC_RESEARCH_DATA_ROOT+'/prices/quant_release.json','utf8')).release_id;}catch{return;}
  for(const row of store.db.prepare('SELECT * FROM agent_monitors WHERE next_at<=? LIMIT 20').all(Date.now())){
    const m=JSON.parse(row.document);
    store.db.prepare('UPDATE agent_monitors SET next_at=? WHERE owner=? AND strategy=?').run(Date.now()+900000,row.owner,row.strategy);
    if(!m.enabled)continue;
    if(m.expiresAt<=Date.now()){m.enabled=false;m.reason='EXPIRED';store.db.prepare('UPDATE agent_monitors SET document=? WHERE owner=? AND strategy=?').run(JSON.stringify(m),row.owner,row.strategy);continue;}
    const strategy=store.get(row.owner,row.strategy);
    if(briefHash(strategy)!==m.briefHash){m.enabled=false;m.reason='BRIEF_CHANGED';}
    else if(m.lastRelease!==release){
      try{m.lastRunId=store.enqueue(m.owner,row.strategy,m.goal,randomUUID());m.lastRelease=release;store.event(row.owner,row.strategy,'MONITOR_RESEARCH',{runId:m.lastRunId});}catch{continue;}
    }
    store.db.prepare('UPDATE agent_monitors SET document=? WHERE owner=? AND strategy=?').run(JSON.stringify(m),row.owner,row.strategy);
  }
}
// Calls the BNB gateway (Binance Web3 API + Agentic Wallet), which runs in a permitted region.
export async function gatewayCall(method,path,body){
  const r=await fetch(process.env.XTXC_BNB_GATEWAY_URL+path,{method,headers:{Authorization:`Bearer ${process.env.XTXC_BNB_GATEWAY_TOKEN}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(130000)});
  const j=await r.json().catch(()=>null);if(r.ok&&j&&'data' in j)return j.data;
  throw new Error(j?.error?.message??`Gateway HTTP ${r.status}`);
}
async function main() {
  const store=new AgentStore(process.env.XTXC_RESEARCH_DB,[]);
  let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  while(!stopping){
    try{monitors(store);if(process.env.XTXC_BNB_GATEWAY_URL)await agenticTick(store,gatewayCall);const run=store.claim();if(run)await processRun(store,run,process.env);}
    catch{process.stderr.write('Research worker cycle failed; no transaction was sent.\n');}
    if(process.argv.includes('--once'))break;
    await new Promise(r=>setTimeout(r,3000));
  }
  store.close();
}
if(process.argv[1]?.endsWith('research-agent-worker.mjs'))await main();
