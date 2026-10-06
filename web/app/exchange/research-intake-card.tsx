"use client";
import type {ResearchIntake} from '@/lib/research-intake.mjs';
import {clampGoal,type AgentProfile} from '@/lib/research-agent-profile.mjs';
const pct=(bps:number)=>`${bps/100}%`;
export function ResearchIntakeCard({draft,setDraft,busy,onRun,onEdit,onCancel,agent=null,asset='USDC'}:{draft:ResearchIntake;setDraft:(v:ResearchIntake)=>void;busy:boolean;onRun:()=>void;onEdit:()=>void;onCancel:()=>void;agent?:AgentProfile|null;asset?:'USDC'|'USDT'}){
 const applied=agent?clampGoal(draft.goal,agent):null,tightened=applied&&(applied.maxWeightBps!==draft.goal.maxWeightBps||applied.minCashBps!==draft.goal.minCashBps||applied.maxDrawdownBps!==draft.goal.maxDrawdownBps);
 const field=(key:'targetReturnBps'|'horizonDays'|'maxDrawdownBps',value:number,missing:string)=>setDraft({...draft,goal:{...draft.goal,[key]:value},missing:draft.missing.filter(k=>k!==missing)});
 const ready=!draft.missing.length&&draft.brief.instruments.length>0&&Number(draft.brief.budget)>0;
 return <section className="rw-intake" aria-label="Research request"><header><b>{draft.brief.name}</b><button className="rw-link" disabled={busy} onClick={onCancel} aria-label="Dismiss research draft">×</button></header>
  {draft.universeSource==='STARTER_RESEARCH'&&<small>Starter research universe · change any stock</small>}
  <div className="rw-brief-tags">{draft.brief.instruments.map(i=><span key={i}>{i}</span>)}<button onClick={onEdit}>Edit stocks</button></div>
  <p className="rw-intake-question">{draft.missing.includes('budget')?`How much ${asset} would you like to research?`:draft.missing.includes('stocks')?'Which stocks or theme?':draft.missing.includes('target')||draft.missing.includes('horizon')?'Set the target and time horizon.':'Review the scope, then run.'}</p>
  <div className="rw-intake-fields"><label>Budget · {asset}<input aria-label={`Research budget ${asset}`} inputMode="decimal" placeholder="Enter amount" value={draft.brief.budget} onChange={e=>setDraft({...draft,brief:{...draft.brief,budget:e.target.value},missing:Number(e.target.value)>0?draft.missing.filter(x=>x!=='budget'):[...new Set([...draft.missing,'budget'])]})}/></label>
   <label>Target · %<input type="number" min="0" max="10000" step="0.1" aria-label="Research return target" value={draft.missing.includes('target')?'':draft.goal.targetReturnBps/100} onChange={e=>field('targetReturnBps',Math.round(Number(e.target.value)*100),'target')}/></label>
   <label>Period · days<input type="number" min="7" max="365" aria-label="Research period days" value={draft.missing.includes('horizon')?'':draft.goal.horizonDays} onChange={e=>field('horizonDays',Number(e.target.value),'horizon')}/></label></div>
  <details><summary>Risk & costs</summary><div className="rw-intake-fields"><label>Max. loss · %<input type="number" min="1" max="80" step="0.1" value={draft.goal.maxDrawdownBps/100} onChange={e=>field('maxDrawdownBps',Math.round(Number(e.target.value)*100),'loss')}/></label><label>Per stock · %<input type="number" min="1" max="100" value={draft.goal.maxWeightBps/100} onChange={e=>setDraft({...draft,goal:{...draft.goal,maxWeightBps:Math.round(Number(e.target.value)*100)}})}/></label><label>Cash · %<input type="number" min="0" max="95" value={draft.goal.minCashBps/100} onChange={e=>setDraft({...draft,goal:{...draft.goal,minCashBps:Math.round(Number(e.target.value)*100)}})}/></label></div><small>{draft.goal.costBps} bps one-way backtest cost assumption. A target is a research condition, not a promised return.</small></details>
  {draft.unavailable.length>0&&<small>Outside the current catalog: {draft.unavailable.join(', ')}</small>}
  {agent&&applied&&<p className="rw-intake-agent"><b>{agent.name}</b> designs this research with {agent.rules.length} enforced rule{agent.rules.length===1?'':'s'}.{tightened?` Its limits apply: max ${pct(applied.maxWeightBps)} per stock, cash ≥ ${pct(applied.minCashBps)}, loss ≤ ${pct(applied.maxDrawdownBps)}.`:''}</p>}
  <footer><span>Research only · no trade</span><button className="rw-button rw-primary" disabled={busy||!ready} onClick={onRun}>{busy?'Starting…':'Run research'}</button></footer>
 </section>;
}
