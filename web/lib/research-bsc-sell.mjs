import {randomUUID} from 'node:crypto';
import {reject,hash,briefHash,sellLegs,chainOf} from './research-agent-core.mjs';
import {agentSnapshot} from './research-agent-profile.mjs';
import {BSC_RESEARCH_PRODUCTS,bscProduct} from './bsc-research-universe.mjs';
import {agenticBinding,startAgentic} from './research-agentic.mjs';

// BNB Chain sales: stock token -> USDT for whole holdings, read on chain by the gateway.
//  CLOSE  the owner closes positions from the Trades tab (approved by that click).
//  EXIT   the agent's exit rule fired in the daily check. Per-trade agents get a PROPOSED plan that waits for the
//         owner; agents allowed to trade on their own sell through the Agentic Wallet at once.
// A sale runs from the wallet that holds the tokens: PERSONAL (owner signs each step) or AGENTIC (Agentic Wallet).
const OPEN=['PROPOSED','APPROVED','PARTIAL','UNKNOWN'];

function ensure(store){
  store.db.exec('CREATE TABLE IF NOT EXISTS agent_worker_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');
}
// The Ondo and bStock contracts of a strategy's stocks: what the gateway reads for holdings.
export function strategyContracts(strategy){
  return strategy.instruments.flatMap(instrument=>Object.entries(BSC_RESEARCH_PRODUCTS[instrument]??{}).filter(([,p])=>p?.contract)
    .map(([platform,p])=>({instrument,platform,contract:p.contract.toLowerCase(),symbol:p.symbol,decimals:p.decimals??18})));
}
// Gateway reply {holdings:[{contract,raw}]} joined to those contracts; zero balances are dropped.
export function holdingsFor(strategy,reply){
  const raw=new Map((Array.isArray(reply?.holdings)?reply.holdings:[]).map(h=>[String(h.contract).toLowerCase(),String(h.raw)]));
  return strategyContracts(strategy).map(c=>({...c,raw:raw.get(c.contract)??'0'})).filter(h=>/^[1-9]\d{0,35}$/.test(h.raw));
}
export async function readHoldings(gw,wallet,contracts){
  if(!contracts.length)return {holdings:[]};
  if(contracts.length>40)reject('Too many stocks to read at once.');
  return gw('GET',`/v1/holdings?address=${wallet}&tokens=${contracts.join(',')}`);
}
// The wallet that holds a strategy's tokens: the Agentic Wallet for an agent that trades on its own (when bound to
// this owner), otherwise the owner's own wallet.
export function saleWallet(store,address,strategy){
  const owner=store.owner(address),agent=strategy.agentId?store.agentProfile(owner,strategy.agentId):null,b=agenticBinding(store);
  return agent?.approval==='AUTO_WITHIN_LIMITS'&&b?.owner===owner?{kind:'AGENTIC',address:b.address}:{kind:'PERSONAL',address:address.slice('eip155:56:'.length)};
}

export function createSellPlan(store,address,strategyId,{kind,holdings,wallet='PERSONAL',reason=null,proposed=false}){
  const owner=store.owner(address),s=store.get(owner,strategyId);
  if(chainOf(address)!=='bsc')reject('Selling here is available for BNB Chain wallets.',409);
  if(!['CLOSE','EXIT'].includes(kind)||!['PERSONAL','AGENTIC'].includes(wallet))reject('Invalid sale.');
  const legs=sellLegs(s,holdings);
  if(!legs.length)reject('Nothing to sell: this wallet holds none of these stock tokens.',409);
  const agent=s.agentId?store.agentProfile(owner,s.agentId):null;
  return store.transaction(()=>{
    // One open sale per holding: never queue two sales of the same tokens.
    const busy=new Set(store.db.prepare(`SELECT document FROM agent_plans WHERE owner=? AND strategy=? AND status IN (${OPEN.map(()=>'?').join(',')})`).all(owner,s.id,...OPEN)
      .flatMap(r=>JSON.parse(r.document).legs.filter(l=>l.side==='SELL').map(l=>l.productContract.toLowerCase())));
    if(legs.some(l=>busy.has(l.productContract.toLowerCase())))reject('A sale of this holding is already open. Finish or revoke it first.',409);
    const now=Date.now(),runId=`${kind.toLowerCase()}:${randomUUID()}`;
    const document={schema:'xtxc.research-plan/v1',kind,owner:address,strategyId:s.id,briefHash:briefHash(s),runId,candidateId:kind,reportHash:null,goal:null,
      budgetAtoms:'0',budgetAsset:'USDT',chain:'eip155:56',budgetScope:'SELL_HOLDINGS',wallet,universe:s.instruments,legs,cashAtoms:'0',
      ...(reason?{reason}:{}),...(agent?{agent:agentSnapshot(agent)}:{}),maxSlippageBps:100,createdAt:now,expiresAt:now+(proposed?86400000:3600000),nonce:randomUUID()};
    const id=hash(document),status=proposed?'PROPOSED':'APPROVED';
    store.db.prepare('INSERT INTO agent_plans VALUES(?,?,?,?,?,?,?)').run(id,owner,s.id,runId,JSON.stringify({...document,id}),status,now);
    store.event(owner,s.id,proposed?'EXIT_PROPOSED':'SALE_APPROVED',{planId:id,kind,instruments:legs.map(l=>l.instrument)});
    return {...document,id,status};
  });
}

// The owner accepts a sale the agent proposed.
export function approveProposed(store,address,id){
  const owner=store.owner(address);
  return store.transaction(()=>{
    const row=store.db.prepare('SELECT * FROM agent_plans WHERE id=? AND owner=?').get(id,owner);
    if(!row)reject('Plan not found.',404);
    if(row.status!=='PROPOSED')reject('This proposal is no longer open.',409);
    const p=JSON.parse(row.document);
    if(p.expiresAt<=Date.now())reject('This proposal expired. The next daily check proposes it again if the rule still applies.',409);
    if(briefHash(store.get(owner,p.strategyId))!==p.briefHash)reject('The strategy changed after this proposal.',409);
    const next={...p,expiresAt:Date.now()+3600000};
    store.db.prepare("UPDATE agent_plans SET status='APPROVED',document=? WHERE id=?").run(JSON.stringify(next),id);
    store.event(owner,p.strategyId,'SALE_APPROVED',{planId:id,kind:p.kind});
    return {...next,status:'APPROVED'};
  });
}

// Holdings an exit rule watches: purchases confirmed on chain (or filled by the Agentic Wallet) in BNB Chain plans
// whose tested design carries exit rules. `since` is the UTC date the purchase was confirmed; the newest purchase
// of a token in a strategy is the entry.
export function exitPositions(store){
  const out=new Map();
  for(const row of store.db.prepare("SELECT id,owner,strategy,run_id,document FROM agent_plans WHERE json_extract(document,'$.chain')='eip155:56' AND status IN ('PARTIAL','COMPLETE','UNKNOWN')").all()){
    const plan=JSON.parse(row.document),run=store.db.prepare('SELECT result FROM agent_runs WHERE id=?').get(row.run_id);
    if(!run?.result)continue;
    const exit=JSON.parse(run.result).candidates?.find(c=>c.id===plan.candidateId)?.design?.exit;
    if(!exit||(exit.stop_loss==null&&exit.trailing_stop==null))continue;
    const agentic=Boolean(store.db.prepare('SELECT 1 FROM agent_agentic_runs WHERE plan_id=?').get(row.id));
    for(const st of store.db.prepare("SELECT step,document FROM agent_steps WHERE plan_id=? AND phase='RECONCILED'").all(row.id)){
      const leg=plan.legs[st.step];if(!leg||leg.side==='SELL')continue;
      const doc=JSON.parse(st.document),product=doc.product?.contract?doc.product:bscProduct(leg.instrument),at=doc.sent?.at??doc.at;
      if(!product?.contract||!Number.isSafeInteger(at))continue;
      const since=new Date(at).toISOString().slice(0,10),key=`${row.owner}|${row.strategy}|${product.contract.toLowerCase()}`;
      if((out.get(key)?.since??'')>since)continue;
      out.set(key,{address:plan.owner,strategyId:row.strategy,instrument:leg.instrument,contract:product.contract.toLowerCase(),since,exit,wallet:agentic?'AGENTIC':'PERSONAL',buyPlanId:row.id});
    }
  }
  return [...out.values()];
}

// The daily exit check, once per new price release. `check` runs the engine's exit_check (same definition as the
// backtest); `gw` reads holdings. Nothing is marked done unless every step succeeded, so a failure retries later.
export async function exitWatch(store,{gw,check,release}){
  ensure(store);
  if(!release)return {skipped:'NO_RELEASE'};
  if(store.db.prepare("SELECT value FROM agent_worker_state WHERE key='exitWatchRelease'").get()?.value===release)return {skipped:'DONE'};
  const positions=exitPositions(store),binding=agenticBinding(store),live=[];
  const wallets=new Map();
  for(const p of positions){
    const address=p.wallet==='AGENTIC'?binding?.address:p.address.slice('eip155:56:'.length);
    if(!address||(p.wallet==='AGENTIC'&&binding.owner!==store.owner(p.address)))continue;
    const k=address.toLowerCase();if(!wallets.has(k))wallets.set(k,{address,positions:[]});wallets.get(k).positions.push(p);
  }
  for(const w of wallets.values()){
    const reply=await readHoldings(gw,w.address,[...new Set(w.positions.map(p=>p.contract))]);
    const held=new Map((reply?.holdings??[]).map(h=>[String(h.contract).toLowerCase(),String(h.raw)]));
    for(const p of w.positions){const raw=held.get(p.contract)??'0';if(/^[1-9]\d{0,35}$/.test(raw))live.push({...p,raw});}
  }
  const proposals=[];
  if(live.length){
    const asked=live.map(p=>({ticker:p.instrument,since:p.since,stop_loss:p.exit.stop_loss??null,trailing_stop:p.exit.trailing_stop??null}));
    let answer;
    try{answer=await check({positions:asked});}
    catch{   // one ticker without verified history must not block the others: check them one by one
      const rows=[];let asOf=null;
      for(const a of asked){try{const one=await check({positions:[a]});asOf=one.asOf??asOf;rows.push(one.positions?.[0]??{ticker:a.ticker,triggered:null});}catch{rows.push({ticker:a.ticker,triggered:null,unavailable:true});}}
      answer={asOf,positions:rows};
    }
    const rows=Array.isArray(answer?.positions)?answer.positions:[];
    if(rows.length!==live.length)throw new Error('Exit check answered a different number of positions.');
    const fired=new Map();
    live.forEach((p,i)=>{
      const r=rows[i];if(r?.ticker!==p.instrument)throw new Error('Exit check answered out of order.');
      if(!['stop_loss','trailing_stop'].includes(r.triggered))return;
      const k=`${p.address}|${p.strategyId}|${p.wallet}`;if(!fired.has(k))fired.set(k,{p,items:[]});
      fired.get(k).items.push({p,r});
    });
    for(const {p,items} of fired.values()){
      const owner=store.owner(p.address),s=store.get(owner,p.strategyId),agent=s.agentId?store.agentProfile(owner,s.agentId):null;
      const auto=p.wallet==='AGENTIC'&&agent?.approval==='AUTO_WITHIN_LIMITS';
      const reason={asOf:answer.asOf??null,rules:items.map(({p,r})=>({instrument:p.instrument,rule:r.triggered,since:p.since,entryClose:r.entryClose??null,peakClose:r.peakClose??null,lastClose:r.lastClose??null,lastDate:r.lastDate??null,
        threshold:r.triggered==='stop_loss'?p.exit.stop_loss:p.exit.trailing_stop}))};
      try{
        const plan=createSellPlan(store,p.address,p.strategyId,{kind:'EXIT',holdings:items.map(({p})=>({instrument:p.instrument,contract:p.contract,raw:p.raw})),wallet:p.wallet,reason,proposed:!auto});
        if(auto)startAgentic(store,p.address,plan.id,Infinity);
        proposals.push({planId:plan.id,auto});
      }catch(e){if(!/already open/.test(String(e?.message)))throw e;}   // an open sale already covers it
    }
  }
  store.db.prepare("INSERT INTO agent_worker_state VALUES('exitWatchRelease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(release,Date.now());
  return {release,positions:live.length,proposals};
}
