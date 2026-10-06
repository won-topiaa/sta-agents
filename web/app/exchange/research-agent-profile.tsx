"use client";
import type React from 'react';
import {useCallback,useEffect,useRef,useState} from 'react';
import {AGENT_RULES,type AgentParamSpec} from '@/lib/agent-rules.mjs';
import {presetBody,profileBody,type AgentProfile,type AgentProfileBody,type AgentRule} from '@/lib/research-agent-profile.mjs';
import type {RuleSuggestion} from '@/lib/research-agent-suggest.mjs';
import {ensureResearchSession,researchPrincipalOf} from './research-session';
import './research-agent-profile.css';

// The owner's own agents. An agent shapes how research is designed (style, enforced
// rules, risk limits); it never signs or approves anything by itself.
const api='/api/v1/stocklana/research/agents';
const pct=(bps:number)=>`${(bps/100).toLocaleString('en-US',{maximumFractionDigits:1})}%`;
export function formatParam(spec:AgentParamSpec,value:number){
  if(spec.display==='percent')return `${Math.round(value*1000)/10}%`;
  return String(value);
}
export function ruleText(rule:AgentRule){
  const spec=AGENT_RULES.rules[rule.id];if(!spec)return rule.id;
  return spec.help.replace(/\{(\w+)\}/g,(_,k:string)=>spec.params[k]?formatParam(spec.params[k],rule.params[k]??spec.params[k].default):k);
}
export const ruleLabel=(id:string)=>AGENT_RULES.rules[id]?.label??id;
export const approvalText={PER_TRADE:'You approve every trade',AUTO_WITHIN_LIMITS:'Trades on its own within limits'} as const;

// The workspace remounts per wallet, so this state never outlives an account.
export function useAgents(wallet:string|null){
  const [agents,setAgents]=useState<AgentProfile[]|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const load=useCallback(()=>wallet?fetch(api,{cache:'no-store',headers:{'X-Skew-Expected-Requester':researchPrincipalOf(wallet)},signal:AbortSignal.timeout(10000)})
    .then(async r=>{const b=await r.json();return r.ok&&b.owner===researchPrincipalOf(wallet)?b.agents as AgentProfile[]:null;}).catch(()=>null):Promise.resolve(null),[wallet]);
  const refresh=useCallback(async()=>{const list=await load();if(list&&live.current)setAgents(list);},[load]);   // keeps the last list on failure
  useEffect(()=>{let current=true;void load().then(list=>{if(list&&current)setAgents(list);});return()=>{current=false;};},[load]);
  async function post(payload:Record<string,unknown>,timeout=15000){
    if(!wallet)throw new Error('Connect your wallet to save an agent.');
    await ensureResearchSession(wallet);
    const r=await fetch(api,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Skew-Expected-Requester':researchPrincipalOf(wallet)},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)}),b=await r.json();
    if(!r.ok)throw new Error(b.error?.message??'Request was not completed.');return b;
  }
  async function save(body:AgentProfileBody,existing:AgentProfile|null,requestId:string){
    setBusy(true);setError(null);
    try{const b=await post(existing?{operation:'UPDATE',id:existing.id,revision:existing.revision,requestId,profile:body}:{operation:'CREATE',requestId,profile:body});if(live.current)setAgents(b.agents);return b.agent as AgentProfile;}
    catch(e){if(live.current)setError(e instanceof Error?e.message:'Could not save the agent.');return null;}
    finally{if(live.current)setBusy(false);}
  }
  async function suggest(text:string,style:string){
    return await post({operation:'SUGGEST_RULES',text,style},30000) as {suggestions:RuleSuggestion[];unsupported:string[]};
  }
  return{agents,error,setError,busy,refresh,save,suggest};
}
export type AgentsController=ReturnType<typeof useAgents>;

export function AgentBar({agents,selectedId,boundToStrategy,disabled,onSelect,onEdit,onCreate,extra}:{agents:AgentProfile[]|null;selectedId:string|null;boundToStrategy:boolean;disabled:boolean;onSelect:(id:string|null)=>void;onEdit:(a:AgentProfile)=>void;onCreate:()=>void;extra?:(agent:AgentProfile)=>React.ReactNode}){
  const agent=agents?.find(a=>a.id===selectedId)??null;
  if(!agents)return null;
  if(!agents.length)return <section className="ap-bar ap-empty" aria-label="Your agent"><div><b>Research with your own agent</b><p>Give it an investing style and rules. Every strategy it designs keeps them.</p></div><button className="rw-button" disabled={disabled} onClick={onCreate}>Create agent</button></section>;
  return <section className="ap-bar" aria-label="Your agent">
    <div className="ap-bar-head">
      <span className="ap-avatar" aria-hidden="true">{(agent?.name??'—').slice(0,1).toUpperCase()}</span>
      <label className="ap-select"><span className="rw-sr">Agent for {boundToStrategy?'this strategy':'new research'}</span>
        <select value={selectedId??''} disabled={disabled} onChange={e=>e.target.value==='__new'?onCreate():onSelect(e.target.value||null)}>
          <option value="">No agent</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}<option value="__new">New agent…</option>
        </select></label>
      {agent&&<button className="rw-link" disabled={disabled} onClick={()=>onEdit(agent)}>Edit</button>}
    </div>
    {agent?<>
      <p className="ap-bar-meta">{AGENT_RULES.styles[agent.style]?.label} · {AGENT_RULES.styles[agent.style]?.presets[agent.preset]?.label} · {agent.rebalance==='weekly'?'Weekly':'Monthly'} rebalance</p>
      <div className="ap-chips">{agent.rules.length?agent.rules.map(r=><span key={r.id} title={ruleText(r)}>{ruleLabel(r.id)}</span>):<span>No enforced rules</span>}</div>
      <p className="ap-bar-limits">Max {pct(agent.risk.maxWeightBps)} per stock · cash ≥ {pct(agent.risk.minCashBps)} · loss ≤ {pct(agent.risk.maxDrawdownBps)} · <b>{approvalText[agent.approval]}</b></p>
      {extra?.(agent)}
    </>:<p className="ap-bar-meta">{boundToStrategy?'This strategy researches without an agent.':'New research runs without an agent.'}</p>}
  </section>;
}

type Draft=AgentProfileBody;
// Mounted only while open (keyed by agent and revision), so every opening starts from the saved agent.
export function AgentEditor({initial,controller,onClose,onSaved}:{initial:AgentProfile|null;controller:AgentsController;onClose:()=>void;onSaved:(a:AgentProfile)=>void}){
  const dialog=useRef<HTMLDialogElement>(null),requestId=useRef('');
  const [draft,setDraft]=useState<Draft>(()=>initial?profileBody(initial):presetBody('My agent'));
  const [suggestions,setSuggestions]=useState<{suggestions:RuleSuggestion[];unsupported:string[]}|null>(null),[suggesting,setSuggesting]=useState(false),[suggestError,setSuggestError]=useState<string|null>(null);
  useEffect(()=>{const d=dialog.current;requestId.current=crypto.randomUUID();if(d&&!d.open)d.showModal();return()=>d?.close();},[]);
  const style=AGENT_RULES.styles[draft.style],lim=AGENT_RULES.limits;
  const set=(d:Partial<Draft>)=>{setDraft(old=>({...old,...d}));requestId.current=crypto.randomUUID();};
  const active=new Map(draft.rules.map(r=>[r.id,r]));
  const filters=draft.rules.filter(r=>AGENT_RULES.rules[r.id]?.filter).length;
  function toggle(id:string){
    const spec=AGENT_RULES.rules[id];
    if(active.has(id))set({rules:draft.rules.filter(r=>r.id!==id),preset:'custom'});
    else set({rules:[...draft.rules,{id,params:Object.fromEntries(Object.entries(spec.params).map(([k,p])=>[k,p.default]))}],preset:'custom'});
  }
  function param(id:string,k:string,v:number){set({rules:draft.rules.map(r=>r.id===id?{...r,params:{...r.params,[k]:v}}:r),preset:'custom'});}
  function choosePreset(name:string){const p=presetBody(draft.name,draft.style,name);set({preset:name,rules:p.rules,rebalance:p.rebalance});}
  function addSuggestion(s:RuleSuggestion){set({rules:[...draft.rules.filter(r=>r.id!==s.id),{id:s.id,params:s.params}],preset:'custom'});}
  async function suggest(){
    if(!draft.philosophy.trim()||suggesting)return;setSuggesting(true);setSuggestError(null);
    try{setSuggestions(await controller.suggest(draft.philosophy,draft.style));}catch(e){setSuggestError(e instanceof Error?e.message:'Could not suggest rules.');}finally{setSuggesting(false);}
  }
  async function submit(){const saved=await controller.save(draft,initial,requestId.current);if(saved){onSaved(saved);onClose();}}
  const risk=(k:keyof Draft['risk'],label:string,min:number,max:number)=><label>{label}<input type="number" min={min} max={max} step="0.5" value={draft.risk[k]/100} onChange={e=>set({risk:{...draft.risk,[k]:Math.round(Number(e.target.value)*100)}})}/></label>;
  return <dialog ref={dialog} className="rw-modal ap-modal" aria-labelledby="ap-title" onCancel={e=>{e.preventDefault();if(!controller.busy)onClose();}}>
    <form onSubmit={e=>{e.preventDefault();void submit();}}>
      <div className="rw-modal-heading"><h2 id="ap-title">{initial?'Edit agent':'New agent'}</h2><button type="button" className="rw-icon" aria-label="Close agent editor" disabled={controller.busy} onClick={onClose}>×</button></div>
      <div className="rw-modal-body ap-body">
        <label className="ap-field">Name<input required maxLength={lim.name_chars} value={draft.name} onChange={e=>set({name:e.target.value})}/></label>

        <fieldset className="ap-group"><legend>Investing style</legend><div className="ap-cards">
          {Object.entries(AGENT_RULES.styles).map(([id,s])=><label key={id} className={`ap-card ${s.available?'':'ap-disabled'}`}><input type="radio" name="ap-style" value={id} checked={draft.style===id} disabled={!s.available} onChange={()=>set({...presetBody(draft.name,id,Object.keys(s.presets)[0]),name:draft.name,philosophy:draft.philosophy,risk:draft.risk,approval:draft.approval})}/><b>{s.label}</b><small>{s.help}</small></label>)}
        </div></fieldset>

        {style&&<fieldset className="ap-group"><legend>Start from</legend><div className="ap-presets" role="group">
          {Object.entries(style.presets).map(([id,p])=><button type="button" key={id} aria-pressed={draft.preset===id} title={p.help} onClick={()=>choosePreset(id)}>{p.label}</button>)}
        </div><small className="ap-hint">{style.presets[draft.preset]?.help}</small></fieldset>}

        <fieldset className="ap-group"><legend>Rules <span>{draft.rules.length}/{lim.rules} · filters {filters}/{lim.filters}</span></legend>
          <p className="ap-hint">Code adds these to every strategy your agent designs. The model cannot drop or loosen them.</p>
          <div className="ap-rules">{Object.entries(AGENT_RULES.rules).filter(([,r])=>r.styles.includes(draft.style)).map(([id,spec])=>{
            const rule=active.get(id),on=Boolean(rule),full=!on&&(draft.rules.length>=lim.rules||(Boolean(spec.filter)&&filters>=lim.filters));
            return <div key={id} className={`ap-rule ${on?'ap-on':''}`}>
              <label className="ap-rule-head"><input type="checkbox" checked={on} disabled={full} onChange={()=>toggle(id)}/><b>{spec.label}</b></label>
              <small>{ruleText(rule??{id,params:Object.fromEntries(Object.entries(spec.params).map(([k,p])=>[k,p.default]))})}</small>
              {rule&&<div className="ap-params">{Object.entries(spec.params).map(([k,p])=>{
                const v=rule.params[k]??p.default;
                return 'options' in p?<label key={k}>{k.replace('_',' ')}<select value={v} onChange={e=>param(id,k,Number(e.target.value))}>{p.options.map(o=><option key={o} value={o}>{formatParam(p,o)}</option>)}</select></label>
                  :<label key={k}>{k.replace('_',' ')} <output>{formatParam(p,v)}</output><input type="range" min={p.min} max={p.max} step={p.step} value={v} onChange={e=>param(id,k,Number(e.target.value))}/></label>;
              })}</div>}
            </div>;})}
          </div>
        </fieldset>

        <fieldset className="ap-group"><legend>In your own words <span>optional</span></legend>
          <textarea rows={3} maxLength={lim.philosophy_chars} placeholder="e.g. I buy strong stocks on pullbacks and avoid anything that has run up too fast." value={draft.philosophy} onChange={e=>{set({philosophy:e.target.value});setSuggestions(null);}}/>
          <div className="ap-suggest-row"><small>The model only suggests rules from the list above. You decide what to add.</small><button type="button" className="rw-button" disabled={!draft.philosophy.trim()||suggesting} onClick={()=>void suggest()}>{suggesting?'Reading…':'Suggest rules'}</button></div>
          {suggestError&&<p className="ra-error" role="alert">{suggestError}</p>}
          {suggestions&&<div className="ap-suggestions" aria-live="polite">
            {suggestions.suggestions.length===0&&<p className="ap-hint">No rule in the list matches this description.</p>}
            {suggestions.suggestions.map(s=>{const added=active.get(s.id);return <div key={s.id}><span><b>{ruleLabel(s.id)}</b><small>{ruleText(s)}</small><q>{s.evidence}</q></span><button type="button" className="rw-link" disabled={Boolean(added&&JSON.stringify(added.params)===JSON.stringify(s.params))} onClick={()=>addSuggestion(s)}>{added?'Use these settings':'Add'}</button></div>;})}
            {suggestions.unsupported.length>0&&<p className="ap-hint">Not expressible as a rule yet: {suggestions.unsupported.map(u=>`“${u}”`).join(', ')}</p>}
          </div>}
        </fieldset>

        <fieldset className="ap-group"><legend>Risk limits</legend><div className="ap-risk">{risk('maxWeightBps','Per stock · max %',1,100)}{risk('minCashBps','Cash · min %',0,95)}{risk('maxDrawdownBps','Loss · max %',1,80)}</div>
          <small className="ap-hint">Research targets can be stricter than these, never looser.</small></fieldset>

        <fieldset className="ap-group"><legend>Rebalance</legend><div className="ap-presets" role="group">{(['weekly','monthly'] as const).map(r=><button type="button" key={r} aria-pressed={draft.rebalance===r} onClick={()=>set({rebalance:r})}>{r==='weekly'?'Weekly':'Monthly'}</button>)}</div></fieldset>

        <fieldset className="ap-group"><legend>Trade approval</legend><div className="ap-cards">
          <label className="ap-card"><input type="radio" name="ap-approval" checked={draft.approval==='PER_TRADE'} onChange={()=>set({approval:'PER_TRADE'})}/><b>Approve every trade <span className="ap-tag">Recommended</span></b><small>Your wallet asks you to sign each purchase or sale.</small></label>
          <label className="ap-card"><input type="radio" name="ap-approval" checked={draft.approval==='AUTO_WITHIN_LIMITS'} onChange={()=>set({approval:'AUTO_WITHIN_LIMITS'})}/><b>Trade on its own within limits</b><small>After you approve a plan once, your agent wallet executes exactly that plan. You can stop it at any time.</small></label>
        </div></fieldset>
        {controller.error&&<p className="rw-form-error" role="alert">{controller.error}</p>}
      </div>
      <div className="rw-modal-footer"><span>Rules shape research. Trades still need your approval.</span><button type="submit" className="rw-button rw-primary" disabled={controller.busy||!draft.name.trim()}>{controller.busy?'Saving…':initial?'Save changes':'Create agent'}</button></div>
    </form>
  </dialog>;
}

export function AgentChecks({checks,agentName}:{checks:{rule:string;params:Record<string,number>;status:'pass'|'fail'}[];agentName?:string}){
  if(!checks.length)return null;const kept=checks.filter(c=>c.status==='pass').length;
  return <details className="ap-checks"><summary><b>{agentName?`${agentName}'s rules`:'Agent rules'}</b> · {kept} of {checks.length} kept in the tested strategy</summary>
    <ul>{checks.map(c=><li key={c.rule} className={c.status==='pass'?'':'ap-fail'}><span>{c.status==='pass'?'Kept':'Missing'}</span><b>{ruleLabel(c.rule)}</b><small>{ruleText({id:c.rule,params:c.params})}</small></li>)}</ul></details>;
}
