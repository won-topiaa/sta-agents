import {reject} from './research-agent-core.mjs';
import {bscProduct} from './bsc-research-universe.mjs';

// Agentic Wallet execution for agents set to "trade on its own within limits".
// The Binance Agentic Wallet (MPC, Binance app) enforces the owner's daily USD limit and token scope;
// this module adds STA's own rules: only an approved BSC plan of an AUTO agent, legs in order,
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
export function agenticRun(store,planId){return store.db.prepare('SELECT * FROM agent_agentic_runs WHERE plan_id=?').get(planId)??null;}
export function startAgentic(store,address,planId,quotaLeftUsd){
  const owner=store.owner(address),p=store.plan(address,planId),b=agenticBinding(store);
  if(p.chain!=='eip155:56')reject('Agentic execution is for BNB Chain plans.',409);
  if(!p.agent)reject('Only a plan designed by your agent can run on its own.',409);
  store.assertAutonomyAllowed(address,p);   // the agent's CURRENT setting must allow trading on its own
  if(!b||b.owner!==owner)reject('Connect your Agentic Wallet first.',409);
  if(p.status!=='APPROVED'||Date.now()>p.expiresAt)reject('Approve a current plan first.',409);
  // Tokens to sell must be in the Agentic Wallet; holdings in the owner's own wallet are signed there, step by step.
  if(p.wallet==='PERSONAL'&&p.legs.some(l=>l.side==='SELL'))reject('These holdings are in your own wallet. Sign each sale in the trade steps.',409);
  if(store.db.prepare('SELECT 1 FROM agent_steps WHERE plan_id=?').get(planId))reject('This plan already has trades. Use a fresh approval.',409);
  const total=usd18(p.budgetAtoms)-usd18(p.cashAtoms);
  if(!(Number(quotaLeftUsd)>=total))reject(`Your Agentic Wallet has $${Number(quotaLeftUsd).toFixed(2)} of daily limit left; this plan needs $${total.toFixed(2)}.`,409);
  const now=Date.now();
  store.db.prepare("INSERT INTO agent_agentic_runs VALUES(?,?,?,'RUNNING',NULL,?,?) ON CONFLICT(plan_id) DO NOTHING").run(planId,owner,b.address,now,now);
  store.event(owner,p.strategyId,'AGENTIC_STARTED',{planId,wallet:b.address});
  return agenticRun(store,planId);
}
export function stopAgentic(store,address,planId){
  const owner=store.owner(address),p=store.plan(address,planId);
  store.db.prepare("UPDATE agent_agentic_runs SET status='STOPPED',reason='OWNER_STOPPED',updated_at=? WHERE plan_id=? AND owner=? AND status='RUNNING'").run(Date.now(),planId,owner);
  store.event(owner,p.strategyId,'AGENTIC_STOPPED',{planId});   // an order already sent is not cancelled by this
  return agenticRun(store,planId);
}
const setStep=(store,planId,index,phase,doc)=>store.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?) ON CONFLICT(plan_id,step) DO UPDATE SET phase=excluded.phase,document=excluded.document').run(planId,index,phase,JSON.stringify(doc));
const finishRun=(store,planId,status,reason=null)=>store.db.prepare('UPDATE agent_agentic_runs SET status=?,reason=?,updated_at=? WHERE plan_id=?').run(status,reason,Date.now(),planId);

// One pass over running plans. `gw(method,path,body)` calls the BNB gateway.
export async function agenticTick(store,gw){
  const runs=store.db.prepare("SELECT r.*,p.document,p.strategy FROM agent_agentic_runs r JOIN agent_plans p ON p.id=r.plan_id WHERE r.status IN ('RUNNING','STOPPED') ORDER BY r.created_at LIMIT 10").all();
  for(const run of runs){
    const plan=JSON.parse(run.document),steps=store.db.prepare('SELECT step,phase,document FROM agent_steps WHERE plan_id=? ORDER BY step').all(run.plan_id);
    const open=steps.find(s=>['AGENTIC_SUBMITTING','AGENTIC_SUBMITTED'].includes(s.phase));
    if(open){   // settle the order in flight first; never submit the next leg before it
      const doc=JSON.parse(open.document);
      if(open.phase==='AGENTIC_SUBMITTING'){setStep(store,run.plan_id,open.step,'UNKNOWN',{...doc,reason:'INTERRUPTED_BEFORE_ORDER_ID'});finishRun(store,run.plan_id,'ATTENTION','INTERRUPTED');continue;}
      let order;try{order=await gw('GET',`/v1/agentic/order?orderId=${encodeURIComponent(doc.orderId)}`);}catch{continue;}
      const o=Array.isArray(order)?order[0]:order?.list?.[0]??order?.orders?.[0]??order;
      const status=String(o?.status??o?.orderStatus??'PENDING').toUpperCase();
      if(status==='FINISHED'||status==='SUCCESS'||status==='FILLED'){setStep(store,run.plan_id,open.step,'RECONCILED',{...doc,order:o});}
      else if(status==='FAILED'||status==='CANCELLED'){setStep(store,run.plan_id,open.step,'FAILED',{...doc,order:o});finishRun(store,run.plan_id,'ATTENTION','ORDER_FAILED');continue;}
      else continue;
    }
    if(run.status!=='RUNNING')continue;
    const done=store.db.prepare("SELECT count(*) n FROM agent_steps WHERE plan_id=? AND phase='RECONCILED'").get(run.plan_id).n;
    store.db.prepare('UPDATE agent_plans SET status=? WHERE id=?').run(done===plan.legs.length?'COMPLETE':done?'PARTIAL':'APPROVED',run.plan_id);
    if(done===plan.legs.length){finishRun(store,run.plan_id,'COMPLETE');store.event(run.owner,run.strategy,'AGENTIC_COMPLETE',{planId:run.plan_id});continue;}
    // A sale names the exact token held (Ondo or bStock); a purchase buys the listed product.
    const index=done,leg=plan.legs[index],sell=leg.side==='SELL',product=sell?{contract:leg.productContract,symbol:leg.productSymbol,platform:leg.platform}:bscProduct(leg.instrument);
    if(!product?.contract){finishRun(store,run.plan_id,'ATTENTION','NOT_TRADABLE');continue;}
    let quota;try{quota=await gw('GET','/v1/agentic/quota');}catch{continue;}
    const left=Number(quota?.quotaLeft??quota?.leftQuota??quota?.left??NaN);
    // A purchase leg's USD value is known; a sale's is not until it fills, so Binance's own limit check covers it.
    if(!sell&&Number.isFinite(left)&&left<usd18(leg.inputAtoms)){finishRun(store,run.plan_id,'PAUSED','DAILY_LIMIT');continue;}
    const doc={leg,product,mode:'AGENTIC',wallet:run.address,at:Date.now()};
    setStep(store,run.plan_id,index,'AGENTIC_SUBMITTING',doc);   // durable before the order exists
    try{
      const r=await gw('POST','/v1/agentic/swap',sell?{fromToken:product.contract,toToken:USDT,fromTokenQty:decimal18(leg.inputAtoms)}:{fromToken:USDT,toToken:product.contract,fromTokenQty:decimal18(leg.inputAtoms)});
      const orderId=r?.orderId??r?.id??r?.order?.orderId;
      if(!orderId){setStep(store,run.plan_id,index,'UNKNOWN',{...doc,reason:'NO_ORDER_ID',reply:r});finishRun(store,run.plan_id,'ATTENTION','NO_ORDER_ID');continue;}
      setStep(store,run.plan_id,index,'AGENTIC_SUBMITTED',{...doc,orderId:String(orderId)});
      store.event(run.owner,run.strategy,'TRADE_STATUS',{planId:run.plan_id,index,phase:'AGENTIC_SUBMITTED'});
    }catch(e){
      // A rejected request (limit, market closed) placed no order; an unreachable gateway might have.
      const known=/limit|quota|closed|paused|minimum|invalid|not allowed/i.test(String(e?.message));
      setStep(store,run.plan_id,index,known?'READY':'UNKNOWN',{...doc,error:String(e?.message??'').slice(0,200)});
      finishRun(store,run.plan_id,known?'PAUSED':'ATTENTION',known?String(e.message).slice(0,120):'GATEWAY_UNCERTAIN');
    }
  }
}
