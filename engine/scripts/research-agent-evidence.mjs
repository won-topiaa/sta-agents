// Bounded real-provider research check. No wallet/RPC/signing code is imported.
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve, relative } from 'node:path';
import { AgentStore } from '../lib/research-agent-core.mjs';
import { processRun } from './research-agent-worker.mjs';
const dir=process.env.XTXC_RESEARCH_EVIDENCE;
const root=resolve('.local/evidence');
if(!dir||!isAbsolute(dir)||resolve(dir)===root||relative(root,resolve(dir)).startsWith('..')||isAbsolute(relative(root,resolve(dir))))throw new Error('Use an absolute, isolated subdirectory of .local/evidence. This check makes paid model calls.');
mkdirSync(dir,{recursive:true});chmodSync(dir,0o700);
const s=new AgentStore(dir+'/state.sqlite',['NVDA','AMD','QQQ']);
const owner='solana:'+'1'.repeat(32),base={targetReturnBps:500,horizonDays:365,maxDrawdownBps:3500,maxWeightBps:4000,minCashBps:2000,costBps:50};
const summaries=[];
for(const [label,goal] of [['ordinary',base],['extreme',{...base,targetReturnBps:100000}]]){
  const strategy=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{name:label,objective:'Compare long-only stock strategies after costs and drawdown. Refuse unsupported targets.',budget:'100',instruments:['NVDA','AMD','QQQ'],weights:[],cashBps:null}});
  s.enqueue(owner,strategy.id,goal,randomUUID());const run=s.claim();await processRun(s,run,process.env);
  const r=s.view(owner,strategy.id).runs[0];writeFileSync(dir+'/'+label+'.json',JSON.stringify(r,null,2));
  summaries.push({label,status:r.status,error:r.error,model:r.result?.model,dataset:r.result?.dataset,candidates:r.result?.candidates.map(c=>({id:c.id,verdict:c.verdict,reasons:c.reasons,medianBps:c.horizonMedianBps,drawdownBps:c.holdoutDrawdownBps}))});
}
writeFileSync(dir+'/summary.json',JSON.stringify(summaries,null,2));
console.log(JSON.stringify(summaries));s.close();
