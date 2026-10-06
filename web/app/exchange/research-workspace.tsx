"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import dynamic from 'next/dynamic';
import { blankResearchBrief, type ResearchBrief, type ResearchReply, type ResearchStrategy } from '@/lib/research-workspace';
import { directoryMarket, type StockDirectoryRow } from '@/lib/stock-directory';
import { exactTokenAmount, orderLabel, type ObservedOrder } from '@/lib/stock-order-state';
import { readPortfolioDrafts, portfolioFromFragment, PORTFOLIO_STORAGE, weightBps, type PortfolioDraft, type SavedPortfolio } from '@/lib/stock-portfolio-builder';
import { type PortfolioResponse } from './stocklana-exchange-client';
import { ensureResearchSession, researchPrincipalOf, isEvmWallet } from './research-session';
import { useMarketPrices } from './use-stock-workspace-data';
import { StockLogo } from './stock-logo';
import './research-workspace.css';
import { useResearchAgent, ResearchRunControls, ResearchResults, ResearchPlanExecution } from './research-agent-panel';
import {ResearchIntakeCard} from './research-intake-card';
import {useAgents,AgentBar,AgentEditor} from './research-agent-profile';
import {useAgentic,AgenticConnect} from './research-bsc-execution';
import type {AgentProfile} from '@/lib/research-agent-profile.mjs';
import type {ResearchIntake} from '@/lib/research-intake.mjs';

const StockPriceChart = dynamic(() => import('./stock-price-chart').then(m => m.StockPriceChart), { loading: () => <div className="rw-chart-loading">Loading chart…</div> });
const tabs = ['Overview','Backtest','Holdings','Sources','Execution'] as const;
const tabLabels = { Overview:'Market', Backtest:'Results', Holdings:'Holdings', Sources:'Sources', Execution:'Activity' };
type ReportTab = typeof tabs[number];
type Props = { holdingsNote?: string; wallet: string | null; directory: StockDirectoryRow[]; portfolio: PortfolioResponse | null; balanceError: string | null; orders: ObservedOrder[]; historyError: string | null; onConnect: () => Promise<void>; onSelect: (id: string) => void; onRefresh: () => void; onHistory: () => Promise<void> };
const endpoint = '/api/v1/stocklana/research';
const date = (value: string) => new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const amount = (value: string) => Number(value).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
const briefOf = (s: ResearchStrategy): ResearchBrief => ({name:s.name,objective:s.objective,budget:s.budget,instruments:s.instruments,weights:s.weights,cashBps:s.cashBps,...(s.agentId?{agentId:s.agentId}:{})});
const agentKey = (wallet: string) => `xtxc-research-agent:${wallet}`;

export default function ResearchWorkspace(props: Props) {
  const guestBrief = useRef<ResearchBrief | null>(null);
  const guestRequest = useRef<{text:string;stocks:string[];submitted?:boolean}|null>(null);
  // Account changes destroy all private view state before the next render.
  return <AccountWorkspace key={props.wallet ?? 'guest'} {...props} guestBrief={guestBrief} guestRequest={guestRequest}/>;
}

function AccountWorkspace({holdingsNote,wallet,directory,portfolio,balanceError,orders,historyError,onConnect,onSelect,onRefresh,onHistory,guestBrief,guestRequest}:Props & {guestBrief:RefObject<ResearchBrief|null>;guestRequest:RefObject<{text:string;stocks:string[];submitted?:boolean}|null>}) {
  const [data,setData] = useState<ResearchReply | null>(null);
  const [selected,setSelected] = useState<string | null>(null);
  const [loading,setLoading] = useState(false), [locked,setLocked] = useState(false), [error,setError] = useState<string | null>(null);
  const [busy,setBusy] = useState(false), [note,setNote] = useState(''), [signing,setSigning] = useState(false);
  const [tab,setTab] = useState<ReportTab>('Overview'), [focus,setFocus] = useState('NVDA');
  const [mobile,setMobile] = useState<'chat'|'report'>('chat'), [listOpen,setListOpen] = useState(false);
  const [filter,setFilter] = useState(''), [stockSearch,setStockSearch] = useState('');
  const [form,setForm] = useState<ResearchBrief>(blankResearchBrief), [edit,setEdit] = useState<{id:string;revision:number}|null>(null);
  const [drafts,setDrafts] = useState<SavedPortfolio[]>([]), [importsOpen,setImportsOpen] = useState(false);
  const [chatWidth,setChatWidth] = useState(370);
  const [intake,setIntake]=useState<ResearchIntake|null>(null),[interpreting,setInterpreting]=useState(false);
  const [pinned,setPinned]=useState<string[]>([]),[pickerOpen,setPickerOpen]=useState(false),[pinSearch,setPinSearch]=useState('');
  const interpretation=useRef(0),intakeEdit=useRef(false),intakeFlight=useRef(false),runRequest=useRef<string|null>(null);
  const intakeRun=useRef<{key:string;strategy:ResearchStrategy;requestId:string}|null>(null);
  const modal = useRef<HTMLDialogElement>(null), messages = useRef<HTMLDivElement>(null), layout = useRef<HTMLDivElement>(null);
  const generation = useRef(0), controller = useRef<AbortController | null>(null), cursor = useRef(0);
  const mounted = useRef(true), mutation = useRef(false), requests = useRef(new Map<string,string>()), notes = useRef(new Map<string,string>());
  const strategy = data?.strategy?.id === selected ? data.strategy : null;
  const chartUniverse = intake?.brief.instruments.length ? intake.brief.instruments : strategy?.instruments;
  const agent = useResearchAgent(wallet,strategy);
  // The user's own agent: bound to a saved strategy, or chosen for the next new research.
  const agents = useAgents(wallet);
  // AccountWorkspace is keyed by wallet and mounted on the client after connection.
  const [activeAgent,setActiveAgent] = useState<string|null>(()=>{try{return wallet?localStorage.getItem(agentKey(wallet)):null;}catch{return null;}});
  const [agentEditor,setAgentEditor] = useState<{open:boolean;agent:AgentProfile|null}>({open:false,agent:null});
  const knownActive = agents.agents && activeAgent && !agents.agents.some(a=>a.id===activeAgent) ? null : activeAgent;
  const boundAgentId = strategy ? strategy.agentId ?? null : knownActive;
  const boundAgent = agents.agents?.find(a=>a.id===boundAgentId) ?? null;
  const stable = wallet && isEvmWallet(wallet) ? 'USDT' : 'USDC';
  const withAgent = (b: ResearchBrief): ResearchBrief => { const {agentId:_,...rest}=b; void _; return boundAgentId ? {...rest,agentId:boundAgentId} : rest; };
  const market = directory.find(r=>r.instrument===focus) ?? directory[0];
  const prices = useMarketPrices(market?.instrument);
  const observation = prices.snapshot?.markets.find(m=>m.id===market?.instrument);
  const summaries = data?.strategies ?? [];
  const visibleStrategies = summaries.filter(s=>(s.name+' '+s.instruments.join(' ')).toLowerCase().includes(filter.toLowerCase()));

  useEffect(()=>{ mounted.current=true; return()=>{mounted.current=false; generation.current++; controller.current?.abort();}; },[]);
  const load = useCallback(async(id:string|null,quiet=false) => {
    if(!wallet) return;
    const version=++generation.current; controller.current?.abort(); const abort=new AbortController(); controller.current=abort;
    if(!quiet) setLoading(true);
    try {
      const query=new URLSearchParams({after:String(cursor.current)}); if(id)query.set('id',id);
      const response=await fetch(`${endpoint}?${query}`,{headers:{'X-Skew-Expected-Requester':researchPrincipalOf(wallet)},cache:'no-store',signal:abort.signal});
      const body=await response.json();
      if(version!==generation.current||!mounted.current)return;
      if(response.status===401){setLocked(true);return;}
      if(!response.ok||body.owner!==researchPrincipalOf(wallet))throw new Error(body.error?.message??'Could not load your strategies.');
      setLocked(false);setData(body);cursor.current=body.cursor;setError(null);
    } catch(reason) {if(!abort.signal.aborted&&version===generation.current&&mounted.current)setError(reason instanceof Error?reason.message:'Could not load your strategies.');}
    finally {if(version===generation.current&&mounted.current)setLoading(false);}
  },[wallet]);
  useEffect(()=>{
    const query=new URLSearchParams(window.location.search), id=query.get('workspace');
    const valid=id&&/^[a-f0-9-]{36}$/.test(id)?id:null;setSelected(valid);void load(valid);
    try{setDrafts(readPortfolioDrafts(localStorage.getItem(PORTFOLIO_STORAGE)));}catch{}
    if(wallet&&guestRequest.current){const pending=guestRequest.current;guestRequest.current=null;setNote(pending.text);setPinned(pending.stocks);if(pending.submitted!==false)void interpret(pending.text,null,pending.stocks);}
    else if(wallet&&guestBrief.current){const pending=guestBrief.current;guestBrief.current=null;setEdit(null);setForm(pending);modal.current?.showModal();}
    else if(query.get('create')==='1'){
      const draft=portfolioFromFragment(window.location.hash);
      if(draft)importDraft(draft);else openNew();
    }
  // Imports run once; later changes stay in the form until explicitly saved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[load]);
  useEffect(()=>{
    const refresh=()=>{if(!document.hidden&&!mutation.current)void load(selected,true);};
    const timer=window.setInterval(refresh,30_000);document.addEventListener('visibilitychange',refresh);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[load,selected]);
  useEffect(()=>{if(chartUniverse?.length&&!chartUniverse.includes(focus))setFocus(chartUniverse[0]);},[chartUniverse,focus]);
  useEffect(()=>{messages.current?.scrollTo({top:messages.current.scrollHeight,behavior:'instant'});},[selected,strategy?.messages.length]);
  function select(id:string){
    interpretation.current++;setIntake(null);intakeRun.current=null;
    setPinned([]);setPickerOpen(false);
    if(selected)notes.current.set(selected,note);
    setSelected(id);setNote(notes.current.get(id)??'');setListOpen(false);setError(null);void load(id);
    const url=new URL(window.location.href);url.searchParams.set('view','research');url.searchParams.set('workspace',id);url.searchParams.delete('create');url.hash='';window.history.replaceState(null,'',url);
  }
  async function unlock(){
    if(!wallet){await onConnect();return;}
    setBusy(true);setError(null);setSigning(true);
    try{await ensureResearchSession(wallet);if(mounted.current){await load(selected);void agents.refresh();}}catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'Sign-in was not completed.');}finally{if(mounted.current){setBusy(false);setSigning(false);}}
  }
  async function save(payload:Record<string,unknown>):Promise<ResearchStrategy|null>{
    if(mutation.current)return null;
    if(!wallet){if(payload.operation==='CREATE')guestBrief.current=form;await onConnect();return null;}
    mutation.current=true;generation.current++;controller.current?.abort();setBusy(true);setError(null);
    const key=JSON.stringify(payload),requestId=requests.current.get(key)??crypto.randomUUID();requests.current.set(key,requestId);
    try{
      await ensureResearchSession(wallet);if(!mounted.current)return null;if(!agents.agents)void agents.refresh();
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Skew-Expected-Requester':researchPrincipalOf(wallet)},body:JSON.stringify({...payload,requestId}),signal:AbortSignal.timeout(15_000)});
      const body=await response.json();if(!mounted.current)return null;
      if(!response.ok||body.owner!==researchPrincipalOf(wallet))throw new Error(body.error?.message??'Could not save this strategy.');
      requests.current.delete(key);setData(body);setLocked(false);cursor.current=Math.max(cursor.current,body.cursor);return body.strategy;
    }catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'Your changes are still here. Retry saving.');return null;}
    finally{mutation.current=false;if(mounted.current){setBusy(false);setLoading(false);}}
  }
  function openNew(){
    if(selected)notes.current.set(selected,note);
    interpretation.current++;generation.current++;controller.current?.abort();
    setSelected(null);setEdit(null);setIntake(null);setNote('');setPinned([]);setPickerOpen(false);setError(null);setLoading(false);setMobile('chat');setListOpen(false);intakeRun.current=null;
    const url=new URL(window.location.href);url.searchParams.delete('workspace');url.searchParams.delete('create');url.hash='';window.history.replaceState(null,'',url);
    requestAnimationFrame(()=>document.getElementById('research-note')?.focus());
  }
  async function interpret(text=note,context=strategy,stocks=pinned){
    if(!text.trim()||intakeFlight.current)return;
    if(!wallet){guestRequest.current={text,stocks};await onConnect();return;}
    const version=++interpretation.current;intakeFlight.current=true;setInterpreting(true);setError(null);
    try{await ensureResearchSession(wallet);if(!mounted.current||version!==interpretation.current)return;if(!agents.agents)void agents.refresh();
      const r=await fetch(endpoint+'/interpret',{method:'POST',headers:{'Content-Type':'application/json','X-Skew-Expected-Requester':researchPrincipalOf(wallet)},body:JSON.stringify({text,strategyId:context?.id,draft:intake?{brief:intake.brief,goal:intake.goal,missing:intake.missing}:undefined,stocks}),signal:AbortSignal.timeout(30000)}),b=await r.json();
      if(!mounted.current||version!==interpretation.current)return;if(!r.ok)throw new Error(b.error?.message??'Could not understand this request.');
      setIntake(b.draft);if(b.draft.brief.instruments[0])setFocus(b.draft.brief.instruments[0]);setNote('');setPickerOpen(false);setPinned([]);intakeRun.current=null;setEdit(context?{id:context.id,revision:context.revision}:null);runRequest.current=crypto.randomUUID();
    }catch(e){if(mounted.current&&version===interpretation.current)setError(e instanceof Error?e.message:'Request was not completed.');}
    finally{intakeFlight.current=false;if(mounted.current)setInterpreting(false);}
  }
  async function selectAgent(id:string|null){
    if(strategy){
      // Re-binding changes the brief; earlier results of this strategy no longer apply.
      const {agentId:_,...rest}=briefOf(strategy);void _;
      await save({operation:'UPDATE',id:strategy.id,revision:strategy.revision,brief:id?{...rest,agentId:id}:rest});
      return;
    }
    setActiveAgent(id);
    if(wallet)try{ if(id)localStorage.setItem(agentKey(wallet),id); else localStorage.removeItem(agentKey(wallet)); }catch{}
  }
  async function runIntake(){
    if(!intake||!wallet||intakeFlight.current)return;intakeFlight.current=true;
    const draft=intake,key=JSON.stringify(intake),requestId=runRequest.current??crypto.randomUUID();runRequest.current=requestId;
    try{const saved=intakeRun.current?.key===key?intakeRun.current.strategy:await save(edit?{operation:'UPDATE',...edit,brief:withAgent(draft.brief)}:{operation:'CREATE',brief:withAgent(draft.brief)});if(!saved||!mounted.current)return;
      intakeRun.current={key,strategy:saved,requestId};setBusy(true);
      setEdit({id:saved.id,revision:saved.revision});
      const r=await fetch(endpoint+'/agent',{method:'POST',headers:{'Content-Type':'application/json','X-Skew-Expected-Requester':researchPrincipalOf(wallet)},body:JSON.stringify({operation:'RUN',strategyId:saved.id,goal:draft.goal,requestId}),signal:AbortSignal.timeout(15000)}),b=await r.json();
      if(!mounted.current)return;if(!r.ok)throw new Error(b.error?.message??'Saved. Research could not start yet.');select(saved.id);setNote('');setTab('Backtest');setMobile('report');
    }catch(e){if(mounted.current)setError(e instanceof Error?e.message:'Could not start research.');}finally{intakeFlight.current=false;if(mounted.current)setBusy(false);}
  }
  function chooseExample(text:string){setNote(text);document.getElementById('research-note')?.focus();}
  function openEdit(){if(!strategy)return;intakeEdit.current=false;setEdit({id:strategy.id,revision:strategy.revision});setForm(briefOf(strategy));setStockSearch('');modal.current?.showModal();}
  function importDraft(draft:PortfolioDraft){
    const allowed=new Set(directory.map(r=>r.instrument));
    const unsupported=draft.legs.filter(l=>!allowed.has(l.instrument));
    if(unsupported.length){setImportsOpen(true);setError(`${unsupported.map(l=>l.instrument).join(', ')} are outside this research universe. Your original portfolio is unchanged.`);return;}
    const legs=draft.legs.filter(l=>allowed.has(l.instrument));
    const weights=legs.map(l=>({instrument:l.instrument,weightBps:weightBps(l.percent)??0}));
    const cash=weightBps(draft.cash);const valid=legs.length===draft.legs.length&&cash!==null&&weights.every(w=>w.weightBps>0)&&weights.reduce((n,w)=>n+w.weightBps,cash)===10000;
    setEdit(null);setForm({name:draft.name,objective:draft.description||'Research this portfolio and its risks before making any trades.',budget:'100',instruments:legs.map(l=>l.instrument),weights:valid?weights:[],cashBps:valid?cash:null});
    setImportsOpen(false);setStockSearch('');modal.current?.showModal();
  }
  async function submitBrief(){
    if(intakeEdit.current&&intake){setIntake({...intake,brief:form,missing:intake.missing.filter(x=>x!=='stocks'&&x!=='budget')});intakeEdit.current=false;modal.current?.close();return;}
    const saved=await save(edit?{operation:'UPDATE',...edit,brief:withAgent(form)}:{operation:'CREATE',brief:withAgent(form)});
    if(saved&&mounted.current){modal.current?.close();select(saved.id);setNote('');setTab('Overview');}
  }
  async function sendNote(){
    if(!strategy||!note.trim())return;
    const id=strategy.id,text=note;
    const saved=await save({operation:'NOTE',id,revision:strategy.revision,text});
    if(saved&&mounted.current){notes.current.delete(id);setNote('');}
  }
  function resize(clientX:number){if(!layout.current)return;const sidebar=layout.current.querySelector('aside')?.getBoundingClientRect().width??208;setChatWidth(Math.min(440,Math.max(320,clientX-layout.current.getBoundingClientRect().left-sidebar)));}
  const reportedHoldings = useMemo(()=>portfolio?.holdings.filter(h=>strategy?.instruments.includes(h.instrument))??[],[portfolio,strategy]);
  const heldStocks=useMemo(()=>balanceError?[]:[...new Set((portfolio?.holdings??[]).filter(h=>BigInt(h.atoms)>0n&&directory.some(r=>r.instrument===h.instrument)).map(h=>h.instrument))],[portfolio,balanceError,directory]);
  const togglePin=(ticker:string)=>setPinned(items=>items.includes(ticker)?items.filter(x=>x!==ticker):items.length<64?[...items,ticker]:items);

  return <main className={`rw-root rw-mobile-${mobile}`}>
    <h1 className="rw-sr">Research</h1>
    {importsOpen&&<section className="rw-imports" aria-label="Saved portfolio drafts"><div><h2>Start with a saved composition</h2><button className="rw-icon" aria-label="Close portfolio drafts" onClick={()=>setImportsOpen(false)}><Glyph name="close"/></button></div>{drafts.length?drafts.map(d=><button className="rw-import-item" key={d.id} onClick={()=>importDraft(d.draft)}><b>{d.draft.name||'Untitled portfolio'}</b><span>{d.draft.legs.map(l=>l.instrument).join(' · ')}</span><Glyph name="arrow"/></button>):<p>No portfolio drafts on this device. <button className="rw-link" onClick={openNew}>Choose stocks for a new strategy</button></p>}</section>}
    <div className="rw-mobile-bar"><button onClick={()=>setListOpen(!listOpen)} aria-expanded={listOpen}><Glyph name="list"/> Strategies</button><button aria-label="New strategy" onClick={openNew}><Glyph name="plus"/></button><div>{(['chat','report'] as const).map(v=><button key={v} onClick={()=>setMobile(v)} aria-pressed={mobile===v}>{v==='chat'?'Chat':'Market'}</button>)}</div></div>
    {error&&<div className="rw-error" role="alert"><span>{error}</span><button className="rw-link" onClick={()=>void load(selected)}>Reload</button><button aria-label="Dismiss error" onClick={()=>setError(null)}><Glyph name="close"/></button></div>}
    <div className={`rw-layout ${listOpen?'rw-list-open':''}`} ref={layout} style={{'--rw-chat':`${chatWidth}px`} as CSSProperties}>
      <aside className="rw-sidebar" aria-label="Your strategies">
        <div className="rw-sidebar-heading"><b>Strategies <span>{summaries.length||''}</span></b><button className="rw-icon" aria-label="New strategy" onClick={openNew}><Glyph name="plus"/></button></div>
        <label className="rw-search"><Glyph name="search"/><input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Find a strategy" aria-label="Find a strategy"/></label>
        <div className="rw-strategy-list">{loading&&!data?<p className="rw-quiet">Loading strategies…</p>:visibleStrategies.length?visibleStrategies.map(s=><button className={`rw-strategy ${selected===s.id?'selected':''}`} aria-current={selected===s.id?'true':undefined} key={s.id} disabled={busy} onClick={()=>select(s.id)}><span className="rw-strategy-title"><Glyph name="document"/><b>{s.name}</b></span><span>{s.instruments.slice(0,3).join(' · ')}{s.instruments.length>3&&` +${s.instruments.length-3}`}</span><small><i/> Draft<span>{date(s.updatedAt)}</span></small></button>):<div className="rw-side-empty"><p>{filter?'No matching strategies.':'No saved strategies'}</p></div>}</div>
        <button className="rw-import-shortcut" onClick={()=>{setImportsOpen(!importsOpen);setListOpen(false);}}><Glyph name="plus"/> Import portfolio</button>
        <div className="rw-sidebar-bottom"><Glyph name="lock"/><span>{wallet?'Private workspace':'Connect to save your ideas'}<small>{wallet?`${wallet.slice(0,5)}…${wallet.slice(-4)}`:'Your wallet, your research'}</small></span>{(!wallet||locked)&&<button className="rw-link" disabled={busy} onClick={()=>void unlock()}>{signing?'Approve in wallet…':wallet?'Sign in':'Connect'}</button>}</div>
      </aside>
      {listOpen&&<button className="rw-mobile-scrim" aria-label="Close strategy list" onClick={()=>setListOpen(false)}/>}
      <section className="rw-conversation" aria-label="Strategy conversation">
        <header className="rw-pane-heading"><div><Glyph name="thread"/><b>{strategy?.name??'New strategy'}</b></div>{strategy&&<button className="rw-icon" aria-label="Edit research brief" onClick={openEdit}><Glyph name="edit"/></button>}</header>
        <div className="rw-messages" ref={messages}>
          {wallet&&!locked&&<AgentBar agents={agents.agents} selectedId={boundAgentId} boundToStrategy={Boolean(strategy)} disabled={busy||interpreting||agent.running} onSelect={id=>void selectAgent(id)} onEdit={a=>{agents.setError(null);setAgentEditor({open:true,agent:a});}} onCreate={()=>{agents.setError(null);setAgentEditor({open:true,agent:null});}} extra={a=>a.approval==='AUTO_WITHIN_LIMITS'&&wallet&&isEvmWallet(wallet)?<AgentAgentic wallet={wallet}/>:null}/>}
          {strategy?<>
            <div className="rw-date-divider"><span>{date(strategy.createdAt)}</span></div>
            <article className="rw-message"><div className="rw-message-by"><span className="rw-avatar">You</span><span>Research brief</span><small>v{strategy.revision}</small></div><p>{strategy.objective}</p><div className="rw-brief-tags"><span>{amount(strategy.budget)} budget</span>{strategy.instruments.map(i=><button key={i} onClick={()=>{setFocus(i);setTab('Overview');setMobile('report');}}>{i}</button>)}</div></article>
            <ResearchRunControls agent={agent} strategy={strategy} onResults={()=>{setTab('Backtest');setMobile('report');}}/>
            {strategy.messages.map(n=><article className="rw-message rw-note" key={n.id}><div className="rw-message-by"><span className="rw-avatar">You</span><span>Research note</span><small>{date(n.createdAt)}</small></div><p>{n.text}</p></article>)}
          </>:!intake&&<div className="rw-start"><span className="rw-eyebrow">XTXC RESEARCH</span><h2>Start with an idea.</h2><p>A budget, a goal, or a few stocks.<br/>Describe it below. We’ll test the strategy.</p><div className="rw-suggestions"><button className="rw-starter" onClick={()=>chooseExample(`반도체로 100 ${stable}, 1년에 5% 목표로 연구해줘`)}>Semiconductors · 5% / year <Glyph name="arrow"/></button><button className="rw-starter" onClick={()=>chooseExample(`Compare NVDA, AMD and QQQ with 100 ${stable}, a 5% target over 1 year and a 15% maximum loss.`)}>Compare a few stocks <Glyph name="arrow"/></button></div><div className="rw-journey" aria-label="Research steps"><span>01 Research</span><span>02 Compare</span><span>03 Approve</span></div>{locked&&<button className="rw-link" disabled={busy} onClick={()=>void unlock()}>Sign in to see saved strategies</button>}</div>}
          {interpreting&&<p className="rw-caption" aria-live="polite">Reading your request…</p>}
          {intake&&<ResearchIntakeCard agent={boundAgent} asset={wallet&&isEvmWallet(wallet)?'USDT':'USDC'} draft={intake} setDraft={v=>{setIntake(v);runRequest.current=crypto.randomUUID();}} busy={busy||interpreting} onRun={()=>void runIntake()} onCancel={()=>setIntake(null)} onEdit={()=>{setForm(intake.brief);intakeEdit.current=true;setStockSearch('');modal.current?.showModal();}}/>}
        </div>
        <div className="rw-composer-area">
          {pickerOpen&&<section className="rw-pin-picker" aria-label="Optional research stocks"><header><b>Add stocks</b><button type="button" aria-label="Close stock picker" onClick={()=>setPickerOpen(false)}><Glyph name="close"/></button></header><label className="rw-search"><Glyph name="search"/><input autoFocus aria-label="Search optional stocks" value={pinSearch} onChange={e=>setPinSearch(e.target.value)} placeholder="Name or ticker"/></label>{heldStocks.length>0&&<div className="rw-held-pins"><span>From your wallet</span>{heldStocks.map(t=><button key={t} aria-pressed={pinned.includes(t)} disabled={!pinned.includes(t)&&pinned.length>=64} onClick={()=>togglePin(t)}>{t}</button>)}</div>}<div className="rw-pin-options">{directory.filter(r=>(r.instrument+' '+r.name).toLowerCase().includes(pinSearch.toLowerCase())).map(r=><button key={r.instrument} aria-pressed={pinned.includes(r.instrument)} disabled={!pinned.includes(r.instrument)&&pinned.length>=64} onClick={()=>togglePin(r.instrument)}><StockLogo market={directoryMarket(r)}/><span><b>{r.instrument}</b><small>{r.name}</small></span><Glyph name={pinned.includes(r.instrument)?'check':'plus'}/></button>)}</div></section>}
          <form className="rw-composer" onSubmit={e=>{e.preventDefault();void interpret();}}>
            {pinned.length>0&&<div className="rw-pinned">{pinned.map(t=><button type="button" key={t} aria-label={`Remove attached ${t}`} onClick={()=>togglePin(t)}>{t}<Glyph name="close"/></button>)}</div>}
            <label className="rw-sr" htmlFor="research-note">Your research request</label><textarea id="research-note" maxLength={4000} value={note} onChange={e=>{setNote(e.target.value);if(!wallet)guestRequest.current={text:e.target.value,stocks:pinned,submitted:false};if(selected)notes.current.set(selected,e.target.value);}} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();void interpret();}}} disabled={busy||interpreting} placeholder={intake?'Add what’s missing, or change anything…':strategy?'Change the budget, target or stocks…':'e.g. $100 in chip stocks, targeting 5% over a year'}/>
            <div><button className="rw-attach" type="button" aria-expanded={pickerOpen} disabled={busy||interpreting} onClick={()=>setPickerOpen(!pickerOpen)}><Glyph name="plus"/> Stocks <span>Optional</span></button><button type="submit" aria-label="Send research request" disabled={!note.trim()||busy||interpreting}><span>{interpreting?'Reading…':'Research'}</span><Glyph name="arrow"/></button></div>
          </form>
          {strategy&&<button className="rw-save-note" disabled={!note.trim()||busy||interpreting} onClick={()=>void sendNote()}>Save message as a note instead</button>}
        </div>
      </section>
      <div className="rw-resizer" role="separator" aria-label="Resize conversation" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={440} aria-valuenow={chatWidth} tabIndex={0} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setChatWidth(v=>Math.min(440,Math.max(320,v+(e.key==='ArrowRight'?16:-16))));}}} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))resize(e.clientX);}} onPointerUp={e=>e.currentTarget.releasePointerCapture(e.pointerId)}/>
      <section className="rw-report" aria-label="Research report">
        <div className="rw-tabs" role="tablist" aria-label="Report sections" onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const i=(tabs.indexOf(tab)+(e.key==='ArrowRight'?1:tabs.length-1))%tabs.length;setTab(tabs[i]);document.getElementById(`rw-tab-${tabs[i]}`)?.focus();}}}>{tabs.map(t=><button key={t} role="tab" id={`rw-tab-${t}`} aria-controls="rw-report-panel" aria-selected={tab===t} tabIndex={tab===t?0:-1} onClick={()=>setTab(t)}>{tabLabels[t]}</button>)}</div>
        <div className="rw-report-scroll" role="tabpanel" id="rw-report-panel" aria-labelledby={`rw-tab-${tab}`} tabIndex={0}>
          {tab==='Overview'&&<>
            <div className="rw-market-head"><div>{market&&<StockLogo market={directoryMarket(market)}/>}<div><b>{market?.name??'Choose a stock'}</b><small>{market?.instrument} · Stock</small></div></div><select aria-label="Research chart stock" value={market?.instrument??''} onChange={e=>setFocus(e.target.value)}>{directory.filter(r=>!chartUniverse||chartUniverse.includes(r.instrument)).map(r=><option key={r.instrument} value={r.instrument}>{r.instrument}</option>)}</select></div>
            {market&&<div className="rw-chart"><StockPriceChart key={market.instrument} instrument={market.instrument} observation={observation}/></div>}
            <div className="rw-chart-foot">{market&&<button className="rw-link" onClick={()=>onSelect(market.instrument)}>Trade {market.instrument} <Glyph name="arrow"/></button>}</div>
            {strategy&&<dl className="rw-metrics"><div><dt>Budget</dt><dd>{amount(strategy.budget)}</dd></div><div><dt>Stocks</dt><dd>{strategy.instruments.length}</dd></div><div><dt>Research</dt><dd className="rw-small-value">{agent.running?'Running':agent.run?.result?'Results ready':'Draft'}</dd></div></dl>}
          </>}
          {tab==='Backtest'&&<ResearchResults agent={agent} onActivity={()=>setTab('Execution')}/>}
          {tab==='Holdings'&&<><SectionTitle label="ALLOCATION" title="Targets & wallet holdings"/><p className="rw-description">Target weights are research inputs. Your wallet holdings remain separate.</p>{strategy?.weights.length?<><div className="rw-allocation-bar" aria-label="Target allocation">{strategy.weights.map((w,i)=><span key={w.instrument} style={{flex:w.weightBps,opacity:1-i*.035}} title={`${w.instrument} ${w.weightBps/100}%`}/>)}{Boolean(strategy.cashBps)&&<span style={{flex:strategy.cashBps!,background:'#424848'}} title={`Cash ${strategy.cashBps!/100}%`}/>}</div><div className="rw-table"><div className="rw-table-head"><span>Stock</span><span>Target</span><span>Wallet tokens</span></div>{strategy.weights.map(w=><div key={w.instrument}><b>{w.instrument}</b><span>{w.weightBps/100}%</span><span>{portfolio&&!balanceError?(portfolio.holdings.filter(h=>h.instrument===w.instrument).map(h=>`${exactTokenAmount(h.atoms,h.rawDecimals)} ${h.symbol}`).join(' · ')||'0'):'—'}</span></div>)}{Boolean(strategy.cashBps)&&<div><b>Cash</b><span>{strategy.cashBps!/100}%</span><span>—</span></div>}</div></>:<p className="rw-inline-empty">No target weights set. Import a saved portfolio to start with an allocation.</p>}
            {holdingsNote?<p className="rw-inline-empty">{holdingsNote}</p>:<><div className="rw-section-heading"><h3>Connected wallet</h3><button className="rw-link" onClick={onRefresh}>Refresh <Glyph name="refresh"/></button></div>{!wallet?<button className="rw-button" onClick={()=>void onConnect()}>Connect wallet</button>:balanceError?<p className="rw-inline-empty">Balances need refreshing.</p>:!portfolio?<p className="rw-inline-empty">Reading balances…</p>:<><p className="rw-caption">Observed {date(portfolio.observedAt)} · {strategy?'Stocks in this strategy':'Your stock tokens'}</p><div className="rw-wallet-holdings">{(strategy?reportedHoldings:portfolio.holdings).filter(h=>BigInt(h.atoms)>0n).map(h=><button key={h.mint} onClick={()=>onSelect(h.instrument)}><span><b>{h.instrument}</b><small>{h.symbol} · {h.issuer}</small></span><strong>{exactTokenAmount(h.atoms,h.rawDecimals)}</strong><Glyph name="arrow"/></button>)}{!(strategy?reportedHoldings:portfolio.holdings).some(h=>BigInt(h.atoms)>0n)&&<p className="rw-inline-empty">No matching stock tokens in this wallet.</p>}{portfolio.cash?.map(c=><div className="rw-cash" key={c.symbol}><span>{c.symbol}</span><b>{exactTokenAmount(c.atoms,c.decimals)}</b></div>)}</div></>}</>}</>}
          {tab==='Sources'&&<><SectionTitle label="PROVENANCE" title="Sources & observations"/><p className="rw-description">Market references and wallet records, with their observation times.</p><div className="rw-source-list"><Source title="Stock universe" type="XTXC catalog" detail={`${directory.length} listed instruments · exact token identities retained`}/><Source title={`${market?.instrument??'Stock'} price`} type={observation?.source??'No observation'} detail={observation?`${observation.observedAt ? date(observation.observedAt):'Timestamp unavailable'}${observation.stale?' · Last observed':''}`:'Select a stock to request price context.'}/><Source title="Reference chart" type="TradingView / token history" detail="Reference visualization only; not imported as a research or backtest dataset."/><Source title="Wallet holdings" type="Solana account observation" detail={portfolio?`Slot ${portfolio.stateSlot.toLocaleString()} · ${date(portfolio.observedAt)}`:'Connect your wallet to read its actual balances.'}/><Source title="Research history" type={agent.run?.result?`Verified release · ${agent.run.result.dataset.asOf}`:'Not attached'} detail={agent.run?.result?`Dataset ${agent.run.result.dataset.id}. ${agent.run.result.dataset.limitations.join(' ')}`:'Run research to attach a versioned price dataset.'}/>{agent.run?.result&&<Source title="AI research designer" type={`${agent.run.result.model.provider} · ${agent.run.result.model.model}`} detail={agent.run.result.proposal.rationale}/>}</div></>}
          {tab==='Execution'&&<><SectionTitle label="EXECUTION" title="Plans & trade records"/>{strategy&&<ResearchPlanExecution key={strategy.id} agent={agent} wallet={wallet} strategy={strategy} onRefresh={onRefresh}/>}{strategy&&<div className="rw-trade-links">{strategy.instruments.map(i=><button className="rw-button" key={i} onClick={()=>onSelect(i)}>Trade {i}<Glyph name="arrow"/></button>)}</div>}<div className="rw-section-heading"><h3>Wallet activity</h3><button className="rw-link" onClick={()=>void onHistory()}>Refresh <Glyph name="refresh"/></button></div><p className="rw-caption">Account-wide records. These trades are not attributed to this strategy.</p>{historyError&&<p className="rw-inline-empty">Sign in to refresh recorded orders.</p>}{orders.length?<div className="rw-orders">{orders.slice(0,30).map(o=><article key={o.preparedId}><div><b>{o.kind==='BASKET'?'Basket':o.side==='SELL'?'Stock sale':'Stock purchase'}</b><span className={o.receiptVerified?'rw-verified':''}>{o.receiptVerified?'Receipt verified':orderLabel(o.phase)}</span></div><small>{o.preparedId}</small>{/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(o.signature)&&<a href={`https://solscan.io/tx/${o.signature}`} target="_blank" rel="noopener noreferrer">View mainnet transaction <Glyph name="arrow"/></a>}</article>)}</div>:<p className="rw-inline-empty">No recorded trades loaded.</p>}<p className="rw-caption">Devnet plan receipts will be shown separately from mainnet trade receipts.</p></>}
        </div>
        {strategy&&<footer className="rw-report-footer"><span><Glyph name="lock"/> Private research</span><span>Saved {date(strategy.updatedAt)}</span></footer>}
      </section>
    </div>
    {agentEditor.open&&<AgentEditor key={agentEditor.agent?`${agentEditor.agent.id}:${agentEditor.agent.revision}`:'new'} initial={agentEditor.agent} controller={agents} onClose={()=>setAgentEditor({open:false,agent:null})} onSaved={a=>{if(!agentEditor.agent)void selectAgent(a.id);}}/>}
    <dialog ref={modal} className="rw-modal" aria-labelledby="rw-form-title" onCancel={e=>{if(busy)e.preventDefault();}}>
      <form onSubmit={e=>{e.preventDefault();void submitBrief();}}>
        <div className="rw-modal-heading"><h2 id="rw-form-title">{edit?'Edit strategy':'New strategy'}</h2><button type="button" className="rw-icon" aria-label="Close strategy form" disabled={busy} onClick={()=>modal.current?.close()}><Glyph name="close"/></button></div>
        <div className="rw-modal-body">
          <label className="rw-form-idea">Your idea<textarea autoFocus required rows={2} maxLength={4000} placeholder="What would you like to explore?" value={form.objective} onChange={e=>setForm({...form,objective:e.target.value})}/></label>
          <div className="rw-form-stock-heading"><b>Choose stocks</b><span>{form.instruments.length}/64</span></div>
          {form.instruments.length>0&&<div className="rw-selected-stocks">{form.instruments.map(i=><button key={i} type="button" aria-label={`Remove ${i}`} onClick={()=>setForm({...form,instruments:form.instruments.filter(s=>s!==i),weights:[],cashBps:null})}>{i}<Glyph name="close"/></button>)}</div>}
          <label className="rw-search"><Glyph name="search"/><input value={stockSearch} onChange={e=>setStockSearch(e.target.value)} placeholder="Find stocks" aria-label="Find allowed stocks"/></label>
          <div className="rw-stock-picker">{directory.filter(r=>(r.instrument+' '+r.name).toLowerCase().includes(stockSearch.toLowerCase())).map(r=>{const active=form.instruments.includes(r.instrument);return <button key={r.instrument} type="button" aria-pressed={active} disabled={!active&&form.instruments.length>=64} onClick={()=>setForm({...form,instruments:active?form.instruments.filter(i=>i!==r.instrument):[...form.instruments,r.instrument],weights:[],cashBps:null})}><StockLogo market={directoryMarket(r)}/><span><b>{r.instrument}</b><small>{r.name}</small></span><span className="rw-choice">{active?<Glyph name="check"/>:<Glyph name="plus"/>}</span></button>;})}</div>
          <div className="rw-form-bottom-fields"><label>Name<input required maxLength={80} placeholder="My strategy" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label><label>Budget · USD<input required inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?" value={form.budget} onChange={e=>setForm({...form,budget:e.target.value})}/></label></div>
          {form.weights.length>0&&<p className="rw-caption">Imported weights kept. Changing stocks clears the allocation.</p>}
          {error&&<p className="rw-form-error" role="alert">{error}</p>}
        </div>
        <div className="rw-modal-footer"><span><Glyph name="lock"/> Draft only · no trades</span><button type="submit" className="rw-button rw-primary" disabled={busy||form.instruments.length===0}>{busy?'Saving…':!wallet?'Connect to save':edit?'Save changes':'Save strategy'}<Glyph name="arrow"/></button></div>
      </form>
    </dialog>
  </main>;
}
function SectionTitle({title}:{label:string;title:string}){return <div className="rw-report-intro"><h2>{title}</h2></div>;}
function Source({title,type,detail}:{title:string;type:string;detail:string}){return <article><Glyph name="document"/><div><b>{title}</b><span>{type}</span><p>{detail}</p></div></article>;}
function Empty({icon,title,detail,children}:{icon:string;title:string;detail:string;children?:ReactNode}){return <div className="rw-empty-report"><Glyph name={icon}/><h2>{title}</h2><p>{detail}</p>{children}</div>;}
function Glyph({name}:{name:string}){
  const paths:Record<string,ReactNode>={plus:<path d="M12 5v14M5 12h14"/>,arrow:<path d="M5 12h14m-5-5 5 5-5 5"/>,chevron:<path d="m7 10 5 5 5-5"/>,close:<path d="m6 6 12 12M6 18 18 6"/>,search:<><circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/></>,lock:<><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,document:<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 13h8M8 17h5"/></>,thread:<path d="M20 11a8 8 0 0 1-8 8H5l-3 2V11a9 9 0 0 1 18 0ZM7 9h8M7 13h5"/>,check:<path d="m5 12 4 4L19 6"/>,edit:<><path d="m14 5 5 5M4 20l5-1L20 8a3 3 0 0 0-5-5L4 14v6Z"/></>,chart:<path d="M4 4v16h16M7 14l4-5 4 3 5-7"/>,list:<path d="M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1"/>,refresh:<><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>};
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]??paths.document}</svg>;
}
function AgentAgentic({wallet}:{wallet:string}){const agentic=useAgentic(wallet);return <AgenticConnect agentic={agentic}/>;}
