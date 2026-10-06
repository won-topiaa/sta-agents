"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { defaultGoal, type ResearchGoal, type AgentReply, type AgentRun, type AgentPlan, type ResearchCandidate, type RebalanceDraft, type ResearchLeg } from '@/lib/research-agent-types';
import {ResearchAnchor} from './research-anchor-panel';
import {ResearchAutonomyPanel} from './research-autonomy-panel';
import {AgentChecks} from './research-agent-profile';
import {BscPlanExecution,AgenticPanel} from './research-bsc-execution';
import type { ResearchStrategy } from '@/lib/research-workspace';
import { assertPreparedReview, wireBytes, saveAttempt, ATTEMPT_EVENT, type PreparedTrade } from '@/lib/stock-trade-review';
import { sameTransactionMessage } from '@/lib/stock-order-state';
import { ensureResearchSession, researchPrincipalOf } from './research-session';
import './research-agent-panel.css';

const endpoint='/api/v1/stocklana/research/agent';
const pct=(bps:number)=>`${(bps/100).toLocaleString('en-US',{maximumFractionDigits:2})}%`;
const usd=(atoms:string)=>(Number(atoms)/1e6).toLocaleString('en-US',{style:'currency',currency:'USD'});
const legAmount=(leg:ResearchLeg)=>leg.side==='SELL'?`${(Number(leg.inputAtoms)/10**(leg.inputDecimals??0)).toLocaleString('en-US',{maximumFractionDigits:9})} tokens`:usd(leg.inputAtoms);
const active=(r?:AgentRun)=>Boolean(r&&['QUEUED','RUNNING','WAITING_DATA','WAITING_MODEL'].includes(r.status));
const labels:Record<string,string>={QUEUED:'Queued',RUNNING:'Researching',WAITING_DATA:'Waiting for data',WAITING_MODEL:'Waiting for Kiln',REVIEW:'Ready to review',DECLINED:'Target not supported',CANCELLED:'Cancelled',SUPERSEDED:'Brief changed',FAILED:'Run needs attention'};

export function useResearchAgent(wallet:string|null,strategy:ResearchStrategy|null){
  const [data,setData]=useState<AgentReply|null>(null),[goal,setGoal]=useState<ResearchGoal>(defaultGoal),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const current=useRef(''),live=useRef(true),flight=useRef(false),goalLoaded=useRef('');const id=strategy?.id??'';current.current=`${wallet}:${id}`;
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{setData(null);setGoal(defaultGoal());setError(null);},[wallet,id]);
  const refresh=useCallback(async()=>{
    if(!wallet||!id)return;const key=`${wallet}:${id}`;
    try{const r=await fetch(`${endpoint}?id=${id}`,{cache:'no-store',headers:{'X-Skew-Expected-Requester':researchPrincipalOf(wallet)},signal:AbortSignal.timeout(10000)});const b=await r.json();if(current.current!==key||!live.current)return;if(r.ok&&b.owner===researchPrincipalOf(wallet)){setData(b);if(goalLoaded.current!==key){goalLoaded.current=key;if(b.runs?.[0]?.goal)setGoal(b.runs[0].goal);}}}
    catch{/* Preserve the last report; never replace it with fabricated progress. */}
  },[wallet,id]);
  useEffect(()=>{void refresh();const t=setInterval(()=>{if(!document.hidden)void refresh();},active(data?.runs[0])?3000:15000);return()=>clearInterval(t);},[refresh,data?.runs[0]?.status]);
  const act=async(payload:Record<string,unknown>)=>{
    if(!wallet||!id||flight.current)return null;const key=current.current;flight.current=true;setBusy(true);setError(null);
    try{await ensureResearchSession(wallet);if(current.current!==key)return null;const r=await fetch(endpoint,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Skew-Expected-Requester':researchPrincipalOf(wallet)},body:JSON.stringify(payload),signal:AbortSignal.timeout(payload.operation==='REVIEW_REBALANCE'?90000:30000)});const b=await r.json();if(current.current!==key||!live.current)return null;if(!r.ok)throw new Error(b.error?.message??'Request was not completed.');await refresh();return b;}
    catch(e){if(live.current&&current.current===key)setError(e instanceof Error?e.message:'Request failed.');return null;}
    finally{flight.current=false;if(live.current)setBusy(false);}
  };
  return{data,goal,setGoal,busy,error,refresh,act,run:data?.runs[0],running:active(data?.runs[0]),start:()=>act({operation:'RUN',strategyId:id,goal,requestId:crypto.randomUUID()})};
}
export type AgentController=ReturnType<typeof useResearchAgent>;

export function ResearchRunControls({agent,strategy,onResults}:{agent:AgentController;strategy:ResearchStrategy;onResults:()=>void}){
  const {goal,setGoal,run}=agent;
  const field=(key:keyof ResearchGoal,label:string,scale=1,min=0,max=10000)=><label>{label}<input type="number" step={scale===100?'0.1':'1'} min={min} max={max} value={goal[key]/scale} onChange={e=>setGoal({...goal,[key]:Math.round(Number(e.target.value)*scale)})}/></label>;
  return <section className="ra-controls" aria-label="Research target">
    <div className="ra-goals">{field('targetReturnBps','Target · %',100,0,10000)}<label>Over<select value={goal.horizonDays} onChange={e=>setGoal({...goal,horizonDays:Number(e.target.value)})}><option value={30}>1 month</option><option value={90}>3 months</option><option value={180}>6 months</option><option value={365}>1 year</option></select></label>{field('maxDrawdownBps','Max. loss · %',100,1,80)}</div>
    <details className="ra-limits"><summary>Limits & costs</summary><div className="ra-goals">{field('maxWeightBps','Per stock · %',100,1,100)}{field('minCashBps','Cash · %',100,0,95)}{field('costBps','Cost · bps',1,1,500)}</div><small>Cost is a backtest assumption per buy/sell. Actual quotes and network costs are checked before signing.</small></details>
    <div className="ra-run-actions"><span>${strategy.budget} {agent.data?.owner.startsWith('eip155:56:')?'USDT':'USDC'}</span>{agent.running?<><button disabled={agent.busy} onClick={()=>void agent.act({operation:'CANCEL',runId:run!.id})}>Cancel</button><button onClick={onResults}>{labels[run!.status]}</button></>:<button className="ra-primary" disabled={agent.busy} onClick={()=>{onResults();void agent.start();}}>{agent.busy?'Saving…':'Run research'}</button>}</div>
    {agent.error&&<p className="ra-error" role="alert">{agent.error}</p>}
    {run?.result&&<button className="ra-run-note" onClick={onResults}><b>{labels[run.status]}</b><span>{run.result.explanation}</span></button>}
  </section>;
}

function Curve({candidate}:{candidate:ResearchCandidate}){
  const c=candidate.curve,values=c.strategy;if(values.length<2)return null;
  const low=Math.min(...values,...c.benchmark.filter(v=>Number.isFinite(v))),high=Math.max(...values,...c.benchmark.filter(v=>Number.isFinite(v))),span=high-low||1;
  const path=(series:number[])=>series.map((v,i)=>`${i?'L':'M'}${(i/(series.length-1)*600).toFixed(1)},${(145-(v-low)/span*130).toFixed(1)}`).join(' ');
  return <figure className="ra-curve"><svg viewBox="0 0 600 160" role="img" aria-label={`${candidate.name} historical equity; benchmark shown in gray`}><path d="M0 145H600" stroke="#292929"/>{c.benchmark.length>1&&<path d={path(c.benchmark)} fill="none" stroke="#555" strokeWidth="1.5"/>}<path d={path(values)} fill="none" stroke="#e7e7e7" strokeWidth="2"/></svg><figcaption><span>{c.dates[0]}</span><span>Backtest · QQQ benchmark</span><span>{c.dates.at(-1)}</span></figcaption></figure>;
}
const reasonLabels:Record<string,string>={TARGET_NOT_SUPPORTED:'Return target not supported',DRAWDOWN_LIMIT_EXCEEDED:'Loss limit exceeded',NON_POSITIVE_HOLDOUT_RETURN:'No positive held-out return',COST_STRESS_FAILED:'Failed doubled-cost test',NO_CURRENT_ALLOCATION:'No current stock allocation',DESIGN_STABILITY_NEEDS_REVIEW:'Strategy stability needs review',FUTURE_DATA_LEAKAGE:'Future-data check failed',AGENT_RULE_NOT_ENFORCED:'Agent rule not enforced'};
export function ResearchResults({agent,onActivity}:{agent:AgentController;onActivity:()=>void}){
  const run=agent.run;
  const wallet=agent.data?.owner.replace(/^solana:/,'');
  const bsc=Boolean(agent.data?.owner.startsWith('eip155:56:'));
  const [draft,setDraft]=useState<RebalanceDraft|null>(null);
  const [selectedCandidate,setSelectedCandidate]=useState<string|null>(null);
  useEffect(()=>{setDraft(null);setSelectedCandidate(null);},[run?.id,agent.data?.owner]);
  if(!run)return <div className="ra-empty"><h3>Set a target. Test the possibilities.</h3><p>Your strategies and their results will appear here.</p></div>;
  if(!run.result)return <div className="ra-empty" aria-live="polite"><h3>{labels[run.status]??run.status}</h3><p>{run.error??'Checking the available data, then comparing three strategies after costs.'}</p><small>{new Date(run.createdAt).toLocaleString()}</small></div>;
  const r=run.result;
  const candidate=r.candidates.find(c=>c.id===selectedCandidate)??r.candidates.find(c=>c.verdict==='ELIGIBLE')??r.candidates[0];
  return <div className="ra-results"><header><h3>{labels[run.status]}</h3><p>{r.explanation}</p><small>{pct(run.goal.targetReturnBps)} target / {run.goal.horizonDays} days · Max. loss {pct(run.goal.maxDrawdownBps)}{r.agent&&<> · Designed by {r.agent.name}</>}</small></header>
    <div className="ra-compare" role="group" aria-label="Compare strategies">{r.candidates.map(c=><button key={c.id} aria-pressed={candidate?.id===c.id} onClick={()=>setSelectedCandidate(c.id)}><b>{c.name}</b><span>{c.verdict==='ELIGIBLE'?'Within your limits':'Outside your limits'}</span><small>{pct(c.holdoutDrawdownBps)} max. drawdown</small></button>)}</div>
    {(candidate?[candidate]:[]).map(c=><article className="ra-candidate" key={c.id}><div className="ra-candidate-heading"><h4>{c.name}</h4><span>{c.verdict==='ELIGIBLE'?'Review':'Not suitable'}</span></div><Curve candidate={c}/><dl className="ra-metrics"><div><dt>Historical horizon median</dt><dd>{pct(c.horizonMedianBps)}</dd></div><div><dt>Held-out max. drawdown</dt><dd>{pct(c.holdoutDrawdownBps)}</dd></div><div><dt>After doubled costs</dt><dd>{pct(c.stressHorizonMedianBps)}</dd></div></dl><div className="ra-weights">{c.weights.map(w=><span key={w.instrument}>{w.instrument} {pct(w.weightBps)}</span>)}<span>Cash {pct(c.cashBps)}</span></div>{c.agentChecks&&<AgentChecks checks={c.agentChecks} agentName={r.agent?.name}/>}{c.reasons.length>0&&<p className="ra-caption">{c.reasons.map(x=>reasonLabels[x]??x).join(' · ')}</p>}
      <details><summary>Method & evidence</summary><p>{r.method}</p><p>{c.windowCount} non-overlapping windows, held out from {c.holdoutStart}. The median is a past observation, not an expected return.</p><p>{r.dataset.limitations.join(' ')}</p><code>Report {r.reportHash}</code><code>Dataset {r.dataset.id}</code></details>
      {c.verdict==='ELIGIBLE'&&<div className="ra-inline-actions"><button className="ra-primary" disabled={agent.busy} onClick={async()=>{const b=await agent.act({operation:'APPROVE',runId:run.id,candidateId:c.id,reportHash:r.reportHash});if(b)onActivity();}}>Approve new investment</button>{!bsc&&<><button disabled={agent.busy} onClick={async()=>{const b=await agent.act({operation:'REVIEW_REBALANCE',walletScope:'AGENT_WALLET',runId:run.id,candidateId:c.id,reportHash:r.reportHash});if(b)setDraft(b.draft);}}>Use agent holdings</button><button className="ra-text" disabled={agent.busy} onClick={async()=>{const b=await agent.act({operation:'REVIEW_REBALANCE',walletScope:'PERSONAL',runId:run.id,candidateId:c.id,reportHash:r.reportHash});if(b)setDraft(b.draft);}}>Personal wallet holdings</button></>}</div>}
      {draft?.candidateId===c.id&&<section className="ra-allocation-review" aria-label="Rebalance review"><h4>Rebalance selected stocks</h4><p>{usd(draft.heldValueAtoms)} already held · {usd(draft.portfolioValueAtoms)} total allocation</p><small>Other stocks stay untouched. Sales run first. {draft.snapshot?.owner&&draft.snapshot.owner!==wallet?'Review the full allocation, then approve your agent wallet.':'Review each transaction in your wallet.'}</small><div className="ra-trade-legs">{draft.legs.map((leg,i)=><div key={i}><span>{leg.side} {leg.instrument}</span><b>{legAmount(leg)}</b></div>)}</div><p>{usd(draft.cashAtoms)} retained as cash</p><button className="ra-primary" disabled={agent.busy} onClick={async()=>{const b=await agent.act({operation:'APPROVE',runId:run.id,candidateId:c.id,reportHash:r.reportHash,draftId:draft.id});if(b){setDraft(null);onActivity();}}}>Approve this allocation</button></section>}
    </article>)}
    <footer className="ra-provenance"><span>{r.model.provider} · {r.model.model}</span><span>{r.model.inputTokens+r.model.outputTokens} tokens · Data through {r.dataset.asOf}</span></footer>
  </div>;
}

export function ResearchPlanExecution({agent,wallet,strategy,onRefresh}:{agent:AgentController;wallet:string|null;strategy:ResearchStrategy;onRefresh:()=>void}){
  const [signing,setSigning]=useState(false),[error,setError]=useState<string|null>(null),[boundPlans,setBoundPlans]=useState<Record<string,boolean>>({});
  const live=useRef(true),context=useRef('');context.current=`${wallet}:${strategy.id}`;
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  async function buy(plan:AgentPlan,index:number){
    if(!wallet||signing)return;const current=context.current;setSigning(true);setError(null);
    try{
      const response=await agent.act({operation:'PREPARE',planId:plan.id,index});if(!response)return;
      const p=response.prepared as PreparedTrade;
      if(!live.current||context.current!==current)throw new Error('The selected account or strategy changed.');
      assertPreparedReview(p,wallet,p.quoteId);if(!p.submitAllowed)throw new Error('The trading service has not enabled this transaction.');
      const {getWallets}=await import('@wallet-standard/app');
      const w=getWallets().get().find(w=>w.accounts.some(a=>a.address===wallet)),account=w?.accounts.find(a=>a.address===wallet);
      const feature=w?.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction']|undefined;
      if(!account||!feature||!feature.supportedTransactionVersions.includes(0))throw new Error('Connect a wallet that supports this Solana transaction.');
      const outputs=await feature.signTransaction({account,transaction:wireBytes(p.transactionBase64),chain:'solana:mainnet'});
      if(outputs.length!==1||!sameTransactionMessage(wireBytes(p.transactionBase64),outputs[0].signedTransaction))throw new Error('The wallet changed the transaction. Nothing was sent.');
      const signedTransactionBase64=btoa(String.fromCharCode(...outputs[0].signedTransaction));
      saveAttempt(sessionStorage,{schema:'xtxc.signed-stock-attempt/v1',network:'mainnet-beta',owner:wallet,preparedId:p.preparedId,quoteId:p.quoteId,instrument:plan.legs[index].instrument,side:plan.legs[index].side??'BUY',expiresAt:p.expiresAt,savedAt:new Date().toISOString(),unsignedTransactionBase64:p.transactionBase64,signedTransactionBase64});window.dispatchEvent(new Event(ATTEMPT_EVENT));
      if(!live.current||context.current!==current)throw new Error('Account changed. The signed transaction was saved but not sent.');
      const result=await agent.act({operation:'SUBMIT',planId:plan.id,index,signedTransactionBase64});if(result)onRefresh();
    }catch(e){if(live.current)setError(e instanceof Error?e.message:'Trade was not completed.');}
    finally{if(live.current)setSigning(false);}
  }
  const plans=agent.data?.plans??[];
  const pending=plans.filter(p=>(p as AgentPlan&{executionMode?:string}).executionMode!=='AGENT_WALLET'&&!boundPlans[p.id]).flatMap(p=>p.steps.filter(s=>['UNKNOWN','SUBMITTED','FINALIZED'].includes(s.phase)).map(s=>({planId:p.id,index:s.index})));
  const pendingKey=pending.map(p=>`${p.planId}:${p.index}`).join(',');
  useEffect(()=>{
    if(!pendingKey)return;
    const timer=setInterval(()=>{if(!document.hidden&&!signing&&!agent.busy){const p=pending[0];if(p)void agent.act({operation:'CHECK',...p}).then(()=>onRefresh());}},5000);
    return()=>clearInterval(timer);
  },[pendingKey,signing,agent.busy]);
  return <section className="ra-execution">
    <div className="ra-inline-actions"><a className="ra-text" href="/exchange/agent-wallet">Agent wallet ↗</a></div>
    {plans.length===0&&<p className="ra-caption">Approve a researched strategy to review its purchases here.</p>}
    {plans.map(p=>{
      if(p.chain==='eip155:56'&&wallet)return <article key={p.id} className="ra-plan">
        <div className="ra-candidate-heading"><h4>{p.candidateId.replaceAll('_',' ')}{p.agent&&<small> · {p.agent.name}</small>}</h4><span>{p.status}</span></div>
        <p>{(Number(BigInt(p.budgetAtoms)/10n**12n)/1e6).toLocaleString('en-US')} USDT budget on BNB Chain · {(Number(BigInt(p.cashAtoms)/10n**12n)/1e6).toLocaleString('en-US')} USDT stays in cash</p>
        {p.belowMinimum?.length?<p className="ra-caption">Below the 5 USDT minimum order, kept in cash: {p.belowMinimum.join(', ')}</p>:null}
        <AgenticPanel plan={p} wallet={wallet} onRefresh={()=>{void agent.refresh();onRefresh();}}/>
        <BscPlanExecution plan={p} agent={agent} wallet={wallet} onRefresh={()=>{void agent.refresh();onRefresh();}}/>
        {['APPROVED','PARTIAL','UNKNOWN'].includes(p.status)&&<button className="ra-text" disabled={agent.busy} onClick={()=>void agent.act({operation:'REVOKE',planId:p.id})}>Revoke remaining trades</button>}
      </article>;
      const assigned=boundPlans[p.id]||(p as AgentPlan&{executionMode?:string}).executionMode==='AGENT_WALLET';
      return <article key={p.id} className="ra-plan">
        <div className="ra-candidate-heading"><h4>{p.candidateId.replaceAll('_',' ')}</h4><span>{p.status}</span></div>
        <p>{usd(p.budgetAtoms)} additional cash{p.heldValueAtoms?` + ${usd(p.heldValueAtoms)} selected holdings`:''} · {usd(p.cashAtoms)} stays in USDC</p>
        <ResearchAutonomyPanel plan={p} wallet={wallet} onBound={()=>setBoundPlans(old=>old[p.id]?old:{...old,[p.id]:true})} onRefresh={()=>{void agent.refresh();onRefresh();}}/>
        {!assigned&&(!p.snapshot?.owner||p.snapshot.owner===wallet)&&<details open={p.budgetScope!=='NEW_CAPITAL'}><summary>Trade with your personal wallet</summary><small>Each trade needs your signature. Network fees and account rent are separate.</small><div className="ra-trade-legs">{p.legs.map((leg,i)=>{
          const step=p.steps.find(s=>s.index===i),done=step?.phase==='RECONCILED',check=step&&step.phase!=='PREPARING'&&step.phase!=='PREPARED';
          return <div key={i}><span><b>{leg.side??'BUY'} {leg.instrument}</b><small>{legAmount(leg)} · {step?.phase??'Ready'}</small>{step?.observation?.signature&&<a href={`https://explorer.solana.com/tx/${step.observation.signature}`} target="_blank" rel="noreferrer">Trade receipt · mainnet</a>}</span>{done?<span>{leg.side==='SELL'?'Sold':'Purchased'}</span>:check?<button disabled={agent.busy||signing} onClick={async()=>{await agent.act({operation:'CHECK',planId:p.id,index:i});onRefresh();}}>Check status</button>:<button disabled={agent.busy||signing||!['APPROVED','PARTIAL'].includes(p.status)||(i>0&&p.steps.find(s=>s.index===i-1)?.phase!=='RECONCILED')} onClick={()=>void buy(p,i)}>{signing?'Waiting for wallet':leg.side==='SELL'?'Sell in wallet':'Buy in wallet'}</button>}</div>;
        })}</div><ResearchAnchor wallet={wallet} planId={p.id}/></details>}
        {['APPROVED','PARTIAL','UNKNOWN'].includes(p.status)&&<button className="ra-text" disabled={signing||agent.busy} onClick={()=>void agent.act({operation:'REVOKE',planId:p.id})}>Revoke remaining trades</button>}
      </article>;
    })}
    {(error||agent.error)&&<p role="alert" className="ra-error">{error??agent.error}</p>}
    <div className="ra-watch"><div><b>Keep researching</b><p>Re-evaluate new data for 7 days. A new allocation needs your approval.</p></div><button disabled={agent.busy} onClick={()=>void agent.act({operation:'MONITOR',strategyId:strategy.id,goal:agent.run?.goal??agent.goal,enabled:!agent.data?.monitor?.enabled})}>{agent.data?.monitor?.enabled?'Stop monitoring':'Enable monitoring'}</button></div>
  </section>;
}
