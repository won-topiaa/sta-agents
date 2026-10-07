"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import { defaultGoal, type ResearchGoal, type AgentReply, type AgentRun, type AgentPlan, type ResearchCandidate, type RebalanceDraft, type ResearchLeg, type ExitReason } from '@/lib/research-agent-types';
import {ResearchAnchor} from './research-anchor-panel';
import {ResearchAutonomyPanel} from './research-autonomy-panel';
import {AgentChecks} from './research-agent-profile';
import {BscPlanExecution,AgenticPanel,BscHoldings} from './research-bsc-execution';
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
const labels:Record<string,string>={QUEUED:'Queued',RUNNING:'Researching',WAITING_DATA:'Waiting for data',WAITING_MODEL:'Waiting for the AI model',REVIEW:'Ready to review',DECLINED:'Target not supported',CANCELLED:'Cancelled',SUPERSEDED:'Brief changed',FAILED:'Run needs attention'};
// Plain-language wording for results and plans; the stored values stay as the engine reports them.
const signed=(bps:number)=>`${bps>0?'+':bps<0?'−':''}${pct(Math.abs(bps))}`;
const drop=(bps:number)=>`−${pct(Math.abs(bps))}`;
export const horizonText=(days:number)=>({30:'1-month',90:'3-month',180:'6-month',365:'1-year'} as Record<number,string>)[days]??`${days}-day`;
export const planStatusText:Record<string,string>={PROPOSED:'Needs your approval',APPROVED:'Ready to trade',PARTIAL:'In progress',COMPLETE:'Done',REVOKED:'Stopped',EXPIRED:'Expired',UNKNOWN:'Needs a check'};
export const runActive=active;

export type RefusalQuote={vendor?:string;fromAmount:string;fromSymbol?:string;toTokenAmount:string;toSymbol?:string;toDecimals?:number;priceImpactPercent?:string|number;quotedAt?:string|number};
export type Refusal={operation:string;planId?:string;index?:number;code?:string;quote:RefusalQuote|null};
export function useResearchAgent(wallet:string|null,strategy:ResearchStrategy|null){
  const [data,setData]=useState<AgentReply|null>(null),[goal,setGoal]=useState<ResearchGoal>(defaultGoal),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  // The strategy the current data was loaded for; data from the previous strategy can outlive one render.
  const [dataId,setDataId]=useState('');
  // The structured part of the last refusal (e.g. a BNB Chain quote returned with NO_GAS), tied to the request that raised it.
  const [failure,setFailure]=useState<Refusal|null>(null);
  const current=useRef(''),live=useRef(true),flight=useRef(false),goalLoaded=useRef('');const id=strategy?.id??'';current.current=`${wallet}:${id}`;
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  // Reopening a strategy loads its last goal again instead of keeping the defaults.
  useEffect(()=>{setData(null);setDataId('');setGoal(defaultGoal());setError(null);setFailure(null);goalLoaded.current='';},[wallet,id]);
  const refresh=useCallback(async()=>{
    if(!wallet||!id)return;const key=`${wallet}:${id}`;
    try{const r=await fetch(`${endpoint}?id=${id}`,{cache:'no-store',headers:{'X-Skew-Expected-Requester':researchPrincipalOf(wallet)},signal:AbortSignal.timeout(10000)});const b=await r.json();if(current.current!==key||!live.current)return;if(r.ok&&b.owner===researchPrincipalOf(wallet)){setData(b);setDataId(id);if(goalLoaded.current!==key){goalLoaded.current=key;if(b.runs?.[0]?.goal)setGoal(b.runs[0].goal);}}}
    catch{/* Preserve the last report; never replace it with fabricated progress. */}
  },[wallet,id]);
  useEffect(()=>{void refresh();const t=setInterval(()=>{if(!document.hidden)void refresh();},active(data?.runs[0])?3000:15000);return()=>clearInterval(t);},[refresh,data?.runs[0]?.status]);
  const act=async(payload:Record<string,unknown>)=>{
    if(!wallet||!id||flight.current)return null;const key=current.current;flight.current=true;setBusy(true);setError(null);setFailure(null);
    try{await ensureResearchSession(wallet);if(current.current!==key)return null;const r=await fetch(endpoint,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Skew-Expected-Requester':researchPrincipalOf(wallet)},body:JSON.stringify(payload),signal:AbortSignal.timeout(payload.operation==='REVIEW_REBALANCE'?90000:30000)});const b=await r.json();if(current.current!==key||!live.current)return null;if(!r.ok){setFailure({operation:String(payload.operation),planId:payload.planId as string|undefined,index:payload.index as number|undefined,code:b.error?.code,quote:b.error?.quote??null});throw new Error(b.error?.message??'Request was not completed.');}await refresh();return b;}
    catch(e){if(live.current&&current.current===key)setError(e instanceof Error?e.message:'Request failed.');return null;}
    finally{flight.current=false;if(live.current)setBusy(false);}
  };
  return{data,dataId,goal,setGoal,busy,error,failure,refresh,act,run:data?.runs[0],running:active(data?.runs[0]),start:()=>act({operation:'RUN',strategyId:id,goal,requestId:crypto.randomUUID()})};
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
  return <figure className="ra-curve"><div className="ra-legend" aria-hidden="true"><span><i/>This strategy</span><span><i className="ra-legend-bench"/>Nasdaq-100 (QQQ)</span><span>Past prices · backtest</span></div><svg viewBox="0 0 600 160" role="img" aria-label={`${candidate.name} historical equity; benchmark shown in gray`}><path d="M0 145H600" stroke="#292929"/>{c.benchmark.length>1&&<path d={path(c.benchmark)} fill="none" stroke="#555" strokeWidth="1.5"/>}<path d={path(values)} fill="none" stroke="#e7e7e7" strokeWidth="2"/></svg><figcaption><span>{c.dates[0]}</span><span>{c.dates.at(-1)}</span></figcaption></figure>;
}
// The engine's own plain-English description of the tested design (report field howItPicks).
function HowItPicks({candidate}:{candidate:ResearchCandidate}){
  const how=(candidate as ResearchCandidate&{howItPicks?:Partial<Record<'score'|'filters'|'pick'|'weighting'|'risk_off'|'breadth'|'hold'|'exit',string>>}).howItPicks;
  const rows=how?([['Ranks stocks by','score'],['Filters','filters'],['Buys','pick'],['Splits the money','weighting'],['Market guard','risk_off'],['Breadth guard','breadth'],['Keeps','hold'],['Exits','exit']] as const).filter(([,k])=>how[k]&&how[k]!=='none'):[];
  if(!rows.length)return null;
  return <dl className="ra-how">{rows.map(([label,k])=><div key={k}><dt>{label}</dt><dd>{how![k]}</dd></div>)}</dl>;
}
function Verdict({candidate}:{candidate:ResearchCandidate}){
  return candidate.verdict==='ELIGIBLE'?<span className="ra-verdict ra-ok">Fits your limits</span>:<span className="ra-verdict ra-no">Outside your limits</span>;
}
// Target split of the budget. Amounts are an estimate until the plan is approved; the server sizes the exact legs.
function Allocation({candidate,budget,asset,bsc}:{candidate:ResearchCandidate;budget?:string;asset:string;bsc:boolean}){
  const total=Number(budget)>0?Number(budget):0,money=(bps:number)=>(total*bps/10000).toLocaleString('en-US',{maximumFractionDigits:2});
  const small=bsc&&total?candidate.weights.filter(w=>total*w.weightBps/10000<5).map(w=>w.instrument):[];
  return <div className="ra-alloc" aria-label="Target allocation">
    <div className="ra-alloc-bar">{candidate.weights.map((w,i)=><span key={w.instrument} style={{flex:w.weightBps,opacity:Math.max(.3,1-i*.14)}}/>)}{candidate.cashBps>0&&<span className="ra-alloc-cash" style={{flex:candidate.cashBps}}/>}</div>
    <ul>{candidate.weights.map(w=><li key={w.instrument}><b>{w.instrument}</b><span>{pct(w.weightBps)}</span>{total>0&&<small>≈ {money(w.weightBps)} {asset}</small>}</li>)}{candidate.cashBps>0&&<li className="ra-alloc-cash-row"><b>Cash</b><span>{pct(candidate.cashBps)}</span>{total>0&&<small>≈ {money(candidate.cashBps)} {asset}</small>}</li>}</ul>
    {small.length>0&&<small className="ra-alloc-note">{small.join(', ')} would be under the 5 {asset} minimum order and stay in cash.</small>}
  </div>;
}
const reasonLabels:Record<string,string>={TARGET_NOT_SUPPORTED:'Return target not supported',DRAWDOWN_LIMIT_EXCEEDED:'Loss limit exceeded',NON_POSITIVE_HOLDOUT_RETURN:'No positive held-out return',COST_STRESS_FAILED:'Failed doubled-cost test',NO_CURRENT_ALLOCATION:'No current stock allocation',DESIGN_STABILITY_NEEDS_REVIEW:'Strategy stability needs review',FUTURE_DATA_LEAKAGE:'Future-data check failed',AGENT_RULE_NOT_ENFORCED:'Agent rule not enforced'};
export function ResearchResults({agent,onActivity,budget,autoTrade=false}:{agent:AgentController;onActivity:()=>void;budget?:string;autoTrade?:boolean}){
  const run=agent.run;
  const wallet=agent.data?.owner.replace(/^solana:/,'');
  const bsc=Boolean(agent.data?.owner.startsWith('eip155:56:')),asset=bsc?'USDT':'USDC';
  const [draft,setDraft]=useState<RebalanceDraft|null>(null);
  const [selectedCandidate,setSelectedCandidate]=useState<string|null>(null),[sellOutside,setSellOutside]=useState(false);
  useEffect(()=>{setDraft(null);setSelectedCandidate(null);setSellOutside(false);},[run?.id,agent.data?.owner]);
  if(!run)return <div className="ra-empty"><h3>Set a target. Test the possibilities.</h3><p>Your agent designs up to three strategies and tests each one on past prices, after trading costs. The results appear here.</p></div>;
  if(!run.result)return <div className="ra-empty" aria-live="polite"><h3>{labels[run.status]??run.status}</h3>{active(run)&&<div className="ra-progress" role="progressbar" aria-label="Research in progress"><span/></div>}<p>{run.error??'Designing strategies, then testing each one on past prices after costs. This usually takes about a minute.'}</p><small>Started {new Date(run.createdAt).toLocaleString()}</small></div>;
  const r=run.result,h=horizonText(run.goal.horizonDays),fits=r.candidates.filter(c=>c.verdict==='ELIGIBLE').length;
  const candidate=r.candidates.find(c=>c.id===selectedCandidate)??r.candidates.find(c=>c.verdict==='ELIGIBLE')??r.candidates[0];
  // A run is approved at most once; an approval that lapsed needs a fresh run.
  const used=agent.data?.plans.find(p=>p.runId===run.id&&!p.kind),ended=used&&['EXPIRED','SUPERSEDED','REVOKED'].includes(used.status);
  return <div className="ra-results"><header><span className={`ra-verdict ${fits?'ra-ok':'ra-no'}`}>{fits?`${fits} of ${r.candidates.length} fit your limits`:'None fit your limits'}</span><h3>{labels[run.status]}</h3><p>{r.explanation}</p><small>Your goal: {signed(run.goal.targetReturnBps)} over {h.replace('-',' ')} · lose no more than {pct(run.goal.maxDrawdownBps)}{r.agent&&<> · Designed by {r.agent.name}</>}</small></header>
    <div className="ra-compare" role="group" aria-label="Compare strategies">{r.candidates.map(c=><button key={c.id} aria-pressed={candidate?.id===c.id} onClick={()=>setSelectedCandidate(c.id)}><b>{c.name}</b><Verdict candidate={c}/><span className="ra-compare-num"><em>{signed(c.horizonMedianBps)}</em> typical {h} return</span><small>Worst drop {drop(c.holdoutDrawdownBps)}</small></button>)}</div>
    {(candidate?[candidate]:[]).map(c=><article className="ra-candidate" key={c.id}><div className="ra-candidate-heading"><h4>{c.name}</h4><Verdict candidate={c}/></div>
      <p className="ra-summary">Over past {h} periods, this strategy&apos;s typical return was <b>{signed(c.horizonMedianBps)}</b>. Its worst drop in the held-out test was <b>{drop(c.holdoutDrawdownBps)}</b>. With trading costs doubled, the typical return was <b>{signed(c.stressHorizonMedianBps)}</b>.</p>
      <HowItPicks candidate={c}/>
      <Curve candidate={c}/>
      <dl className="ra-metrics"><div><dt>Typical {h} return</dt><dd>{signed(c.horizonMedianBps)}</dd><small>Median of {c.windowCount} past periods</small></div><div><dt>Worst drop</dt><dd>{drop(c.holdoutDrawdownBps)}</dd><small>Held-out test from {c.holdoutStart}</small></div><div><dt>With doubled costs</dt><dd>{signed(c.stressHorizonMedianBps)}</dd><small>Typical return if trading cost twice as much</small></div></dl>
      <Allocation candidate={c} budget={budget} asset={asset} bsc={bsc}/>
      {c.agentChecks&&<AgentChecks checks={c.agentChecks} agentName={r.agent?.name}/>}
      {c.reasons.length>0&&<div className="ra-reasons"><b>{c.verdict==='ELIGIBLE'?'Notes':'Why it does not fit'}</b><ul>{c.reasons.map(x=><li key={x}>{reasonLabels[x]??x}</li>)}</ul>{c.verdict!=='ELIGIBLE'&&<small>Try a lower target, a longer period or different stocks, then run research again.</small>}</div>}
      <details><summary>Method & evidence</summary><p>{r.method}</p><p>{c.windowCount} non-overlapping windows, held out from {c.holdoutStart}. The median is a past observation, not an expected return.</p><p>{r.dataset.limitations.join(' ')}</p><code>Report {r.reportHash}</code><code>Dataset {r.dataset.id}</code></details>
      {c.verdict==='ELIGIBLE'&&used&&<section className="ra-approve" aria-label="Approval">{ended
        ?<><div><b>This approval has ended</b><p>Approvals last an hour and this run was already approved once. Run research again to approve a fresh plan.</p></div><div className="ra-inline-actions"><button className="ra-primary" disabled={agent.busy||agent.running} onClick={()=>void agent.start()}>Run research again</button></div></>
        :<><div><b>{used.candidateId===c.id?'Approved':'Another strategy from this run is approved'}</b><p>Its trades are listed under Trades.</p></div><div className="ra-inline-actions"><button className="ra-primary" onClick={onActivity}>Go to trades</button></div></>}</section>}
      {c.verdict==='ELIGIBLE'&&!used&&<section className="ra-approve" aria-label="Approve this strategy"><div><b>Approve {c.name}</b><p>Approving turns this strategy into a trade plan. Nothing is bought yet: {autoTrade?'your agent then places the orders within the limits you set in Binance, and you can stop it at any time.':'you then confirm each trade in your wallet, one at a time.'}</p></div>{bsc&&<label className="ra-check"><input type="checkbox" checked={sellOutside} onChange={e=>setSellOutside(e.target.checked)}/><span><b>Rebalance my holdings</b> Sell this strategy&apos;s other stocks I already hold first, then buy.</span></label>}
        <div className="ra-inline-actions"><button className="ra-primary" disabled={agent.busy} onClick={async()=>{const b=await agent.act({operation:'APPROVE',runId:run.id,candidateId:c.id,reportHash:r.reportHash,...(bsc&&sellOutside?{sellOutside:true}:{})});if(b)onActivity();}}>{agent.busy?'Approving…':sellOutside?'Approve rebalance':'Approve plan'}</button>{!bsc&&<><button disabled={agent.busy} onClick={async()=>{const b=await agent.act({operation:'REVIEW_REBALANCE',walletScope:'AGENT_WALLET',runId:run.id,candidateId:c.id,reportHash:r.reportHash});if(b)setDraft(b.draft);}}>Use agent holdings</button><button className="ra-text" disabled={agent.busy} onClick={async()=>{const b=await agent.act({operation:'REVIEW_REBALANCE',walletScope:'PERSONAL',runId:run.id,candidateId:c.id,reportHash:r.reportHash});if(b)setDraft(b.draft);}}>Personal wallet holdings</button></>}</div></section>}
      {draft?.candidateId===c.id&&<section className="ra-allocation-review" aria-label="Rebalance review"><h4>Rebalance selected stocks</h4><p>{usd(draft.heldValueAtoms)} already held · {usd(draft.portfolioValueAtoms)} total allocation</p><small>Other stocks stay untouched. Sales run first. {draft.snapshot?.owner&&draft.snapshot.owner!==wallet?'Review the full allocation, then approve your agent wallet.':'Review each transaction in your wallet.'}</small><div className="ra-trade-legs">{draft.legs.map((leg,i)=><div key={i}><span>{leg.side} {leg.instrument}</span><b>{legAmount(leg)}</b></div>)}</div><p>{usd(draft.cashAtoms)} retained as cash</p><button className="ra-primary" disabled={agent.busy} onClick={async()=>{const b=await agent.act({operation:'APPROVE',runId:run.id,candidateId:c.id,reportHash:r.reportHash,draftId:draft.id});if(b){setDraft(null);onActivity();}}}>Approve this allocation</button></section>}
    </article>)}
    {agent.error&&<p className="ra-error" role="alert">{agent.error}</p>}
    <footer className="ra-provenance"><span>{r.model.provider} · {r.model.model}</span><span>{r.model.inputTokens+r.model.outputTokens} tokens · Data through {r.dataset.asOf}</span></footer>
  </div>;
}

// Why the agent proposes a sale: the exit rule, the entry and the latest close it was checked against.
function ExitWhy({reason}:{reason:ExitReason}){
  const pctOf=(a:number|null,b:number|null)=>a!=null&&b?`${((1-a/b)*100).toFixed(1)}%`:'—';
  return <ul className="ra-exit-why">{reason.rules.map(r=><li key={r.instrument+r.rule}><b>{r.rule==='stop_loss'?'Stop loss':'Trailing stop'} · {r.instrument}</b>
    <span>{r.rule==='stop_loss'?`Closed at ${r.lastClose??'—'} on ${r.lastDate??'—'}, ${pctOf(r.lastClose,r.entryClose)} below its entry close of ${r.entryClose??'—'} (${r.since}).`
      :`Closed at ${r.lastClose??'—'} on ${r.lastDate??'—'}, ${pctOf(r.lastClose,r.peakClose)} below its highest close since entry (${r.peakClose??'—'}).`} Your agent&apos;s limit: {(r.threshold*100).toFixed(0)}%.</span></li>)}</ul>;
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
  // Plans store the candidate id (a hash); show the strategy name the owner approved.
  const nameOf=(p:AgentPlan)=>agent.data?.runs.find(r=>r.id===p.runId)?.result?.candidates.find(c=>c.id===p.candidateId)?.name??'Approved plan';
  const progress=(p:AgentPlan)=>{const done=p.steps.filter(s=>s.phase==='RECONCILED').length;return <div className="ra-plan-progress"><span>{done} of {p.legs.length} trade{p.legs.length===1?'':'s'} done</span><div><i style={{width:`${p.legs.length?done/p.legs.length*100:0}%`}}/></div></div>;};
  const status=(p:AgentPlan)=><span className={`ra-status ra-status-${p.status.toLowerCase()}`}>{planStatusText[p.status]??p.status}</span>;
  return <section className="ra-execution">
    {!plans.some(p=>p.chain==='eip155:56')&&!(wallet&&/^0x/.test(wallet))&&<div className="ra-inline-actions"><a className="ra-text" href="/exchange/agent-wallet">Agent wallet ↗</a></div>}
    {wallet&&/^0x/.test(wallet)&&<BscHoldings agent={agent} strategyId={strategy.id}/>}
    {plans.length===0&&<div className="ra-empty ra-empty-small"><h3>No approved plan yet</h3><p>Open Results, pick a strategy that fits your limits and approve it. Its trades appear here, ready to confirm.</p></div>}
    {plans.map(p=>{
      if(p.chain==='eip155:56'&&wallet){
        const sales=p.legs.filter(l=>l.side==='SELL').length,refresh=()=>{void agent.refresh();onRefresh();};
        return <article key={p.id} className={`ra-plan ${p.status==='PROPOSED'?'ra-plan-proposed':''}`}>
        <div className="ra-candidate-heading"><h4>{p.kind==='CLOSE'?'Close positions':p.kind==='EXIT'?`Exit: ${p.legs.map(l=>l.instrument).join(', ')}`:nameOf(p)}{p.agent&&<small> · {p.agent.name}</small>}</h4>{status(p)}</div>
        <p>{p.kind?`Sells ${sales} holding${sales===1?'':'s'} for USDT${p.wallet==='AGENTIC'?' from your Agentic Wallet':' from your wallet'}`
          :<>{(Number(BigInt(p.budgetAtoms)/10n**12n)/1e6).toLocaleString('en-US')} USDT on BNB Chain · {(Number(BigInt(p.cashAtoms)/10n**12n)/1e6).toLocaleString('en-US')} USDT stays in cash{sales?` · sells ${sales} holding${sales===1?'':'s'} first`:''}</>}</p>
        {p.reason&&<ExitWhy reason={p.reason}/>}
        {p.status==='PROPOSED'?<div className="ra-inline-actions"><button className="ra-primary" disabled={agent.busy} onClick={()=>void agent.act({operation:'APPROVE_PROPOSED',planId:p.id})}>Approve sale</button><button className="ra-text" disabled={agent.busy} onClick={()=>void agent.act({operation:'REVOKE',planId:p.id})}>Keep holding</button><small className="ra-caption">Nothing is sold unless you approve. The proposal lapses after 24 hours.</small></div>:<>
        {progress(p)}
        {p.belowMinimum?.length?<p className="ra-caption">Below the 5 USDT minimum order, kept in cash: {p.belowMinimum.join(', ')}</p>:null}
        {/* Sales from the owner's own wallet are signed step by step; the Agentic Wallet only sells what it holds. */}
        {p.wallet!=='PERSONAL'&&<AgenticPanel plan={p} wallet={wallet} onRefresh={refresh}/>}
        {p.wallet!=='AGENTIC'&&<BscPlanExecution plan={p} agent={agent} wallet={wallet} onRefresh={refresh}/>}
        {['APPROVED','PARTIAL','UNKNOWN'].includes(p.status)&&<button className="ra-text" disabled={agent.busy} onClick={()=>void agent.act({operation:'REVOKE',planId:p.id})}>Revoke remaining trades</button>}</>}
      </article>;}
      const assigned=boundPlans[p.id]||(p as AgentPlan&{executionMode?:string}).executionMode==='AGENT_WALLET';
      return <article key={p.id} className="ra-plan">
        <div className="ra-candidate-heading"><h4>{nameOf(p)}</h4>{status(p)}</div>
        <p>{usd(p.budgetAtoms)} additional cash{p.heldValueAtoms?` + ${usd(p.heldValueAtoms)} selected holdings`:''} · {usd(p.cashAtoms)} stays in USDC</p>
        <ResearchAutonomyPanel plan={p} wallet={wallet} onBound={()=>setBoundPlans(old=>old[p.id]?old:{...old,[p.id]:true})} onRefresh={()=>{void agent.refresh();onRefresh();}}/>
        {!assigned&&(!p.snapshot?.owner||p.snapshot.owner===wallet)&&<details open={p.budgetScope!=='NEW_CAPITAL'}><summary>Trade with your personal wallet</summary><small>Each trade needs your signature. Network fees and account rent are separate.</small><div className="ra-trade-legs">{p.legs.map((leg,i)=>{
          const step=p.steps.find(s=>s.index===i),done=step?.phase==='RECONCILED',check=step&&step.phase!=='PREPARING'&&step.phase!=='PREPARED';
          return <div key={i}><span><b>{leg.side??'BUY'} {leg.instrument}</b><small>{legAmount(leg)} · {step?.phase??'Ready'}</small>{step?.observation?.signature&&<a href={`https://explorer.solana.com/tx/${step.observation.signature}`} target="_blank" rel="noreferrer">Trade receipt · mainnet</a>}</span>{done?<span>{leg.side==='SELL'?'Sold':'Purchased'}</span>:check?<button disabled={agent.busy||signing} onClick={async()=>{await agent.act({operation:'CHECK',planId:p.id,index:i});onRefresh();}}>Check status</button>:<button disabled={agent.busy||signing||!['APPROVED','PARTIAL'].includes(p.status)||(i>0&&p.steps.find(s=>s.index===i-1)?.phase!=='RECONCILED')} onClick={()=>void buy(p,i)}>{signing?'Waiting for wallet':leg.side==='SELL'?'Sell in wallet':'Buy in wallet'}</button>}</div>;
        })}</div><ResearchAnchor wallet={wallet} planId={p.id}/></details>}
        {['APPROVED','PARTIAL','UNKNOWN'].includes(p.status)&&<button className="ra-text" disabled={signing||agent.busy} onClick={()=>void agent.act({operation:'REVOKE',planId:p.id})}>Revoke remaining trades</button>}
      </article>;
    })}
    {(error||(agent.error&&!agent.failure?.quote))&&<p role="alert" className="ra-error">{error??agent.error}</p>}
    <div className="ra-watch"><div><b>Keep researching</b><p>For the next 7 days, your agent re-evaluates this research as new prices arrive. Any new allocation still needs your approval.</p></div><button disabled={agent.busy} onClick={()=>void agent.act({operation:'MONITOR',strategyId:strategy.id,goal:agent.run?.goal??agent.goal,enabled:!agent.data?.monitor?.enabled})}>{agent.data?.monitor?.enabled?'Stop monitoring':'Enable monitoring'}</button></div>
  </section>;
}
