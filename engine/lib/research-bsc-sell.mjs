import {randomUUID} from 'node:crypto';
import {reject,hash,briefHash,sellLegs,chainOf} from './research-agent-core.mjs';
import {ResearchStoreError} from './research-store.mjs';
import {agentSnapshot} from './research-agent-profile.mjs';
import {BSC_RESEARCH_PRODUCTS,bscProduct} from './bsc-research-universe.mjs';
import {agenticBinding,startAgentic} from './research-agentic.mjs';

// BNB Chain sales: stock token -> USDT for whole holdings, read on chain by the gateway.
//  CLOSE  the owner closes positions from the Trades tab (approved by that click).
//  EXIT   the agent's exit rule fired in the daily check. Per-trade agents get a PROPOSED plan that waits for the
//         owner; agents allowed to trade on their own sell through the Agentic Wallet at once.
// A sale runs from the wallet that holds the tokens: PERSONAL (owner signs each step) or AGENTIC (Agentic Wallet).
const OPEN=['PROPOSED','APPROVED','PARTIAL','UNKNOWN'];
// Trade states with an order or transaction that may still settle.
const IN_FLIGHT=['APPROVE_SENT','SUBMITTED','AGENTIC_SUBMITTING','AGENTIC_SUBMITTED','AGENTIC_UNKNOWN','UNKNOWN'];
// Balances below a thousandth of a token (rounding residue, or a token someone sent) are not holdings: a sale of them
// fails at the router, so they are never offered for sale and never count as a position.
export const substantial=(raw,decimals=18)=>/^[1-9]\d{0,35}$/.test(String(raw))&&BigInt(raw)>=10n**BigInt(Math.max(0,decimals-3));

// An automatic exit (a stop that fired) keeps trying until the token trades again, over a weekend too; the next daily
// check finds it still open instead of proposing a second one.
export const AUTO_EXIT_MS=4*86400000;
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
  return strategyContracts(strategy).map(c=>({...c,raw:raw.get(c.contract)??'0'})).filter(h=>substantial(h.raw,h.decimals));
}
export async function readHoldings(gw,wallet,contracts){
  const holdings=[];   // the gateway reads at most 40 tokens per call
  for(let i=0;i<contracts.length;i+=40){const r=await gw('GET',`/v1/holdings?address=${wallet}&tokens=${contracts.slice(i,i+40).join(',')}`);holdings.push(...(Array.isArray(r?.holdings)?r.holdings:[]));}
  return {holdings};
}
// The wallet that holds a strategy's tokens: the Agentic Wallet for an agent that trades on its own (when bound to
// this owner), otherwise the owner's own wallet.
export function saleWallet(store,address,strategy){
  const owner=store.owner(address),agent=strategy.agentId?store.agentProfile(owner,strategy.agentId):null,b=agenticBinding(store);
  return agent?.approval==='AUTO_WITHIN_LIMITS'&&b?.owner===owner?{kind:'AGENTIC',address:b.address}:{kind:'PERSONAL',address:address.slice('eip155:56:'.length)};
}

export function createSellPlan(store,address,strategyId,{kind,holdings,wallet='PERSONAL',reason=null,proposed=false,extraInstruments=[]}){
  const owner=store.owner(address),s=store.get(owner,strategyId);
  if(chainOf(address)!=='bsc')reject('Selling here is available for BNB Chain wallets.',409);
  if(!['CLOSE','EXIT'].includes(kind)||!['PERSONAL','AGENTIC'].includes(wallet))reject('Invalid sale.');
  const legs=sellLegs(s,holdings,kind==='EXIT'?extraInstruments:[]);
  if(!legs.length)reject('Nothing to sell: this wallet holds none of these stock tokens.',409);
  const agent=s.agentId?store.agentProfile(owner,s.agentId):null;
  return store.transaction(()=>{
    // One open sale per strategy, token and wallet: the same exit is never queued twice. Each sale is sized to its own
    // strategy's tokens and capped at the balance, so two strategies may each sell theirs. A sale counts as open while
    // it is current or has a trade in flight: an approval left unsigned past its expiry no longer blocks later exits.
    const now=Date.now(),contracts=new Set(legs.map(l=>l.productContract.toLowerCase()));
    const inFlight=id=>Boolean(store.db.prepare(`SELECT 1 FROM agent_steps WHERE plan_id=? AND phase IN (${IN_FLIGHT.map(()=>'?').join(',')}) LIMIT 1`).get(id,...IN_FLIGHT)
      ||store.db.prepare("SELECT 1 FROM agent_agentic_runs WHERE plan_id=? AND status IN ('RUNNING','PAUSED')").get(id));
    const clash=store.db.prepare(`SELECT id,document FROM agent_plans WHERE owner=? AND strategy=? AND status IN (${OPEN.map(()=>'?').join(',')})`).all(owner,s.id,...OPEN)
      .find(r=>{const d=JSON.parse(r.document);return (d.wallet??'PERSONAL')===wallet&&d.legs.some(l=>l.side==='SELL'&&contracts.has(String(l.productContract).toLowerCase()))&&(d.expiresAt>now||inFlight(r.id));});
    if(clash){const e=new ResearchStoreError('A sale of this holding is already open. Finish or revoke it first.',409);e.planId=clash.id;throw e;}
    const runId=`${kind.toLowerCase()}:${randomUUID()}`;
    const document={schema:'xtxc.research-plan/v1',kind,owner:address,strategyId:s.id,briefHash:briefHash(s),runId,candidateId:kind,reportHash:null,goal:null,
      budgetAtoms:'0',budgetAsset:'USDT',chain:'eip155:56',budgetScope:'SELL_HOLDINGS',wallet,universe:s.instruments,legs,cashAtoms:'0',
      ...(reason?{reason}:{}),...(agent?{agent:agentSnapshot(agent)}:{}),maxSlippageBps:100,createdAt:now,expiresAt:now+(proposed?86400000:kind==='EXIT'?AUTO_EXIT_MS:3600000),nonce:randomUUID()};
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

// Positions a strategy holds, per owner, strategy, token and wallet: purchases confirmed on chain (or filled by the
// Agentic Wallet) after the token's last sale in that strategy and wallet. `since` is the UTC date of the newest
// purchase and `exit` its design's exit rules; `qty` is the least those purchases delivered (each swap's minimum
// received, or the tokens the Agentic Wallet filled), or null when one of them did not report it.
function heldPositions(store,owner=null){
  const out=new Map(),sold=new Map(),buys=[];
  for(const row of store.db.prepare(`SELECT id,owner,strategy,run_id,document FROM agent_plans WHERE json_extract(document,'$.chain')='eip155:56' AND status IN ('PARTIAL','COMPLETE','UNKNOWN','REVOKED')${owner?' AND owner=?':''}`).all(...(owner?[owner]:[]))){
    const plan=JSON.parse(row.document),agentic=Boolean(store.db.prepare('SELECT 1 FROM agent_agentic_runs WHERE plan_id=?').get(row.id));
    let exit;
    const exitOf=()=>{if(exit===undefined){const run=plan.kind?null:store.db.prepare('SELECT result FROM agent_runs WHERE id=?').get(row.run_id);
      exit=run?.result?JSON.parse(run.result).candidates?.find(c=>c.id===plan.candidateId)?.design?.exit??null:null;}return exit;};
    for(const st of store.db.prepare("SELECT step,document FROM agent_steps WHERE plan_id=? AND phase='RECONCILED'").all(row.id)){
      const leg=plan.legs[st.step];if(!leg)continue;
      const doc=JSON.parse(st.document),at=doc.sent?.at??doc.at,wallet=agentic?'AGENTIC':(plan.wallet??'PERSONAL');
      if(!Number.isSafeInteger(at))continue;
      if(leg.side==='SELL'){const k=`${row.owner}|${row.strategy}|${String(leg.productContract).toLowerCase()}|${wallet}`;sold.set(k,Math.max(sold.get(k)??0,at));continue;}
      const product=doc.product?.contract?doc.product:bscProduct(leg.instrument);if(!product?.contract)continue;
      const filled=agentic?doc.filledTokenAtoms:doc.prepared?.kind==='SWAP'?doc.prepared?.tx?.minReceiveAmount:null;
      buys.push({key:`${row.owner}|${row.strategy}|${product.contract.toLowerCase()}|${wallet}`,at,qty:/^\d+$/.test(String(filled??''))?BigInt(filled):null,
        position:{address:plan.owner,strategyId:row.strategy,instrument:leg.instrument,contract:product.contract.toLowerCase(),exit:exitOf(),wallet,buyPlanId:row.id}});
    }
  }
  for(const b of buys){
    if(b.at<=(sold.get(b.key)??0))continue;   // bought before the last sale: already sold
    const cur=out.get(b.key),since=new Date(b.at).toISOString().slice(0,10);
    if(!cur){out.set(b.key,{...b.position,since,at:b.at,qty:b.qty});continue;}
    cur.qty=cur.qty==null||b.qty==null?null:cur.qty+b.qty;
    if(b.at>cur.at)Object.assign(cur,b.position,{since,at:b.at});
  }
  return [...out.values()].map(({at:_,...p})=>({...p,qty:p.qty==null?null:p.qty.toString()}));
}
// Holdings an exit rule watches: positions whose newest purchase's design carries a stop. A sale is sized to `qty`
// (capped at the balance), so an exit never sells another strategy's tokens when the purchases reported it.
export function exitPositions(store){
  return heldPositions(store).filter(p=>p.exit&&(p.exit.stop_loss!=null||p.exit.trailing_stop!=null));
}
// The stocks a run treats as held: this strategy's own confirmed purchases still in the wallet it trades from, with at
// least a twentieth of what they delivered left. Tokens bought elsewhere, sent by someone, or left over after a sale are
// not the strategy's holdings, so its entry rules still apply to them.
export function heldForRun(store,address,strategy,walletKind,reply){
  const own=new Map(heldPositions(store,store.owner(address)).filter(p=>p.strategyId===strategy.id&&p.wallet===walletKind).map(p=>[p.contract,p.qty]));
  return holdingsFor(strategy,reply).filter(h=>own.has(h.contract)&&(own.get(h.contract)==null||BigInt(h.raw)*20n>=BigInt(own.get(h.contract)))).map(h=>h.instrument);
}
// What a rebalance may sell: this strategy's own confirmed purchases still in that wallet, each capped at what they
// delivered. Tokens bought outside STA or by another strategy in the same wallet are never sold by it; a purchase whose
// delivered amount is unknown is left alone.
export function ownHoldings(store,address,strategy,walletKind,reply){
  const own=new Map(heldPositions(store,store.owner(address)).filter(p=>p.strategyId===strategy.id&&p.wallet===walletKind&&p.qty!=null).map(p=>[p.contract,BigInt(p.qty)]));
  return holdingsFor(strategy,reply).filter(h=>own.has(h.contract)).map(h=>{const q=own.get(h.contract),r=BigInt(h.raw);return {...h,raw:(r<q?r:q).toString()};})
    .filter(h=>BigInt(h.raw)>0n);
}

// The daily exit check, once per new price release. `check` runs the engine's exit_check (same definition as the
// backtest); `gw` reads holdings. Nothing is marked done unless every step succeeded, so a failure retries later; a
// ticker the check could not answer is retried a few times before the release is marked done.
const UNAVAILABLE_RETRIES=6;
export async function exitWatch(store,{gw,check,release}){
  ensure(store);
  if(!release)return {skipped:'NO_RELEASE'};
  if(store.db.prepare("SELECT value FROM agent_worker_state WHERE key='exitWatchRelease'").get()?.value===release)return {skipped:'DONE'};
  // `transient`: something to retry (gateway down); the release is marked done only when nothing was skipped for it.
  let transient=false,unavailable=false;const skipped=[],positions=exitPositions(store),binding=agenticBinding(store),live=[],wallets=new Map();
  for(const p of positions){
    const address=p.wallet==='AGENTIC'?binding?.address:p.address.slice('eip155:56:'.length);
    if(!address||(p.wallet==='AGENTIC'&&binding.owner!==store.owner(p.address)))continue;
    const k=address.toLowerCase();if(!wallets.has(k))wallets.set(k,{address,positions:[]});wallets.get(k).positions.push(p);
  }
  for(const w of wallets.values()){
    let reply;try{reply=await readHoldings(gw,w.address,[...new Set(w.positions.map(p=>p.contract))]);}catch{transient=true;continue;}
    const held=new Map(reply.holdings.map(h=>[String(h.contract).toLowerCase(),String(h.raw)]));
    for(const p of w.positions){
      const balance=held.get(p.contract)??'0';if(!substantial(balance))continue;
      const raw=p.qty!=null&&BigInt(p.qty)<BigInt(balance)?p.qty:balance;   // this strategy's tokens only, when known
      if(BigInt(raw)>0n)live.push({...p,raw});
    }
  }
  const proposals=[];
  if(live.length){
    const asked=live.map(p=>({ticker:p.instrument,since:p.since,stop_loss:p.exit.stop_loss??null,trailing_stop:p.exit.trailing_stop??null}));
    let answer;
    try{answer=await check({positions:asked});}
    catch{   // one ticker without verified history must not block the others: check them one by one
      const rows=[];let asOf=null,answered=0;
      for(const a of asked){try{const one=await check({positions:[a]});asOf=one.asOf??asOf;answered++;rows.push(one.positions?.[0]??{ticker:a.ticker,triggered:null});}catch{unavailable=true;rows.push({ticker:a.ticker,triggered:null,unavailable:true});}}
      if(!answered)throw new Error('The exit check is unavailable.');   // nothing was checked: retry, never mark done
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
      // One owner's problem (agent deleted, stock delisted) never blocks another owner's exit.
      try{
        const owner=store.owner(p.address),s=store.get(owner,p.strategyId);
        let agent=null;try{agent=s.agentId?store.agentProfile(owner,s.agentId):null;}catch{/* deleted agent: propose */}
        // Selling on its own needs each position's size: a whole shared Agentic Wallet balance is only ever proposed.
        const auto=p.wallet==='AGENTIC'&&agent?.approval==='AUTO_WITHIN_LIMITS'&&items.every(({p})=>p.qty!=null);
        const reason={asOf:answer.asOf??null,rules:items.map(({p,r})=>({instrument:p.instrument,rule:r.triggered,since:p.since,entryClose:r.entryClose??null,peakClose:r.peakClose??null,lastClose:r.lastClose??null,lastDate:r.lastDate??null,
          threshold:r.triggered==='stop_loss'?p.exit.stop_loss:p.exit.trailing_stop}))};
        // The sale and its start are one step: a crash never leaves an automatic exit created but not started.
        const plan=store.transaction(()=>{
          const plan=createSellPlan(store,p.address,p.strategyId,{kind:'EXIT',holdings:items.map(({p})=>({instrument:p.instrument,contract:p.contract,raw:p.raw})),
            extraInstruments:items.map(({p})=>p.instrument),wallet:p.wallet,reason,proposed:!auto});
          if(auto)startAgentic(store,p.address,plan.id,Infinity);
          return plan;
        });
        proposals.push({planId:plan.id,auto});
      }catch(e){   // an open sale of the same tokens already covers this exit
        skipped.push(e?.planId?{strategyId:p.strategyId,reason:'ALREADY_OPEN',planId:e.planId}:{strategyId:p.strategyId,reason:String(e?.message??'').slice(0,120)});
      }
    }
  }
  if(transient)return {release,positions:live.length,proposals,skipped,retry:true};
  if(unavailable){
    const [r,n]=String(store.db.prepare("SELECT value FROM agent_worker_state WHERE key='exitWatchAttempts'").get()?.value??'').split('|'),tries=(r===release?Number(n)||0:0)+1;
    if(tries<UNAVAILABLE_RETRIES){
      store.db.prepare("INSERT INTO agent_worker_state VALUES('exitWatchAttempts',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(`${release}|${tries}`,Date.now());
      return {release,positions:live.length,proposals,skipped,retry:true};
    }
  }
  store.db.prepare("INSERT INTO agent_worker_state VALUES('exitWatchRelease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(release,Date.now());
  return {release,positions:live.length,proposals,skipped};
}
