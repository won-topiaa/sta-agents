export const RESEARCH_API='/api/v1/stocklana/research';
const active=new Set(['QUEUED','RUNNING','WAITING_DATA','WAITING_MODEL']);
export function researchState(view){
 const run=view?.runs?.[0];
 if(!run)return{active:false,label:'Checking your saved research',error:null};
 const label={QUEUED:'Your research is queued',RUNNING:'Comparing strategies after trading costs',WAITING_DATA:'Waiting for verified price history',WAITING_MODEL:'Waiting for the research model'}[run.status]??'Research complete';
 return{active:active.has(run.status),label,error:['FAILED','SUPERSEDED'].includes(run.status)?run.error??'Research stopped. Send your idea again.':null};
}
export function followupQuestion(draft){
 const slots={budget:'a budget in dollars',stocks:'stocks or a theme',target:'a target return',horizon:'a time period'};
 return draft?.question??`Add ${draft.missing.map(k=>slots[k]??k).join(' and ')}. For example: $100, AI stocks, 5% in one year.`;
}
// The same rules and limits always save to the same agent: the request id is a hash of the profile, so asking again
// reuses that agent instead of adding another (an owner keeps at most 10).
export async function agentRequestId(profile){
 const d=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(profile))));
 const h=Array.from(d.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
 return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
// At the 10-agent limit a saved agent of the same style that may trade on its own runs the test, the same preset and
// rules first (newest first, as the server lists them). None: null.
export function closestAgent(agents,profile){
 const ids=p=>JSON.stringify((p?.rules??[]).map(r=>r.id).sort());
 const same=(Array.isArray(agents)?agents:[]).filter(a=>a?.id&&a.style===profile.style&&a.approval==='AUTO_WITHIN_LIMITS');
 return same.find(a=>a.preset===profile.preset&&ids(a)===ids(profile))??same.find(a=>a.preset===profile.preset)??same[0]??null;
}
const LIMIT=/10 agents/i,TRANSIENT=/connection|took too long|wallet changed|sign in|session/i;
// No classification sidecar, quote, approval or signing is a prerequisite for research.
// Per-request IDs survive retries at the corresponding service boundary.
// chooseAgent(draft) runs once the request is complete (its words and picks are known) and returns {profile, fallback}.
export async function beginResearch({api,text,draft,chooseAgent,ids,onDraft=()=>{},onStage=()=>{},onSaved=()=>{}}){
 onStage('Reading your idea');
 if(/@[a-z0-9_]{3,24}/i.test(text)){
   const resolved=await api('/api/mobile/social',{operation:'RESOLVE',prompt:text});
   if(resolved.sources?.length){const h=resolved.sources[0].handle;
     const p=await api(`/api/mobile/social?handle=${encodeURIComponent(h)}`);
     if(!p.profile?.allocation?.weights?.length)throw Error('This trader has not shared an allocation yet.');
     return{copy:p.profile};
   }
 }
 const b=await api('/api/mobile/research',{text,stocks:[],...(draft?{draft}:{})});
 if(!b.draft?.brief||!b.draft?.goal||!Array.isArray(b.draft.missing))throw Error('The research reply was incomplete. Send your idea again.');
 onDraft(b.draft);
 if(b.draft.missing.length)return{draft:b.draft,question:followupQuestion(b.draft)};
 onStage('Preparing your backtest');
 const choice=await chooseAgent(b.draft);
 // The agent's risk limits are the draft's.
 const risk={maxWeightBps:b.draft.goal.maxWeightBps,minCashBps:b.draft.goal.minCashBps,maxDrawdownBps:b.draft.goal.maxDrawdownBps};
 const save=async p=>{const profile={...p,risk};
   try{return{agent:(await api(`${RESEARCH_API}/agents`,{operation:'CREATE',requestId:await agentRequestId(profile),profile})).agent};}
   catch(e){if(!LIMIT.test(String(e?.message)))throw e;
     const agent=closestAgent((await api(`${RESEARCH_API}/agents`)).agents,profile);
     if(!agent)throw Error('You have 10 saved agents. Edit one at xtxc.trade/exchange?terminal=1, then send your idea again.');
     return{agent,reused:true};}};
 let saved,usedFallback=false;
 try{saved=await save(choice.profile);}
 catch(e){if(!choice.fallback||choice.fallback===choice.profile||TRANSIENT.test(String(e?.message)))throw e;
   saved=await save(choice.fallback);usedFallback=true;}   // a refused rule combination: the preset alone
 if(!saved.agent?.id)throw Error('The agent was not saved. Try again.');
 const created=await api(RESEARCH_API,{operation:'CREATE',requestId:ids.strategy,brief:{...b.draft.brief,agentId:saved.agent.id}});
 const strategy=created.strategy;if(!strategy?.id)throw Error('The research was not saved. Try again.');
 onSaved(strategy);
 onStage('Starting your backtest');
 await api(`${RESEARCH_API}/agent`,{operation:'RUN',strategyId:strategy.id,goal:b.draft.goal,requestId:ids.run});
 return{strategy,draft:b.draft,choice,agent:saved.agent,reused:Boolean(saved.reused),usedFallback};
}
