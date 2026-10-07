import { createHash, randomUUID } from 'node:crypto';
import { ResearchStore, ResearchStoreError } from './research-store.mjs';
import { normalizeProfile, clampGoal, agentSnapshot, AgentProfileError, PROFILE_SCHEMA } from './research-agent-profile.mjs';
import { BSC_RESEARCH_PRODUCTS } from './bsc-research-universe.mjs';

export const AGENT_VERSION = 'xtxc-research-agent/1';
export const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
export const hash = x => createHash('sha256').update(canonical(x)).digest('hex');
export const reject = (message, status=422) => { throw new ResearchStoreError(message,status); };
const integer = (v,min,max,name) => Number.isSafeInteger(v)&&v>=min&&v<=max?v:reject(`Check ${name}.`);
export function validateGoal(v) {
  if(!v||typeof v!=='object')reject('Set a return target, time horizon and loss limit.');
  return {
    targetReturnBps:integer(v.targetReturnBps,0,1000000,'target return'),
    horizonDays:integer(v.horizonDays,7,365,'time horizon'),
    maxDrawdownBps:integer(v.maxDrawdownBps,100,8000,'maximum drawdown'),
    maxWeightBps:integer(v.maxWeightBps,100,10000,'position limit'),
    minCashBps:integer(v.minCashBps,0,9500,'cash reserve'),
    costBps:integer(v.costBps,1,500,'assumed one-way trading cost'),
  };
}
// agentId is omitted (undefined) for strategies without an agent, so their hashes are unchanged.
export const briefHash = s => hash({name:s.name,objective:s.objective,budget:s.budget,instruments:s.instruments,weights:s.weights,cashBps:s.cashBps,agentId:s.agentId});
// BNB Smart Chain owners budget in USDT (18 decimals); Solana owners in USDC (6 decimals).
export const BSC_MIN_LEG_ATOMS = 5n*10n**18n;   // 5 USDT
export const chainOf = address => typeof address==='string'&&address.startsWith('eip155:56:')?'bsc':'solana';
export const budgetUnit = address => chainOf(address)==='bsc'?{asset:'USDT',decimals:18}:{asset:'USDC',decimals:6};
export function budgetAtoms(value,decimals=6) {
  if(typeof value!=='string'||!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(value)||Number(value)<=0)reject('Check the budget.');
  const [a,b='']=value.split('.'); return (BigInt(a)*10n**BigInt(decimals)+BigInt(b.padEnd(decimals,'0'))).toString();
}
export function allocateBudget(total, weights) {
  let sum=0; const rows=weights.map(w=>{sum+=integer(w.weightBps,0,10000,'allocation');return{instrument:w.instrument,inputAtoms:(BigInt(total)*BigInt(w.weightBps)/10000n).toString()};});
  if(sum>10000||new Set(rows.map(r=>r.instrument)).size!==rows.length)reject('Invalid strategy allocation.');
  // Rounding remains cash, never an extra debit; economic amounts stay integers.
  return {legs:rows.filter(r=>BigInt(r.inputAtoms)>0n),cashAtoms:(BigInt(total)-rows.reduce((n,r)=>n+BigInt(r.inputAtoms),0n)).toString()};
}

// BNB Chain sale legs: token -> USDT for whole holdings the gateway read on chain. Only this strategy's stocks and only
// the Ondo/bStock contracts listed for them; amounts are token atoms (18 decimals).
export function sellLegs(strategy, holdings) {
  if(!Array.isArray(holdings)||holdings.length>20)reject('Check the holdings to sell.');
  const seen=new Set(),legs=[];
  for(const h of holdings){
    const instrument=String(h?.instrument??''),contract=String(h?.contract??'').toLowerCase(),raw=String(h?.raw??'');
    if(!strategy.instruments.includes(instrument))reject(`${instrument||'This stock'} is not part of this strategy.`,409);
    const listed=Object.entries(BSC_RESEARCH_PRODUCTS[instrument]??{}).find(([,p])=>p?.contract?.toLowerCase()===contract);
    if(!listed)reject(`${instrument} is not a listed BNB Chain token for this strategy.`,409);
    if(!/^[1-9]\d{0,35}$/.test(raw))continue;   // nothing held: nothing to sell
    if(seen.has(contract))reject('Each holding can be sold once per plan.');
    seen.add(contract);
    const [platform,p]=listed;
    legs.push({side:'SELL',instrument,productContract:p.contract,productSymbol:p.symbol,platform,inputAtoms:raw,inputDecimals:p.decimals??18});
  }
  return legs;
}

export class AgentStore extends ResearchStore {
  constructor(path,allowed) {
    super(path,allowed);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,strategy TEXT NOT NULL,brief_hash TEXT NOT NULL,request_id TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(owner,request_id));
      CREATE INDEX IF NOT EXISTS agent_queue ON agent_runs(status,created_at);
      CREATE INDEX IF NOT EXISTS agent_owner ON agent_runs(owner,strategy,created_at);
      CREATE TABLE IF NOT EXISTS agent_plans(id TEXT PRIMARY KEY,owner TEXT NOT NULL,strategy TEXT NOT NULL,run_id TEXT NOT NULL,document TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(owner,run_id));
      CREATE TABLE IF NOT EXISTS agent_steps(plan_id TEXT NOT NULL,step INTEGER NOT NULL,phase TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(plan_id,step));
      CREATE TABLE IF NOT EXISTS agent_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,strategy TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_monitors(owner TEXT NOT NULL,strategy TEXT NOT NULL,document TEXT NOT NULL,next_at INTEGER NOT NULL,PRIMARY KEY(owner,strategy));
      CREATE TABLE IF NOT EXISTS agent_usage(day TEXT PRIMARY KEY,reserved INTEGER NOT NULL DEFAULT 0,actual INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS agent_rebalance_drafts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,run_id TEXT NOT NULL,candidate_id TEXT NOT NULL,report_hash TEXT NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_autonomy_claims(plan_id TEXT PRIMARY KEY,policy_id TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_profiles(id TEXT PRIMARY KEY,owner TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_profile_owner ON agent_profiles(owner,updated_at);
      CREATE TABLE IF NOT EXISTS agent_profile_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,agent_id TEXT NOT NULL,PRIMARY KEY(owner,request_id));
      CREATE TABLE IF NOT EXISTS agent_agentic_binding(slot TEXT PRIMARY KEY,owner TEXT NOT NULL,address TEXT NOT NULL,bound_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_agentic_runs(plan_id TEXT PRIMARY KEY,owner TEXT NOT NULL,address TEXT NOT NULL,status TEXT NOT NULL,reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    `);
  }
  // ---- the user's own agents (style + enforced rules + risk + approval mode)
  agents(address) {
    const owner=this.owner(address);
    return this.db.prepare('SELECT document FROM agent_profiles WHERE owner=? ORDER BY updated_at DESC LIMIT 20').all(owner).map(r=>JSON.parse(r.document));
  }
  agentProfile(owner,id) {
    const row=typeof id==='string'?this.db.prepare('SELECT document FROM agent_profiles WHERE owner=? AND id=?').get(owner,id):null;
    if(!row)reject('Agent not found.',404);
    return JSON.parse(row.document);
  }
  saveAgent(address,body) {
    const owner=this.owner(address);
    if(!body||typeof body.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(body.requestId)||!['CREATE','UPDATE'].includes(body.operation))reject('Invalid agent request.');
    const digest=hash({operation:body.operation,id:body.id??null,revision:body.revision??null,profile:body.profile});
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT digest,agent_id FROM agent_profile_requests WHERE owner=? AND request_id=?').get(owner,body.requestId);
      if(previous){if(previous.digest!==digest)reject('This request identifier was already used.',409);return this.agentProfile(owner,previous.agent_id);}
      if(this.db.prepare('SELECT count(*) n FROM agent_profile_requests WHERE owner=?').get(owner).n>=2000)reject('Agent edit limit reached.',429);
      let id,revision,created=Date.now();
      if(body.operation==='CREATE'){
        if(this.db.prepare('SELECT count(*) n FROM agent_profiles WHERE owner=?').get(owner).n>=10)reject('You have 10 agents. Edit an existing agent.',409);
        id=randomUUID();revision=1;
      }else{
        const current=this.agentProfile(owner,body.id);
        if(current.revision!==body.revision)reject('This agent changed in another tab. Reload it before saving.',409);
        id=current.id;revision=current.revision+1;created=this.db.prepare('SELECT created_at FROM agent_profiles WHERE id=?').get(id).created_at;
      }
      let doc;
      try{doc=normalizeProfile({...(body.profile??{}),schema:PROFILE_SCHEMA,id,revision});}
      catch(e){if(e instanceof AgentProfileError)reject(e.message,e.status);throw e;}
      const now=Date.now();
      this.db.prepare('INSERT INTO agent_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document=excluded.document,updated_at=excluded.updated_at').run(id,owner,revision,JSON.stringify(doc),created,now);
      this.db.prepare('INSERT INTO agent_profile_requests VALUES(?,?,?,?)').run(owner,body.requestId,digest,id);
      return doc;
    });
  }
  // Rejects a run, review or approval made under an older version of the agent.
  assertAgentCurrent(owner,agent) {
    if(!agent)return null;
    const current=this.agentProfile(owner,agent.id);
    if(current.revision!==agent.revision)reject('Your agent changed after this research. Run it again with the current rules.',409);
    return current;
  }
  // An agent set to approve every trade can never hand a plan to the agent wallet.
  assertAutonomyAllowed(address,plan) {
    if(!plan.agent)return;
    const current=this.agentProfile(this.owner(address),plan.agent.id);
    if(current.approval!=='AUTO_WITHIN_LIMITS')reject('This agent asks you to approve every trade. Change its approval setting to let it trade on its own.',409);
  }
  transaction(fn) {if(this.transactionActive)return fn();this.db.exec('BEGIN IMMEDIATE');this.transactionActive=true;try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.transactionActive=false;}}
  event(owner,strategy,kind,document={}) {this.db.prepare('INSERT INTO agent_events(owner,strategy,kind,document,created_at) VALUES(?,?,?,?,?)').run(owner,strategy,kind,JSON.stringify(document),Date.now());}
  enqueue(address,strategyId,goal,requestId) {
    const owner=this.owner(address),s=this.get(owner,strategyId);let g=validateGoal(goal);
    if(typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId))reject('Invalid run request.');
    // The agent bound to the strategy is copied into the run: research uses exactly this version.
    const agent=s.agentId?this.agentProfile(owner,s.agentId):null;
    if(agent)g=clampGoal(g,agent);
    const input={version:AGENT_VERSION,owner:address,strategy:s,goal:g,briefHash:briefHash(s),...(agent?{agent}:{})};
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM agent_runs WHERE owner=? AND request_id=?').get(owner,requestId);
      if(previous){if(hash(JSON.parse(previous.input))!==hash(input))reject('This run request was already used.',409);return previous.id;}
      if(this.db.prepare("SELECT count(*) n FROM agent_runs WHERE owner=? AND status IN ('QUEUED','RUNNING','WAITING_DATA','WAITING_MODEL')").get(owner).n>=3)reject('Finish or cancel an active research run first.',429);
      if(this.db.prepare('SELECT count(*) n FROM agent_runs WHERE owner=? AND created_at>?').get(owner,Date.now()-3600000).n>=12)reject('Research capacity reached for this hour.',429);
      const id=randomUUID(),now=Date.now();
      this.db.prepare('INSERT INTO agent_runs(id,owner,strategy,brief_hash,request_id,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,owner,s.id,input.briefHash,requestId,JSON.stringify(input),'QUEUED',now,now);
      this.event(owner,s.id,'QUEUED',{runId:id});return id;
    });
  }
  view(address,strategyId,after=0) {
    const owner=this.owner(address);this.get(owner,strategyId);integer(after,0,Number.MAX_SAFE_INTEGER,'event cursor');
    this.expireUnusedPlans(address);
    const runs=this.db.prepare('SELECT id,input,status,result,error,created_at,updated_at FROM agent_runs WHERE owner=? AND strategy=? ORDER BY created_at DESC LIMIT 20').all(owner,strategyId).map(r=>({id:r.id,goal:JSON.parse(r.input).goal,status:r.status,result:r.result?JSON.parse(r.result):null,error:r.error,createdAt:r.created_at,updatedAt:r.updated_at}));
    const plans=this.db.prepare('SELECT * FROM agent_plans WHERE owner=? AND strategy=? ORDER BY created_at DESC LIMIT 20').all(owner,strategyId).map(p=>({...JSON.parse(p.document),status:p.status,executionMode:this.db.prepare('SELECT 1 FROM agent_autonomy_claims WHERE plan_id=?').get(p.id)?'AGENT_WALLET':'MANUAL',steps:this.db.prepare('SELECT step,phase,document FROM agent_steps WHERE plan_id=? ORDER BY step').all(p.id).map(s=>({index:s.step,phase:s.phase,...JSON.parse(s.document)}))}));
    const events=this.db.prepare('SELECT cursor,kind,document,created_at FROM agent_events WHERE owner=? AND strategy=? AND cursor>? ORDER BY cursor LIMIT 200').all(owner,strategyId,after).map(e=>({cursor:e.cursor,kind:e.kind,...JSON.parse(e.document),at:e.created_at}));
    const monitor=this.db.prepare('SELECT document FROM agent_monitors WHERE owner=? AND strategy=?').get(owner,strategyId);
    return {owner:address,runs,plans,events,cursor:events.at(-1)?.cursor??after,monitor:monitor?JSON.parse(monitor.document):null};
  }
  cancel(address,id) {
    const owner=this.owner(address),r=this.db.prepare('SELECT * FROM agent_runs WHERE id=? AND owner=?').get(id,owner);if(!r)reject('Run not found.',404);
    if(!['QUEUED','RUNNING','WAITING_DATA','WAITING_MODEL'].includes(r.status))return;
    this.db.prepare("UPDATE agent_runs SET status='CANCELLED',lease_token=NULL,updated_at=? WHERE id=? AND owner=?").run(Date.now(),id,owner);this.event(owner,r.strategy,'CANCELLED',{runId:id});
  }
  claim(now=Date.now()) {
    return this.transaction(()=>{
      // A wait is not a data acquisition job. Never occupy all of an owner's
      // run slots forever while retrying the same absent file/provider.
      this.db.prepare("UPDATE agent_runs SET status='FAILED',error=COALESCE(error,'Research dependency unavailable.') || ' Retry after the dependency is restored.',lease_token=NULL,updated_at=? WHERE status IN ('WAITING_DATA','WAITING_MODEL') AND lease_until<? AND attempts>=3").run(now,now);
      this.db.prepare("UPDATE agent_runs SET status='FAILED',error='Worker interrupted repeatedly. Start a new run.',lease_token=NULL WHERE status='RUNNING' AND lease_until<? AND attempts>=3").run(now);
      const r=this.db.prepare("SELECT * FROM agent_runs WHERE status='QUEUED' OR (status='RUNNING' AND lease_until<? AND attempts<3) OR (status IN ('WAITING_DATA','WAITING_MODEL') AND lease_until<?) ORDER BY created_at LIMIT 1").get(now,now);
      if(!r)return null;
      const token=randomUUID();this.db.prepare("UPDATE agent_runs SET status='RUNNING',lease_until=?,lease_token=?,attempts=attempts+1,updated_at=? WHERE id=?").run(now+300000,token,now,r.id);
      this.event(r.owner,r.strategy,'RUNNING',{runId:r.id});return {...r,leaseToken:token,input:JSON.parse(r.input)};
    });
  }
  finish(run,status,result=null,error=null) {
    return this.transaction(()=>{
      const r=this.db.prepare("SELECT * FROM agent_runs WHERE id=? AND status='RUNNING' AND lease_token=?").get(run.id,run.leaseToken);if(!r)return false;
      const s=this.get(r.owner,r.strategy),agent=JSON.parse(r.input).agent;if(briefHash(s)!==r.brief_hash){status='SUPERSEDED';error='The research brief changed. Run the updated version.';}
      else if(agent&&this.db.prepare('SELECT revision FROM agent_profiles WHERE owner=? AND id=?').get(r.owner,agent.id)?.revision!==agent.revision){status='SUPERSEDED';error='Your agent changed during research. Run it again with the current rules.';}
      if(result)result={...result,reportHash:hash(result)};
      this.db.prepare('UPDATE agent_runs SET status=?,result=?,error=?,lease_until=?,lease_token=NULL,updated_at=? WHERE id=?').run(status,result?JSON.stringify(result):null,error,Date.now()+300000,Date.now(),r.id);
      this.event(r.owner,r.strategy,status,{runId:r.id,message:error});return true;
    });
  }
  reviewCandidate(address,runId,candidateId,reportHash) {
    const owner=this.owner(address),r=this.db.prepare('SELECT * FROM agent_runs WHERE id=? AND owner=?').get(runId,owner);
    if(!r||r.status!=='REVIEW')reject('A completed, eligible research run is required.',409);
    const input=JSON.parse(r.input),strategy=this.get(owner,r.strategy),result=JSON.parse(r.result),candidate=result.candidates.find(c=>c.id===candidateId);
    if(result.reportHash!==reportHash||briefHash(strategy)!==r.brief_hash||Date.now()-r.updated_at>86400000||candidate?.verdict!=='ELIGIBLE')reject('Review a current eligible result.',409);
    this.assertAgentCurrent(owner,input.agent);
    return{strategy,candidate,input};
  }
  saveRebalanceDraft(address,runId,candidateId,reportHash,allocation) {
    this.reviewCandidate(address,runId,candidateId,reportHash);
    const id=randomUUID(),document={...allocation,id,runId,candidateId,reportHash};
    this.db.prepare('INSERT INTO agent_rebalance_drafts VALUES(?,?,?,?,?,?,?)').run(id,this.owner(address),runId,candidateId,reportHash,JSON.stringify(document),Date.now());return document;
  }
  expireUnusedPlans(address,now=Date.now()) {
    const owner=this.owner(address);
    integer(now,1,Number.MAX_SAFE_INTEGER,'approval expiry time');
    return this.transaction(()=>{
      // Absence of an observed fill is NOT proof of non-execution. Only an
      // approval never reserved for a trade or handed to a signer can expire
      // here. BEGIN IMMEDIATE serializes this with reservation and delegation.
      const unused=this.db.prepare(`
        SELECT p.id,p.strategy,p.document FROM agent_plans p
        WHERE p.owner=? AND p.status='APPROVED'
          AND NOT EXISTS (SELECT 1 FROM agent_steps s WHERE s.plan_id=p.id)
          AND NOT EXISTS (SELECT 1 FROM agent_autonomy_claims c WHERE c.plan_id=p.id)
      `).all(owner);
      const expired=[];
      for(const row of unused){
        const expiresAt=JSON.parse(row.document).expiresAt;
        // Missing/malformed legacy timestamps are not authority to unlock.
        if(!Number.isSafeInteger(expiresAt)||expiresAt<=0||expiresAt>now)continue;
        this.db.prepare("UPDATE agent_plans SET status='EXPIRED' WHERE id=? AND owner=? AND status='APPROVED'").run(row.id,owner);
        this.event(owner,row.strategy,'APPROVAL_EXPIRED',{planId:row.id,expiresAt,observedAt:now,reason:'UNUSED_APPROVAL_DEADLINE'});
        expired.push(row.id);
      }
      // A sale the agent proposed lapses unanswered; the next daily check proposes it again if the rule still applies.
      for(const row of this.db.prepare("SELECT id,strategy,document FROM agent_plans WHERE owner=? AND status='PROPOSED'").all(owner)){
        const expiresAt=JSON.parse(row.document).expiresAt;
        if(!Number.isSafeInteger(expiresAt)||expiresAt>now)continue;
        this.db.prepare("UPDATE agent_plans SET status='EXPIRED' WHERE id=? AND status='PROPOSED'").run(row.id);
        this.event(owner,row.strategy,'PROPOSAL_EXPIRED',{planId:row.id});expired.push(row.id);
      }
      return expired;
    });
  }
  // options.sells (BNB Chain): holdings to sell first because the approved strategy no longer holds them.
  approve(address,runId,candidateId,reportHash,draftId=null,options={}) {
    const owner=this.owner(address);
    // Commit expiry independently: an invalid/repeated approval request must
    // not roll back cleanup and resurrect the owner's obsolete blocking plan.
    this.expireUnusedPlans(address);
    return this.transaction(()=>{
      const r=this.db.prepare('SELECT * FROM agent_runs WHERE id=? AND owner=?').get(runId,owner);
      if(!r||r.status!=='REVIEW')reject('A completed, eligible research run is required.',409);
      const input=JSON.parse(r.input),s=this.get(owner,r.strategy),result=JSON.parse(r.result);
      if(result.reportHash!==reportHash||briefHash(s)!==r.brief_hash)reject('The plan changed. Run and review the latest version.',409);
      if(Date.now()-r.updated_at>86400000)reject('Refresh this research before approving it.',409);
      const c=result.candidates.find(c=>c.id===candidateId);if(!c||c.verdict!=='ELIGIBLE')reject('This strategy did not pass the target and risk checks.',409);
      const agent=this.assertAgentCurrent(owner,input.agent);
      if(agent&&(!Array.isArray(c.agentChecks)||c.agentChecks.length!==agent.rules.length||c.agentChecks.some(x=>x.status!=='pass')))reject("This strategy does not show that every agent rule was kept.",409);
      if(!Array.isArray(c.weights)||!c.weights.length||c.weights.some(w=>!s.instruments.includes(w.instrument)||!Number.isSafeInteger(w.weightBps)||w.weightBps<0||w.weightBps>input.goal.maxWeightBps)||c.weights.reduce((n,w)=>n+w.weightBps,0)>10000-input.goal.minCashBps)reject('The strategy exceeds the approved universe or allocation limits.',409);
      const previous=this.db.prepare('SELECT * FROM agent_plans WHERE owner=? AND run_id=?').get(owner,runId);
      if(previous){if(previous.status==='EXPIRED')reject('This approval expired without a trade. Run and review a fresh strategy.',409);if(previous.status==='SUPERSEDED')reject('This unused approval was replaced by a newer plan.',409);const p=JSON.parse(previous.document);if(p.candidateId!==candidateId||(p.rebalanceDraftId??null)!==draftId)reject('This run already has a different approved allocation.',409);return p;}
      // Approval is a plan-local decision, not an account-wide execution lock.
      // Other strategies may keep trading. The signer serializes exact wallet
      // transactions and reserves shared balances at explicit Start instead.
      const unit=budgetUnit(address),bsc=chainOf(address)==='bsc';
      if(bsc&&draftId)reject('Holdings rebalancing is not available on BNB Chain yet.',409);
      const total=budgetAtoms(s.budget,unit.decimals);let a=allocateBudget(total,c.weights),rebalance=null;
      // BNB Chain venues refuse tiny orders (Ondo: about 5 USD). Such legs stay in cash instead of failing later.
      if(bsc){const min=BSC_MIN_LEG_ATOMS,small=a.legs.filter(l=>BigInt(l.inputAtoms)<min);
        if(small.length){a={legs:a.legs.filter(l=>BigInt(l.inputAtoms)>=min),cashAtoms:(BigInt(a.cashAtoms)+small.reduce((n,l)=>n+BigInt(l.inputAtoms),0n)).toString(),belowMinimum:small.map(l=>l.instrument)};}
        if(!a.legs.length)reject('Every purchase in this plan is below the 5 USDT minimum order. Raise the budget or choose fewer stocks.',409);}
      const sells=bsc&&options.sells?sellLegs(s,options.sells).filter(l=>!c.weights.some(w=>w.instrument===l.instrument&&w.weightBps>0)):[];
      if(draftId){const draft=this.db.prepare('SELECT * FROM agent_rebalance_drafts WHERE id=? AND owner=?').get(draftId,owner);if(!draft||draft.run_id!==runId||draft.candidate_id!==candidateId||draft.report_hash!==reportHash)reject('Review the matching holdings allocation.',409);rebalance=JSON.parse(draft.document);if(rebalance.expiresAt<Date.now())reject('Refresh the holdings review before approving.',409);a=rebalance;}
      const document={schema:'xtxc.research-plan/v1',owner:address,strategyId:s.id,briefHash:r.brief_hash,runId,candidateId,reportHash,goal:input.goal,budgetAtoms:total,budgetAsset:unit.asset,...(bsc?{chain:'eip155:56'}:{}),budgetScope:rebalance?'SELECTED_HOLDINGS_PLUS_NEW_CASH':'NEW_CAPITAL',universe:s.instruments,legs:[...sells,...a.legs.map(l=>({side:'BUY',inputDecimals:unit.decimals,...l}))],cashAtoms:a.cashAtoms,...(sells.length?{sells:sells.length,wallet:options.wallet==='AGENTIC'?'AGENTIC':'PERSONAL'}:{}),...(a.belowMinimum?{belowMinimum:a.belowMinimum}:{}),...(rebalance?{rebalanceDraftId:draftId,snapshot:rebalance.snapshot,heldValueAtoms:rebalance.heldValueAtoms,portfolioValueAtoms:rebalance.portfolioValueAtoms,cashFloorAtoms:rebalance.cashFloorAtoms}:{}),...(agent?{agent:agentSnapshot(agent)}:{}),maxSlippageBps:20,createdAt:Date.now(),expiresAt:Date.now()+3600000,nonce:randomUUID()};
      const id=hash(document),plan={...document,id};
      this.db.prepare('INSERT INTO agent_plans VALUES(?,?,?,?,?,?,?)').run(id,owner,s.id,runId,JSON.stringify(plan),'APPROVED',Date.now());this.event(owner,s.id,'APPROVED',{planId:id,runId});return plan;
    });
  }
  async refreshAutonomy(address,observe){
    const owner=this.owner(address),claims=this.db.prepare(`SELECT p.id,c.policy_id FROM agent_plans p JOIN agent_autonomy_claims c ON c.plan_id=p.id WHERE p.owner=? AND (p.status IN ('APPROVED','PARTIAL','UNKNOWN') OR EXISTS (SELECT 1 FROM agent_steps s WHERE s.plan_id=p.id AND s.phase IN ('UNKNOWN','SUBMITTED','FINALIZED'))) ORDER BY p.created_at LIMIT 20`).all(owner);
    for(const p of claims)this.syncAutonomy(address,p.id,await observe(address.slice(7),p.policy_id));
  }
  async approveReplacingUnused(address,runId,candidateId,reportHash,draftId,discardDraft,options={}) {
    // Compatibility for existing callers. New approvals coexist: never stop or
    // revoke another strategy as a side effect of this approval.
    return this.approve(address,runId,candidateId,reportHash,draftId,options);
  }
  async replaceUnusedApprovalLegacy(address,runId,candidateId,reportHash,draftId,discardDraft) {
    const approve=()=>this.approve(address,runId,candidateId,reportHash,draftId);
    try{return approve();}catch(e){if(e.message!=='Finish or revoke the previous plan before approving another.')throw e;}
    const owner=this.owner(address);
    const blockers=()=>this.db.prepare(`SELECT p.id,p.strategy,p.status,c.policy_id,
      (SELECT count(*) FROM agent_steps s WHERE s.plan_id=p.id) steps
      FROM agent_plans p LEFT JOIN agent_autonomy_claims c ON c.plan_id=p.id
      WHERE p.owner=? AND p.status IN ('APPROVED','PARTIAL','UNKNOWN') ORDER BY p.id`).all(owner);
    const expected=blockers();
    if(!expected.length||expected.some(p=>p.status!=='APPROVED'||p.steps!==0))reject('Finish or revoke the previous plan before approving another.',409);
    // Only the isolated authority service can prove a claimed draft was never
    // signed/submitted. It fences the draft before returning, so a late wallet
    // response cannot reactivate it. No client-provided status is trusted.
    for(const p of expected){
      if(!p.policy_id)continue;
      const proof=await discardDraft(address.slice(7),p.policy_id);
      if(proof?.id!==p.policy_id||proof?.planId!==p.id||proof?.phase!=='STOPPED'||proof?.reason!=='UNSIGNED_DRAFT_SUPERSEDED')reject('The previous wallet approval needs to be stopped before replacing it.',409);
    }
    return this.transaction(()=>{
      if(canonical(blockers())!==canonical(expected))reject('The previous approval changed. Review the latest plan.',409);
      for(const p of expected){
        this.db.prepare("UPDATE agent_plans SET status='SUPERSEDED' WHERE id=? AND owner=?").run(p.id,owner);
        this.event(owner,p.strategy,'APPROVAL_SUPERSEDED',{planId:p.id,nextRunId:runId,reason:'UNUSED_APPROVAL_REPLACED'});
      }
      // Nested synchronous operations share this transaction: replacement and
      // the new approval commit together, including final candidate validation.
      return approve();
    });
  }
  plan(address,id) {
    const owner=this.owner(address),p=this.db.prepare('SELECT * FROM agent_plans WHERE id=? AND owner=?').get(id,owner);if(!p)reject('Plan not found.',404);
    return {...JSON.parse(p.document),status:p.status};
  }
  claimAutonomy(address,id,policyId) {
    return this.transaction(()=>{
      const p=this.plan(address,id);
      if(p.status!=='APPROVED')reject('Review a current, unused allocation before connecting an agent wallet.',409);
      this.assertAutonomyAllowed(address,p);
      if(!/^[a-f0-9]{64}$/.test(policyId))reject('Invalid approval.',409);
      const old=this.db.prepare('SELECT policy_id FROM agent_autonomy_claims WHERE plan_id=?').get(id);
      if(old){if(old.policy_id!==policyId)reject('This allocation already has a wallet approval.',409);return;}
      if(p.status!=='APPROVED'||p.expiresAt<Date.now()||briefHash(this.get(this.owner(address),p.strategyId))!==p.briefHash||this.db.prepare('SELECT 1 FROM agent_steps WHERE plan_id=?').get(id))reject('Review a current, unused allocation before connecting an agent wallet.',409);
      this.db.prepare('INSERT INTO agent_autonomy_claims VALUES(?,?,?)').run(id,policyId,Date.now());
      this.event(this.owner(address),p.strategyId,'AGENT_WALLET_BOUND',{planId:id,policyId});
    });
  }
  assertManual(id){if(this.db.prepare('SELECT 1 FROM agent_autonomy_claims WHERE plan_id=?').get(id))reject('This allocation is assigned to your agent wallet. Use its execution controls.',409);}
  syncAutonomy(address,id,execution){
    return this.transaction(()=>{
      const p=this.plan(address,id),claim=this.db.prepare('SELECT policy_id FROM agent_autonomy_claims WHERE plan_id=?').get(id);
      if(!claim||execution.id!==claim.policy_id||execution.planId!==id)reject('Execution binding changed.',409);
      for(const o of execution.orders){
        if(!Number.isSafeInteger(o.index)||!p.legs[o.index]||o.instrument!==p.legs[o.index].instrument)reject('Execution leg changed.',409);
        const phase=o.phase==='RECONCILED'&&o.receipt?'RECONCILED':o.phase==='EXPIRED_UNSIGNED'?'EXPIRED_UNSENT':o.phase==='EXPIRED_NO_FILL'&&o.receipt?.schema==='xtxc.signed-expiry/v1'?'EXPIRED_NO_FILL':o.phase==='FAILED_FINALIZED'?'FAILED':'UNKNOWN';
        this.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?) ON CONFLICT(plan_id,step) DO UPDATE SET phase=excluded.phase,document=excluded.document').run(id,o.index,phase,JSON.stringify({leg:p.legs[o.index],observation:{signature:o.signature,receipt:o.receipt,wallet:execution.wallet,autonomyOrderId:o.id}}));
      }
      const status=['REVOKED','SUPERSEDED','EXPIRED'].includes(p.status)?p.status:execution.phase==='COMPLETE'?'COMPLETE':execution.phase==='STOPPED'?'REVOKED':execution.orders.some(o=>o.phase!=='RECONCILED')?'UNKNOWN':execution.orders.length?'PARTIAL':'APPROVED';
      this.db.prepare('UPDATE agent_plans SET status=? WHERE id=?').run(status,id);
    });
  }
  reserveStep(address,id,index) {
    return this.transaction(()=>{
      this.assertManual(id);
      const p=this.plan(address,id),owner=this.owner(address),s=this.get(owner,p.strategyId);
      if(p.chain)reject('Use the BNB Chain trade steps for this plan.',409);
      if(!['APPROVED','PARTIAL'].includes(p.status)||briefHash(s)!==p.briefHash||Date.now()>p.expiresAt)reject('This approval is no longer current.',409);
      integer(index,0,p.legs.length-1,'trade step');
      if(index>0&&this.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=? AND step=?').get(id,index-1)?.phase!=='RECONCILED')reject('Wait for the previous trade receipt.',409);
      const old=this.db.prepare('SELECT phase,document FROM agent_steps WHERE plan_id=? AND step=?').get(id,index);
      if(old){const doc=JSON.parse(old.document);if(old.phase==='PREPARED'&&Date.parse(doc.prepared.expiresAt)>Date.now())return{plan:p,existing:doc.prepared};reject('Check this trade before preparing another. No automatic replay.',409);}
      this.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?)').run(id,index,'PREPARING',JSON.stringify({leg:p.legs[index],at:Date.now()}));return{plan:p,existing:null};
    });
  }
  bindPrepared(address,id,index,prepared,quote) {
    const p=this.plan(address,id),rawOwner=address.slice(7),leg=p.legs[index];
    if(!['APPROVED','PARTIAL'].includes(p.status)||Date.now()>p.expiresAt||briefHash(this.get(this.owner(address),p.strategyId))!==p.briefHash)reject('This approval changed during preparation.',409);
    const match=leg.side==='SELL'?quote.schema==='skew.stockmesh.liquidation-quote/v1'&&quote.side==='SELL'&&quote.inputProduct?.mint===leg.productMint&&quote.inputProduct?.inputAtoms===leg.inputAtoms&&quote.output?.symbol==='USDC'&&BigInt(quote.output.minimumAtoms)>=BigInt(leg.minimumCashAtoms):quote.schema==='skew.stockmesh.exposure-quote/v2'&&quote.inAmountAtoms===leg.inputAtoms&&quote.inputSymbol==='USDC';
    if(prepared.owner!==rawOwner||prepared.quoteId!==quote.quoteId||quote.instrument!==leg.instrument||!match)reject('The prepared trade does not match the approved allocation.',409);
    const count=this.db.prepare("UPDATE agent_steps SET phase='PREPARED',document=? WHERE plan_id=? AND step=? AND phase='PREPARING'").run(JSON.stringify({leg:p.legs[index],prepared,at:Date.now()}),id,index).changes;
    if(!count)reject('Trade preparation lost its reservation.',409);
  }
  releaseUnsignedPreparation(address,id,index) {
    this.plan(address,id);
    // No bytes have been returned or signed in this branch. A retry may quote afresh.
    this.db.prepare("DELETE FROM agent_steps WHERE plan_id=? AND step=? AND phase='PREPARING'").run(id,index);
  }
  step(address,id,index) {
    const p=this.plan(address,id),r=this.db.prepare('SELECT * FROM agent_steps WHERE plan_id=? AND step=?').get(id,index);if(!r)reject('Trade not prepared.',409);
    return{plan:p,phase:r.phase,...JSON.parse(r.document)};
  }
  authorizeSubmit(address,id,index) {
    this.assertManual(id);
    const row=this.step(address,id,index),s=this.get(this.owner(address),row.plan.strategyId);
    if(!['APPROVED','PARTIAL','UNKNOWN'].includes(row.plan.status)||briefHash(s)!==row.plan.briefHash||Date.now()>row.plan.expiresAt||!['PREPARED','UNKNOWN','SUBMITTED'].includes(row.phase))reject('This trade approval is no longer valid.',409);
    return row;
  }
  recordStep(address,id,index,phase,observation={}) {
    const row=this.step(address,id,index);
    if(row.phase==='RECONCILED')return;
    this.db.prepare('UPDATE agent_steps SET phase=?,document=? WHERE plan_id=? AND step=?').run(phase,JSON.stringify({...row,plan:undefined,phase:undefined,observation}),id,index);
    const completed=this.db.prepare("SELECT count(*) n FROM agent_steps WHERE plan_id=? AND phase='RECONCILED'").get(id).n;
    const status=row.plan.status==='REVOKED'?'REVOKED':completed===row.plan.legs.length?'COMPLETE':phase==='UNKNOWN'?'UNKNOWN':completed?'PARTIAL':'APPROVED';
    this.db.prepare('UPDATE agent_plans SET status=? WHERE id=?').run(status,id);this.event(this.owner(address),row.plan.strategyId,'TRADE_STATUS',{planId:id,index,phase});
  }
  // ---- BNB Smart Chain legs: [exact approval ->] swap, each signed by the owner's wallet.
  // Step document: {leg, phase, prepared:{kind:'APPROVE'|'SWAP',tx,quote?,nonce,at}, sent?:{hash,kind}, receipts:[...]}
  bscStep(address,id,index) {
    const p=this.plan(address,id);
    if(p.chain!=='eip155:56')reject('This plan is not a BNB Chain plan.',409);
    integer(index,0,p.legs.length-1,'trade step');
    const row=this.db.prepare('SELECT phase,document FROM agent_steps WHERE plan_id=? AND step=?').get(id,index);
    return {plan:p,phase:row?.phase??'READY',doc:row?JSON.parse(row.document):{leg:p.legs[index],receipts:[]}};
  }
  assertBscPreparable(address,id,index,nonceNow) {
    this.assertManual(id);
    if(this.db.prepare('SELECT 1 FROM agent_agentic_runs WHERE plan_id=?').get(id))reject('This plan runs in your Agentic Wallet. Use its controls.',409);
    const {plan:p,phase,doc}=this.bscStep(address,id,index),s=this.get(this.owner(address),p.strategyId);
    if(!['APPROVED','PARTIAL'].includes(p.status)||briefHash(s)!==p.briefHash||Date.now()>p.expiresAt)reject('This approval is no longer current.',409);
    if(index>0&&this.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=? AND step=?').get(id,index-1)?.phase!=='RECONCILED')reject('Wait for the previous trade receipt.',409);
    if(['SUBMITTED','RECONCILED','UNKNOWN','APPROVE_SENT'].includes(phase))reject('Check this trade before preparing another. No automatic replay.',409);
    // A prepared transaction that was never reported may still have been sent: if the wallet has
    // sent anything since, do not build a second swap for the same leg.
    if(['SWAP_PREPARED','APPROVE_PREPARED'].includes(phase)&&doc.prepared&&BigInt(nonceNow)>BigInt(doc.prepared.nonce))
      reject('Your wallet sent a transaction after this trade was prepared. Report its hash or check it first.',409);
    return {plan:p,doc};
  }
  bscPrepared(address,id,index,kind,prepared,nonce) {
    const {plan:p,doc}=this.bscStep(address,id,index);
    const next={...doc,leg:p.legs[index],prepared:{kind,tx:prepared.tx,quote:prepared.quote??null,simulation:prepared.simulation??null,nonce:String(nonce),at:Date.now()}};
    this.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?) ON CONFLICT(plan_id,step) DO UPDATE SET phase=excluded.phase,document=excluded.document').run(id,index,kind==='APPROVE'?'APPROVE_PREPARED':'SWAP_PREPARED',JSON.stringify(next));
    this.event(this.owner(address),p.strategyId,'TRADE_STATUS',{planId:id,index,phase:kind==='APPROVE'?'APPROVE_PREPARED':'SWAP_PREPARED'});
    return next.prepared;
  }
  // The caller has verified that `hash` carries exactly doc.prepared.tx (checkSent).
  bscSent(address,id,index,hash) {
    const {plan:p,phase,doc}=this.bscStep(address,id,index);
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash))reject('Invalid transaction hash.');
    if(doc.sent?.hash===hash)return doc;
    if(!['SWAP_PREPARED','APPROVE_PREPARED'].includes(phase))reject('No prepared transaction for this step.',409);
    const kind=doc.prepared.kind,next={...doc,sent:{hash,kind,at:Date.now()}};
    const nextPhase=kind==='APPROVE'?'APPROVE_SENT':'SUBMITTED';
    this.db.prepare('UPDATE agent_steps SET phase=?,document=? WHERE plan_id=? AND step=?').run(nextPhase,JSON.stringify(next),id,index);
    this.db.prepare("UPDATE agent_plans SET status='UNKNOWN' WHERE id=? AND status IN ('APPROVED','PARTIAL') AND ?='SUBMITTED'").run(id,nextPhase);
    this.event(this.owner(address),p.strategyId,'TRADE_STATUS',{planId:id,index,phase:nextPhase,hash});
    return next;
  }
  bscReceipt(address,id,index,receipt) {
    const {plan:p,phase,doc}=this.bscStep(address,id,index);
    if(!doc.sent||!['APPROVE_SENT','SUBMITTED'].includes(phase))return doc;
    if(!receipt)return doc;   // still pending: never treated as success or failure
    const ok=receipt.status==='SUCCESS',approve=doc.sent.kind==='APPROVE';
    const nextPhase=approve?(ok?'ALLOWANCE_READY':'READY'):(ok?'RECONCILED':'FAILED');
    const next={...doc,receipts:[...(doc.receipts??[]),{hash:doc.sent.hash,kind:doc.sent.kind,...receipt}],...(approve||!ok?{sent:undefined,prepared:undefined}:{})};
    this.db.prepare('UPDATE agent_steps SET phase=?,document=? WHERE plan_id=? AND step=?').run(nextPhase,JSON.stringify(next),id,index);
    const done=this.db.prepare("SELECT count(*) n FROM agent_steps WHERE plan_id=? AND phase='RECONCILED'").get(id).n;
    const status=p.status==='REVOKED'?'REVOKED':done===p.legs.length?'COMPLETE':done?'PARTIAL':'APPROVED';
    this.db.prepare('UPDATE agent_plans SET status=? WHERE id=?').run(status,id);
    this.event(this.owner(address),p.strategyId,'TRADE_STATUS',{planId:id,index,phase:nextPhase,hash:doc.sent.hash});
    return next;
  }
  revoke(address,id) {
    const p=this.plan(address,id);this.db.prepare("UPDATE agent_plans SET status='REVOKED' WHERE id=?").run(id);this.event(this.owner(address),p.strategyId,'REVOKED',{planId:id});
    // Existing signed/submitted orders are not cancelled by changing this local plan.
  }
  monitor(address,strategyId,goal,enabled) {
    const owner=this.owner(address),s=this.get(owner,strategyId),g=validateGoal(goal);
    if(enabled&&this.db.prepare('SELECT count(*) n FROM agent_monitors WHERE owner=? AND strategy<>? AND json_extract(document,\'$.enabled\')=1').get(owner,strategyId).n>=3)reject('Monitor up to three research portfolios at a time.',429);
    const doc={enabled:enabled===true,mode:'RESEARCH_AND_ALERT',goal:g,briefHash:briefHash(s),owner:address,expiresAt:Date.now()+7*86400000,lastRelease:null,lastRunId:null,watch:null};
    this.db.prepare('INSERT INTO agent_monitors VALUES(?,?,?,?) ON CONFLICT(owner,strategy) DO UPDATE SET document=excluded.document,next_at=excluded.next_at').run(owner,strategyId,JSON.stringify(doc),Date.now());this.event(owner,strategyId,enabled?'MONITOR_ENABLED':'MONITOR_STOPPED');return doc;
  }
  reserveTokens(maximum,cap=100000) {
    const day=new Date().toISOString().slice(0,10);
    return this.transaction(()=>{this.db.prepare('INSERT OR IGNORE INTO agent_usage(day) VALUES(?)').run(day);const r=this.db.prepare('SELECT * FROM agent_usage WHERE day=?').get(day);if(r.reserved+r.actual+maximum>cap)return null;this.db.prepare('UPDATE agent_usage SET reserved=reserved+? WHERE day=?').run(maximum,day);return{day,maximum};});
  }
  tokenResult(ticket,actual=null) {this.db.prepare('UPDATE agent_usage SET reserved=reserved-?,actual=actual+? WHERE day=?').run(ticket.maximum,actual??ticket.maximum,ticket.day);}
}

// This checks a delegated authority supplied by a wallet adapter, not a login cookie.
// No production signer is installed by this module. A monitor can never promote itself.
export function checkDelegatedAuthority(m,order,usage,now=Date.now()) {
  if(!m||m.verifiedByWalletAdapter!==true||m.revoked||m.expiresAt<=now||m.owner!==order.owner||m.planHash!==order.planHash||m.chain!=='solana:mainnet')reject('A current wallet-enforced trading mandate is required.',403);
  if(!m.allowedMints.includes(order.inputMint)||!m.allowedMints.includes(order.outputMint)||order.receiver!==m.owner||order.maxSlippageBps>m.maxSlippageBps)reject('Order exceeds delegated asset or price limits.',403);
  if(BigInt(order.cashDebitAtoms)+BigInt(usage.cashDebitAtoms)>BigInt(m.maxCashDebitAtoms)||usage.turnoverBps+order.turnoverBps>m.maxDailyTurnoverBps||usage.lossBps>=m.maxLossBps)reject('Delegated budget or loss limit reached.',403);
  return true;
}
