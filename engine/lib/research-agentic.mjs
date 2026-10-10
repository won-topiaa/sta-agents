import {reject,briefHash} from './research-agent-core.mjs';
import {bscProduct} from './bsc-research-universe.mjs';

// Agentic Wallet execution for agents set to "trade on its own within limits".
// The Binance Agentic Wallet (MPC, Binance app) enforces the owner's daily USD limit and token scope;
// this module adds STA's own rules: only an approved BSC plan of an AUTO agent, legs in order (a leg whose token is
// closed waits while the later ones trade),
// and a durable "submitting" mark before every order so a restart never sends a leg twice.
const USDT='0x55d398326f99059fF775485246999027B3197955';
export const decimal18=atoms=>{const a=BigInt(atoms),w=a/10n**18n,f=(a%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
const usd18=atoms=>Number(BigInt(atoms)/10n**12n)/1e6;

// Tables live in AgentStore (agent_agentic_binding, agent_agentic_runs) so every process sees them.
export function agenticBinding(store){return store.db.prepare("SELECT owner,address,bound_at FROM agent_agentic_binding WHERE slot='default'").get()??null;}
// One gateway serves one Agentic Wallet; the first owner to sign in binds it.
export function bindAgentic(store,address,wallet){
  const owner=store.owner(address),b=agenticBinding(store);
  if(!/^0x[0-9a-fA-F]{40}$/.test(String(wallet)))reject('The Agentic Wallet address is invalid.',502);
  if(b&&b.owner!==owner)reject('This Agentic Wallet is connected to another account.',409);
  store.db.prepare("INSERT INTO agent_agentic_binding VALUES('default',?,?,?) ON CONFLICT(slot) DO UPDATE SET address=excluded.address").run(owner,wallet,Date.now());
  return agenticBinding(store);
}
// The BNB Chain address in the Agentic Wallet's `wallet address` reply (its shape differs between CLI versions).
export const agenticWalletOf=a=>a?.address??a?.evmAddress??a?.addresses?.find(x=>!x.binanceChainId||String(x.binanceChainId)==='56')?.address;
// Signing in again ends the shared session for a moment; never while a run trades or an order still has to settle.
export function assertAgenticIdle(store){
  if(store.db.prepare("SELECT 1 FROM agent_agentic_runs WHERE status IN ('RUNNING','PAUSED')").get()
    ||store.db.prepare("SELECT 1 FROM agent_steps WHERE phase IN ('AGENTIC_SUBMITTING','AGENTIC_SUBMITTED')").get())
    reject('An Agentic Wallet trade is in progress. Sign in again after it finishes, or stop it first.',409);
}
export function agenticRun(store,planId){return store.db.prepare('SELECT * FROM agent_agentic_runs WHERE plan_id=?').get(planId)??null;}
// A single purchase leg above this is refused by the gateway (its buy cap); refuse the plan up front instead.
export const AGENTIC_MAX_BUY_ATOMS=200n*10n**18n;
export const PAUSE_RETRY_MS=300000;
const LIVE=['APPROVED','PARTIAL'];
// The Agentic Wallet reports the daily limit left under one of these keys, depending on the CLI version.
export const quotaLeftOf=q=>Number(q?.quotaLeft??q?.leftQuota??q?.left??q?.remaining??NaN);
export function startAgentic(store,address,planId,quotaLeftUsd){
  const owner=store.owner(address),p=store.plan(address,planId),b=agenticBinding(store),sale=Boolean(p.kind);
  if(p.chain!=='eip155:56')reject('Agentic execution is for BNB Chain plans.',409);
  if(!p.agent)reject('Only a plan designed by your agent can run on its own.',409);
  // A purchase plan runs on its own only for an agent allowed to; a sale the owner asked for (CLOSE) or accepted
  // (EXIT) is the owner's own decision and may run from the Agentic Wallet that holds the tokens.
  if(!sale)store.assertAutonomyAllowed(address,p);
  if(!b||b.owner!==owner)reject('Connect your Agentic Wallet first.',409);
  if(p.status!=='APPROVED'||Date.now()>p.expiresAt)reject('Approve a current plan first.',409);
  if(!sale&&briefHash(store.get(owner,p.strategyId))!==p.briefHash)reject('The strategy changed after this approval. Run and approve it again.',409);
  // Tokens to sell must be in the Agentic Wallet; holdings in the owner's own wallet are signed there, step by step.
  if(p.wallet==='PERSONAL'&&p.legs.some(l=>l.side==='SELL'))reject('These holdings are in your own wallet. Sign each sale in the trade steps.',409);
  if(p.legs.some(l=>l.side!=='SELL'&&BigInt(l.inputAtoms)>AGENTIC_MAX_BUY_ATOMS))reject('A single purchase is capped at 200 USDT. Lower the budget or spread it over more stocks.',409);
  if(store.db.prepare('SELECT 1 FROM agent_steps WHERE plan_id=?').get(planId))reject('This plan already has trades. Use a fresh approval.',409);
  const total=usd18(p.budgetAtoms)-usd18(p.cashAtoms);
  if(!(Number(quotaLeftUsd)>=total))reject(`Your Agentic Wallet has $${Number(quotaLeftUsd).toFixed(2)} of daily limit left; this plan needs $${total.toFixed(2)}.`,409);
  const now=Date.now();
  store.db.prepare("INSERT INTO agent_agentic_runs VALUES(?,?,?,'RUNNING',NULL,?,?) ON CONFLICT(plan_id) DO NOTHING").run(planId,owner,b.address,now,now);
  store.event(owner,p.strategyId,'AGENTIC_STARTED',{planId,wallet:b.address});
  return agenticRun(store,planId);
}
// Stopping ends the plan's remaining trades (like revoking it); an order already sent still settles.
export function stopAgentic(store,address,planId){
  const owner=store.owner(address),p=store.plan(address,planId);
  store.transaction(()=>{
    store.db.prepare("UPDATE agent_agentic_runs SET status='STOPPED',reason='OWNER_STOPPED',updated_at=? WHERE plan_id=? AND owner=? AND status IN ('RUNNING','PAUSED')").run(Date.now(),planId,owner);
    store.db.prepare("UPDATE agent_plans SET status='REVOKED' WHERE id=? AND owner=? AND status IN ('APPROVED','PARTIAL')").run(planId,owner);
  });
  store.event(owner,p.strategyId,'AGENTIC_STOPPED',{planId});
  return agenticRun(store,planId);
}
const setStep=(store,planId,index,phase,doc)=>store.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?) ON CONFLICT(plan_id,step) DO UPDATE SET phase=excluded.phase,document=excluded.document').run(planId,index,phase,JSON.stringify(doc));
const finishRun=(store,planId,status,reason=null)=>store.db.prepare('UPDATE agent_agentic_runs SET status=?,reason=?,updated_at=? WHERE plan_id=?').run(status,reason,Date.now(),planId);
// The plan status follows its legs, except that a revoked or expired plan stays so.
const planStatus=(store,planId,legs)=>{const done=store.db.prepare("SELECT count(*) n FROM agent_steps WHERE plan_id=? AND phase='RECONCILED'").get(planId).n;
  store.db.prepare("UPDATE agent_plans SET status=? WHERE id=? AND status NOT IN ('REVOKED','EXPIRED')").run(done===legs?'COMPLETE':done?'PARTIAL':'APPROVED',planId);return done;};
const FILLED=['FINISHED','SUCCESS','FILLED','COMPLETED'],FAILED=['FAILED','CANCELLED','CANCELED','EXPIRED','REJECTED'];
// Claims leg `index` for submission, re-reading everything that may have changed since the tick began. Only one
// process can claim a leg (BEGIN IMMEDIATE); a leg that already has a step (manual or agentic) is never claimed.
function claimLeg(store,run,index,doc){
  return store.transaction(()=>{
    const r=store.db.prepare('SELECT status FROM agent_agentic_runs WHERE plan_id=?').get(run.plan_id);
    if(r?.status!=='RUNNING')return 'RUN_ENDED';
    const row=store.db.prepare('SELECT status,document FROM agent_plans WHERE id=?').get(run.plan_id),plan=JSON.parse(row.document);
    if(!LIVE.includes(row.status))return 'PLAN_ENDED';
    // The same deadline as a step the owner signs: a run paused by the daily limit never buys hours later on an old
    // research result (a purchase approval lasts an hour, a proposed exit a day).
    if(!Number.isSafeInteger(plan.expiresAt)||Date.now()>plan.expiresAt)return 'PLAN_EXPIRED';
    if(!plan.kind){
      if(briefHash(store.get(run.owner,plan.strategyId))!==plan.briefHash)return 'BRIEF_CHANGED';
      let approval=null;try{approval=plan.agent?store.agentProfile(run.owner,plan.agent.id).approval:null;}catch{/* a deleted agent ends the run */}
      if(plan.agent&&approval!=='AUTO_WITHIN_LIMITS')return 'AGENT_SETTING_CHANGED';
    }
    const step=store.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=? AND step=?').get(run.plan_id,index);
    if(step&&!['READY','FAILED'].includes(step.phase))return 'STEP_EXISTS';
    setStep(store,run.plan_id,index,'AGENTIC_SUBMITTING',doc);   // durable before the order exists
    return null;
  });
}

// One pass over Agentic runs. `gw(method,path,body)` calls the BNB gateway.
export async function agenticTick(store,gw,now=Date.now()){
  // A run paused by the daily limit, a closed market or the price check tries again after five minutes, well inside its
  // plan's deadline (a purchase approval lasts an hour); Binance re-checks the limit and the gateway the price.
  store.db.prepare("UPDATE agent_agentic_runs SET status='RUNNING',reason=NULL,updated_at=? WHERE status='PAUSED' AND updated_at<?").run(now,now-PAUSE_RETRY_MS);
  // Running runs, plus ended runs that still have an order in flight to settle.
  const runs=store.db.prepare(`SELECT r.*,p.document,p.strategy FROM agent_agentic_runs r JOIN agent_plans p ON p.id=r.plan_id
    WHERE r.status='RUNNING' OR EXISTS (SELECT 1 FROM agent_steps s WHERE s.plan_id=r.plan_id AND s.phase IN ('AGENTIC_SUBMITTING','AGENTIC_SUBMITTED'))
    ORDER BY r.updated_at LIMIT 50`).all();
  runs: for(const run of runs){
    const plan=JSON.parse(run.document),steps=store.db.prepare('SELECT step,phase,document FROM agent_steps WHERE plan_id=? ORDER BY step').all(run.plan_id);
    const open=steps.find(s=>['AGENTIC_SUBMITTING','AGENTIC_SUBMITTED'].includes(s.phase));
    if(open){   // settle the order in flight first; never submit the next leg before it
      const doc=JSON.parse(open.document);
      if(open.phase==='AGENTIC_SUBMITTING'){setStep(store,run.plan_id,open.step,'UNKNOWN',{...doc,reason:'INTERRUPTED_BEFORE_ORDER_ID'});finishRun(store,run.plan_id,'ATTENTION','INTERRUPTED');continue;}
      let order;try{order=await gw('GET',`/v1/agentic/order?orderId=${encodeURIComponent(doc.orderId)}`);}catch{continue;}
      const list=Array.isArray(order)?order:order?.list??order?.orders??[order];
      const o=list.find(x=>String(x?.orderId??x?.id??'')===doc.orderId);   // never another order's status
      const status=String(o?.status??o?.orderStatus??'PENDING').toUpperCase();
      // filledTokenAtoms: the bought quantity in token atoms (the gateway converts the CLI's shares); exits size by it.
      if(FILLED.includes(status)){setStep(store,run.plan_id,open.step,'RECONCILED',{...doc,order:o,...(/^\d{1,40}$/.test(String(o?.filledTokenAtoms??''))?{filledTokenAtoms:String(o.filledTokenAtoms)}:{})});planStatus(store,run.plan_id,plan.legs.length);}
      else if(FAILED.includes(status)){setStep(store,run.plan_id,open.step,'FAILED',{...doc,order:o});finishRun(store,run.plan_id,'ATTENTION','ORDER_FAILED');continue;}
      else continue;
    }
    if(run.status!=='RUNNING')continue;
    const done=planStatus(store,run.plan_id,plan.legs.length);
    if(done===plan.legs.length){finishRun(store,run.plan_id,'COMPLETE');store.event(run.owner,run.strategy,'AGENTIC_COMPLETE',{planId:run.plan_id});continue;}
    // Legs whose token was refused in this tick (closed market, route price); the next leg is tried straight away.
    let quota,self;const waited=new Set();
    for(;;){
      const next=nextLeg(store,run.plan_id,plan.legs,now,waited);
      // Every leg left waits on its token: pause, and try them all again after five minutes (the plan deadline still applies).
      if(next.index==null){finishRun(store,run.plan_id,'PAUSED',next.reason);continue runs;}
      // A sale names the exact token held (Ondo or bStock); a purchase buys the listed product.
      const index=next.index,leg=plan.legs[index],sell=leg.side==='SELL',product=sell?{contract:leg.productContract,symbol:leg.productSymbol,platform:leg.platform}:bscProduct(leg.instrument);
      if(!product?.contract){finishRun(store,run.plan_id,'ATTENTION','NOT_TRADABLE');continue runs;}
      // Quantities go to the wallet as 18-decimal amounts (USDT and every listed stock token today); anything else stops.
      if(sell&&(leg.inputDecimals??18)!==18){finishRun(store,run.plan_id,'ATTENTION','UNSUPPORTED_DECIMALS');continue runs;}
      if(quota===undefined)try{quota=await gw('GET','/v1/agentic/quota');}catch{continue runs;}
      // A purchase leg's USD value is known; a sale's is not until it fills, so Binance's own limit check covers it.
      const left=quotaLeftOf(quota);
      if(!sell&&Number.isFinite(left)&&left<usd18(leg.inputAtoms)){finishRun(store,run.plan_id,'PAUSED','DAILY_LIMIT');continue runs;}
      // The gateway's Agentic Wallet session is shared: trade only while it is still signed in to this run's wallet.
      if(self===undefined){
        try{self=await gw('GET','/v1/agentic/address');}catch{continue runs;}
        const signedIn=(Array.isArray(self?.addresses)?self.addresses:[]).find(x=>String(x?.binanceChainId)==='56')?.address;
        if(!signedIn||String(signedIn).toLowerCase()!==String(run.address).toLowerCase()){finishRun(store,run.plan_id,'ATTENTION','WALLET_CHANGED');continue runs;}
      }
      const doc={leg,product,mode:'AGENTIC',wallet:run.address,at:Date.now()};
      const refused=claimLeg(store,run,index,doc);
      if(refused){if(refused!=='RUN_ENDED')finishRun(store,run.plan_id,refused==='STEP_EXISTS'?'ATTENTION':'STOPPED',refused);continue runs;}
      try{
        const r=await gw('POST','/v1/agentic/swap',sell?{fromToken:product.contract,toToken:USDT,fromTokenQty:decimal18(leg.inputAtoms)}:{fromToken:USDT,toToken:product.contract,fromTokenQty:decimal18(leg.inputAtoms)});
        const orderId=r?.orderId??r?.id??r?.order?.orderId;
        if(!orderId){setStep(store,run.plan_id,index,'UNKNOWN',{...doc,reason:'NO_ORDER_ID',reply:r});finishRun(store,run.plan_id,'ATTENTION','NO_ORDER_ID');continue runs;}
        setStep(store,run.plan_id,index,'AGENTIC_SUBMITTED',{...doc,orderId:String(orderId)});
        store.event(run.owner,run.strategy,'TRADE_STATUS',{planId:run.plan_id,index,phase:'AGENTIC_SUBMITTED'});
        continue runs;   // one order at a time: the next leg waits until this one settles
      }catch(e){
        const code=String(e?.code??''),message=String(e?.message??'').slice(0,200);
        // The wallet named an order: it exists, so settle it like any other.
        if(e?.orderId){setStep(store,run.plan_id,index,'AGENTIC_SUBMITTED',{...doc,orderId:String(e.orderId),error:message});continue runs;}
        // Refused before any order: the gateway's own checks, or the wallet's explicit refusals. Nothing was sent.
        const gatewayRefusal=['MARKET','PRICE','LIMIT','INPUT','TOKEN','NO_ROUTE','MODE'].includes(code);
        const walletRefusal=code==='AGENTIC'&&/limit|quota|closed|paused|minimum|invalid|not allowed|insufficient|no route/i.test(message);
        if(gatewayRefusal||walletRefusal){
          // A closed market is about this token; "paused" (or a closed account or wallet) is the whole wallet, so it
          // pauses the run instead of moving on to the next leg.
          const marketClosed=code==='MARKET'||(/closed/i.test(message)&&!/account|wallet/i.test(message));
          const reason=marketClosed?'MARKET_CLOSED':code==='PRICE'?'PRICE_CHECK':/limit|quota/i.test(message)?'DAILY_LIMIT':/paused/i.test(message)?'WALLET_PAUSED':null;
          // Only this token can't trade right now (closed market, route price): it waits and the later legs go first.
          if(reason==='MARKET_CLOSED'||reason==='PRICE_CHECK'){setStep(store,run.plan_id,index,'READY',{...doc,error:message,waitReason:reason,waitSince:Date.now()});waited.add(index);continue;}
          setStep(store,run.plan_id,index,'READY',{...doc,error:message});
          // The daily limit passes: try again in five minutes (the plan deadline still applies).
          finishRun(store,run.plan_id,reason?'PAUSED':'ATTENTION',reason??`REFUSED_${code||'WALLET'}`);
          continue runs;
        }
        // Timed out, unreadable or unreachable (AGENTIC_UNKNOWN, network): an order may exist.
        setStep(store,run.plan_id,index,'UNKNOWN',{...doc,error:message,code});
        finishRun(store,run.plan_id,'ATTENTION','GATEWAY_UNCERTAIN');
        continue runs;
      }
    }
  }
}
// The leg to send next: the first one not done whose token was not refused in the last five minutes (closed market,
// route price). A purchase never goes ahead of a sale that waits, since it may need that sale's USDT.
function nextLeg(store,planId,legs,now,waited){
  const steps=new Map(store.db.prepare('SELECT step,phase,document FROM agent_steps WHERE plan_id=?').all(planId).map(s=>[s.step,s]));
  let saleWaits=false,reason=null;
  for(const [i,leg] of legs.entries()){
    const s=steps.get(i);
    if(s?.phase==='RECONCILED')continue;
    const d=s?.phase==='READY'?JSON.parse(s.document):null;
    if(!waited.has(i)&&!(d?.waitSince&&now-d.waitSince<PAUSE_RETRY_MS)){if(!saleWaits||leg.side==='SELL')return {index:i};continue;}
    reason??=d?.waitReason??'MARKET_CLOSED';saleWaits||=leg.side==='SELL';
  }
  return {index:null,reason};
}
