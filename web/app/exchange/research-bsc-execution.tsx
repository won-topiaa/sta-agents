"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {AgentPlan} from '@/lib/research-agent-types';
import type {AgentController,RefusalQuote} from './research-agent-panel';
import {ensureResearchSession,researchPrincipalOf,evmProvider} from './research-session';
import {approvalText} from './research-agent-profile';
import {useResearchDemo} from './research-demo-context';

// BNB Smart Chain execution for an approved plan. Personal wallet: every approval and swap is a
// separate signature over a transaction the server already checked and dry-ran. Agentic Wallet:
// the agent runs the approved legs within the limits the owner set in the Binance app.
const tokenUnits=(atoms:string,decimals=18)=>{try{return (Number(BigInt(atoms))/10**decimals).toLocaleString('en-US',{maximumSignificantDigits:6});}catch{return '—';}};
const usdt=(atoms:string)=>`${(Number(BigInt(atoms)/10n**12n)/1e6).toLocaleString('en-US',{maximumFractionDigits:2})} USDT`;
const phaseText:Record<string,string>={READY:'Ready',APPROVE_PREPARED:'Approval ready to sign',APPROVE_SENT:'Approval confirming',ALLOWANCE_READY:'Approved · swap next',
  SWAP_PREPARED:'Swap ready to sign',SUBMITTED:'Confirming on BNB Chain',RECONCILED:'Purchased',FAILED:'Reverted · nothing bought',UNKNOWN:'Needs a check',
  AGENTIC_SUBMITTING:'Agent ordering',AGENTIC_SUBMITTED:'Agent order pending'};
// Completed parts of one trade: USDT approval, swap, confirmation. A swap prepared without an approval
// step means the router already had enough allowance.
// A live route the server quoted before refusing to build the transaction (no BNB for gas, or not enough USDT).
const units=(atoms:string,decimals:number)=>{try{const n=Number(BigInt(atoms))/10**decimals;return n.toLocaleString('en-US',{maximumSignificantDigits:4});}catch{return '—';}};
function RefusedQuote({quote,code,message}:{quote:RefusalQuote;code?:string;message:string|null}){
  const at=quote.quotedAt==null?null:new Date(typeof quote.quotedAt==='number'?quote.quotedAt:Date.parse(quote.quotedAt)),impact=Number(quote.priceImpactPercent);
  return <div className="bsc-refused" role="status"><b>Live Binance quote</b>
    <span>{units(quote.fromAmount,18)} {quote.fromSymbol??'USDT'} → {units(quote.toTokenAmount,quote.toDecimals??18)} {quote.toSymbol??''}{quote.vendor&&<> via {quote.vendor}</>}{Number.isFinite(impact)&&<> · price impact {impact.toFixed(2)}%</>}{at&&!Number.isNaN(at.getTime())&&<> · {at.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</>}</span>
    <small>{message??(code==='NO_GAS'?'Add BNB for network fees to this wallet to execute.':'Add BNB (gas) and USDT to this wallet to execute.')}</small></div>;
}
const stageOf=(phase:string)=>phase==='RECONCILED'?3:phase==='SUBMITTED'?2:['ALLOWANCE_READY','SWAP_PREPARED'].includes(phase)?1:0;
// A quote is signed within a minute of the dry run; after that the owner gets a fresh one.
const QUOTE_TTL_MS=60000,quoteStale=(receivedAt?:number)=>Date.now()-(receivedAt??0)>QUOTE_TTL_MS;
// EIP-1193 user rejection: nothing was sent, so the same transaction may be offered again.
const userRejected=(e:unknown)=>{const {code,message}=(e??{}) as {code?:unknown;message?:unknown};return code===4001||code==='ACTION_REJECTED'||/user (rejected|denied|cancel)/i.test(String(message??''));};
type Prepared={receivedAt?:number;kind:'APPROVE'|'SWAP';tx:{from:string;to:string;data:string;value:string;gas:string;gasPrice?:string;minReceiveAmount?:string};quote?:{vendor:string;toTokenAmount:string;toSymbol?:string;toDecimals?:number;priceImpactPercent?:string}|null};

export function BscPlanExecution({plan,agent,onRefresh}:{plan:AgentPlan;agent:AgentController;wallet:string;onRefresh:()=>void}){
  const [busy,setBusy]=useState<number|null>(null),[error,setError]=useState<string|null>(null),[pending,setPending]=useState<Record<number,Prepared>>({});
  const demo=useResearchDemo();
  // Hashes the wallet returned that the server has not accepted yet. A sent step is never offered for signing again
  // (that would send a second transaction); it can only be reported, until the server records it.
  const [sent,setSent]=useState<Record<number,string>>({}),[typed,setTyped]=useState<Record<number,string>>({});
  const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const sentKey=(i:number)=>`xtxc-bsc-sent:${plan.id}:${i}`;
  const storedSent=(i:number)=>{try{return sessionStorage.getItem(sentKey(i));}catch{return null;}};
  const stepOf=(i:number)=>plan.steps.find(s=>s.index===i);
  const refused=agent.failure?.operation==='BSC_PREPARE'&&agent.failure.planId===plan.id?agent.failure:null;
  async function prepare(i:number){
    setBusy(i);setError(null);
    try{const b=await agent.act({operation:'BSC_PREPARE',planId:plan.id,index:i});if(b&&live.current)setPending(p=>({...p,[i]:{...(b.prepared as Prepared),receivedAt:Date.now()}}));}
    finally{if(live.current)setBusy(null);}
  }
  async function sign(i:number){
    const p=pending[i];if(!p)return;
    const drop=()=>setPending(x=>{const n={...x};delete n[i];return n;});
    if(quoteStale(p.receivedAt)){drop();setError('That quote is more than a minute old. Get a new quote.');return;}
    setBusy(i);setError(null);
    try{
      const provider=evmProvider();if(!provider)throw new Error('Enable your BNB Chain wallet.');
      if(await provider.request({method:'eth_chainId'})!=='0x38')await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});
      const toHex=(v:string)=>'0x'+BigInt(v).toString(16);
      // The wallet shows and signs exactly the checked transaction (the wallet prices the gas); the server re-reads it on chain.
      let hash:string;
      try{hash=await provider.request({method:'eth_sendTransaction',params:[{from:p.tx.from,to:p.tx.to,data:p.tx.data,value:toHex(p.tx.value),gas:toHex(p.tx.gas)}]}) as string;}
      catch(e){
        // Anything but a rejection (a timeout, a dropped connection) may still have sent it: never offer the same signature twice.
        if(!userRejected(e)){if(live.current)drop();throw new Error('Your wallet did not confirm in time. If it sent the transaction anyway, report its hash below; otherwise get a new quote.');}
        throw e;
      }
      try{sessionStorage.setItem(sentKey(i),hash);}catch{}
      if(live.current){setSent(x=>({...x,[i]:hash}));setPending(x=>{const n={...x};delete n[i];return n;});}
      await report(i,hash);onRefresh();
    }catch(e){if(live.current)setError(e instanceof Error?e.message:'The wallet did not send the transaction.');}
    finally{if(live.current)setBusy(null);}
  }
  // A just-sent transaction can take a few seconds to become visible to the gateway; retry before asking the owner.
  async function report(i:number,hash:string){
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash.trim())){setError('Paste the 66-character transaction hash (0x…).');return false;}
    for(let n=0;n<5&&live.current;n++){
      if(await agent.act({operation:'BSC_SENT',planId:plan.id,index:i,txHash:hash.trim()})){
        try{sessionStorage.removeItem(sentKey(i));}catch{}
        if(live.current)setSent(x=>{const m={...x};delete m[i];return m;});
        return true;
      }
      await new Promise(r=>setTimeout(r,3000*(n+1)));
    }
    return false;
  }
  async function reportNow(i:number,hash:string){setBusy(i);setError(null);try{await report(i,hash);onRefresh();}finally{if(live.current)setBusy(null);}}
  // A quote older than a minute is dropped, so the step asks for a fresh one (not while its wallet prompt is open).
  useEffect(()=>{const ends=Object.entries(pending).filter(([k])=>Number(k)!==busy).map(([,p])=>(p.receivedAt??0)+QUOTE_TTL_MS);if(!ends.length)return;
    const t=setTimeout(()=>setPending(x=>Object.fromEntries(Object.entries(x).filter(([k,p])=>Number(k)===busy||Date.now()-(p.receivedAt??0)<=QUOTE_TTL_MS))),Math.max(0,Math.min(...ends)-Date.now())+50);
    return()=>clearTimeout(t);},[pending,busy]);
  const checking=plan.steps.some(s=>['APPROVE_SENT','SUBMITTED'].includes(s.phase));
  useEffect(()=>{if(!checking||demo)return;const t=setInterval(()=>{const s=plan.steps.find(s=>['APPROVE_SENT','SUBMITTED'].includes(s.phase));if(s&&!agent.busy)void agent.act({operation:'BSC_CHECK',planId:plan.id,index:s.index}).then(onRefresh);},5000);return()=>clearInterval(t);},[checking,plan.id,plan.steps,agent,onRefresh,demo]);
  const planLive=['APPROVED','PARTIAL','UNKNOWN'].includes(plan.status);
  // In the demo an Agentic plan's legs are the orders the agent placed, listed without any wallet step.
  const byAgent=plan.wallet==='AGENTIC'||plan.agent?.approval==='AUTO_WITHIN_LIMITS';
  return <details open className="bsc-exec"><summary>{demo&&byAgent?'Orders placed by the agent':'Trade with your BNB Chain wallet'}</summary>
    {!planLive&&plan.status!=='COMPLETE'&&<p className="ra-caption">This plan {plan.status==='REVOKED'?'was stopped':'has expired'}, so its remaining trades can no longer be sent. Approve a strategy again under Results to get a new plan.</p>}
    {planLive&&!demo&&<ol className="bsc-how"><li><b>Get a quote.</b> We check the route and dry-run it on BNB Chain.</li><li><b>Approve the token you pay with.</b> USDT for a purchase, the stock token for a sale. Your wallet allows exactly this amount, nothing more.</li><li><b>Confirm the swap.</b> Your wallet signs the checked transaction.</li></ol>}
    <div className="ra-trade-legs">{plan.legs.map((leg,i)=>{
      const step=stepOf(i),phase=step?.phase??'READY',p=pending[i],prevDone=i===0||stepOf(i-1)?.phase==='RECONCILED';
      const prepared=['APPROVE_PREPARED','SWAP_PREPARED'].includes(phase),sentHash=prepared?sent[i]??storedSent(i):null;
      // An earlier prepared transaction of this step can still be reported after a failed or interrupted attempt.
      const earlier=!prepared&&['READY','ALLOWANCE_READY','FAILED'].includes(phase)&&Boolean((step as {preparedAll?:unknown[]}|undefined)?.preparedAll?.length);
      const canPrepare=!sentHash&&prevDone&&['READY','ALLOWANCE_READY','FAILED','APPROVE_PREPARED','SWAP_PREPARED'].includes(phase)&&['APPROVED','PARTIAL'].includes(plan.status);
      // A signed swap's receipt, or the transaction of an order the Agentic Wallet filled.
      const receipt=(step as {receipts?:{hash:string;kind:string;status:string}[]}|undefined)?.receipts?.filter(r=>r.kind==='SWAP').at(-1)
        ??((h=>typeof h==='string'&&/^0x[0-9a-fA-F]{64}$/.test(h)?{hash:h,kind:'SWAP',status:'SUCCESS'}:undefined)((step as {order?:{txHash?:unknown}}|undefined)?.order?.txHash));
      const stage=stageOf(phase),started=Boolean(p)||!['READY','FAILED'].includes(phase);
      // A sale spends the stock token (whole holding) for USDT; a purchase spends USDT.
      const sell=leg.side==='SELL',paying=sell?leg.productSymbol??'token':'USDT',amount=sell?`${tokenUnits(leg.inputAtoms,leg.inputDecimals??18)} ${leg.productSymbol??leg.instrument}`:usdt(leg.inputAtoms);
      return <div key={i} className="bsc-leg"><span><small className="bsc-leg-count">Trade {i+1} of {plan.legs.length}</small><b>{sell?'Sell':'Buy'} {leg.instrument}</b><small>{amount} · {sell&&phase==='RECONCILED'?'Sold':phaseText[phase]??phase}</small>
          <ol className="bsc-track" aria-label={`Trade ${i+1} progress`}>{[`Approve ${paying}`,'Swap','Confirmed'].map((t,k)=><li key={t} className={k<stage?'done':started&&k===stage?'now':''}>{t}</li>)}</ol>
          {p&&<small>{p.kind==='APPROVE'?`Lets the Binance router spend exactly ${amount}`:<>Route: {p.quote?.vendor??'Binance'} · dry run passed{p.quote&&p.tx.minReceiveAmount&&<> · you get ≈ {units(p.quote.toTokenAmount,p.quote.toDecimals??18)} {p.quote.toSymbol??''}, at least {units(p.tx.minReceiveAmount,p.quote.toDecimals??18)}</>}</>}</small>}
          {receipt&&<a href={`https://bscscan.com/tx/${receipt.hash}`} target="_blank" rel="noreferrer">View on BscScan ↗</a>}
          {demo&&phase==='FAILED'&&<small>Reverted on chain: nothing was bought and the USDT stayed in the wallet.</small>}
          {refused?.index===i&&refused.quote&&<RefusedQuote quote={refused.quote} code={refused.code} message={agent.error}/>}
          {sentHash&&<small className="bsc-sent">Sent from your wallet: <a href={`https://bscscan.com/tx/${sentHash}`} target="_blank" rel="noreferrer">{sentHash.slice(0,10)}…{sentHash.slice(-6)} ↗</a>. Report it so this trade can continue.</small>}
          {!demo&&(prepared||earlier)&&!sentHash&&!p&&<details className="bsc-paste"><summary>{earlier?'Did an earlier attempt of this trade go through?':'Already sent this step from your wallet?'}</summary>
            <span><input aria-label="Transaction hash" placeholder="0x… transaction hash" value={typed[i]??''} onChange={e=>setTyped(x=>({...x,[i]:e.target.value}))}/><button disabled={busy!==null||!(typed[i]??'').trim()} onClick={()=>void reportNow(i,typed[i]??'')}>Report</button></span>
            <small>Copy it from your wallet&apos;s activity or BscScan. Do not sign the step again.</small></details>}</span>
        {phase==='RECONCILED'?<span className="bsc-done">{sell?'Sold':'Purchased'}</span>:demo?null:sentHash?<button className="ra-primary" disabled={busy!==null} onClick={()=>void reportNow(i,sentHash)}>{busy===i?'Reporting…':'Report sent transaction'}</button>:p&&planLive?<button className="ra-primary" disabled={busy!==null} onClick={()=>void sign(i)}>{busy===i?'Waiting for wallet…':p.kind==='APPROVE'?`Approve ${paying} in wallet`:'Confirm swap in wallet'}</button>
          :<span className="bsc-action"><button className={canPrepare?'ra-primary':''} disabled={busy!==null||!canPrepare} onClick={()=>void prepare(i)}>{busy===i?'Checking…':phase==='ALLOWANCE_READY'?'Get swap quote':'Get quote'}</button>{!prevDone&&<small>After trade {i}</small>}</span>}
      </div>;})}</div>
    {/* Agent request errors (e.g. no gas) are shown once, below the plans. */}
    {error&&<p className="ra-error" role="alert">{error}</p>}
  </details>;
}

type AgenticState={status:string;bound:{mine:boolean;address:string|null}|null;settings:Record<string,unknown>|null;quota:Record<string,unknown>|null;run:{status:string;reason:string|null}|null};
type Signin={qrCodeId?:string;urlForWeb?:string;pairingCode?:string;expireAt?:string};
const pick=(o:Record<string,unknown>|null|undefined,keys:string[])=>{for(const k of keys){const v=o?.[k];if(v!=null&&v!=='')return String(v);}return null;};
// One Agentic Wallet per account: connect once (QR in the Binance app), then any AUTO agent can use it.
export function useAgentic(wallet:string,planId?:string){
  const [state,setState]=useState<AgenticState|null>(null),[signin,setSignin]=useState<Signin|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const api='/api/v1/stocklana/research/agentic',live=useRef(true),demo=useResearchDemo();
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const headers=useCallback(()=>({'Content-Type':'application/json','X-Skew-Expected-Requester':researchPrincipalOf(wallet)}),[wallet]);
  const load=useCallback(()=>fetch(`${api}${planId?`?planId=${planId}`:''}`,{cache:'no-store',headers:headers()}).then(r=>r.json().then(b=>r.ok?b as AgenticState:null)).catch(()=>null),[planId,headers]);
  useEffect(()=>{
    if(demo)return;   // the demo shows its recorded state; nothing is polled
    let on=true;void load().then(s=>{if(on&&s)setState(s);});const t=setInterval(()=>void load().then(s=>{if(on&&s)setState(s);}),8000);return()=>{on=false;clearInterval(t);};},[load,demo,planId]);
  async function post(body:Record<string,unknown>,timeout=30000){
    if(demo)return null;
    setBusy(true);setError(null);
    try{await ensureResearchSession(wallet);const r=await fetch(api,{method:'POST',headers:headers(),body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)}),b=await r.json();if(!r.ok)throw new Error(b.error?.message??'Request failed.');const s=await load();if(live.current&&s)setState(s);return b;}
    catch(e){if(live.current)setError(e instanceof Error?e.message:'Request failed.');return null;}finally{if(live.current)setBusy(false);}
  }
  async function connect(){const b=await post({operation:'SIGNIN'});if(!b?.signin)return;setSignin(b.signin);const v=await post({operation:'VERIFY',qrCodeId:b.signin.qrCodeId},340000);if(live.current)setSignin(null);return v;}
  const shown=demo?(demo.agentic[planId??'']??demo.agentic['']??null) as AgenticState|null:state;
  const connected=Boolean(shown&&shown.status!=='UNCONNECTED'&&shown.bound?.mine);
  return{state:shown,signin,busy,error,connected,connect,post};
}
export function AgenticConnect({agentic}:{agentic:ReturnType<typeof useAgentic>}){
  const {state,signin,busy,error,connected}=agentic,demo=useResearchDemo();
  if(connected){
    const left=pick(state?.quota,['quotaLeft','leftQuota','left','remaining']),limit=pick(state?.quota,['dailyLimit','limit','quota'])??pick(state?.settings,['dailyLimit','dailyQuota']);
    // The demo has no live quota (settings and quota are null there), so that part is left out rather than shown as —.
    return <p className="ap-bar-limits">Binance Agentic Wallet <a href={`https://bscscan.com/address/${state?.bound?.address}`} target="_blank" rel="noreferrer">{state?.bound?.address?.slice(0,6)}…{state?.bound?.address?.slice(-4)}</a>{(left!=null||!demo)&&<> · daily limit left <b>{left??'—'}</b>{limit&&<> of {limit}</>} USD</>} · limits are set in your Binance app</p>;
  }
  return <div className="ap-agentic">
    {signin?.urlForWeb?<p>Open <a href={signin.urlForWeb} target="_blank" rel="noreferrer">Binance sign-in</a> and scan it with the Binance app{signin.pairingCode&&<>, then confirm code <b>{signin.pairingCode}</b></>}. Waiting…</p>
      :<><span>This agent trades through a Binance Agentic Wallet. Its daily limit and token scope are set and enforced in the Binance app.</span>
        {!demo&&<button className="rw-button" disabled={busy} onClick={()=>void agentic.connect()}>{busy?'Opening…':'Connect Agentic Wallet'}</button>}</>}
    {error&&<p className="ra-error" role="alert">{error}</p>}
  </div>;
}
// Why an Agentic run is not running, in the owner's words. An uncertain order is never retried automatically.
const runTitle:Record<string,string>={RUNNING:'Agent running',PAUSED:'Agent paused',STOPPED:'Agent stopped',ATTENTION:'Agent needs your attention',COMPLETE:'Agent finished'};
const until=' It tries again every five minutes until the plan expires (an automatic exit keeps trying for four days).',none=' Nothing was ordered.';
const runReason:Record<string,string>={
  OWNER_STOPPED:'You stopped this agent. Orders already placed stay as they are.',
  DAILY_LIMIT:`Paused: the next order is above the daily limit left in your Binance app.${until}`,
  MARKET_CLOSED:`Paused: this stock is not trading right now.${until}`,
  PRICE_CHECK:`Paused: the route price was too far from the listed token price.${until}`,
  INTERRUPTED:'Stopped: the agent was interrupted while placing an order, so an order may exist. Check Orders in your Binance app before trading this plan again.',
  NO_ORDER_ID:'Stopped: Binance did not return an order id, so an order may exist. Check Orders in your Binance app.',
  GATEWAY_UNCERTAIN:'Stopped: the connection to Binance dropped while placing an order, so an order may exist. Check Orders in your Binance app.',
  ORDER_FAILED:'Stopped: Binance reports an order as failed or cancelled. See its details in your Binance app.',
  WALLET_CHANGED:'Stopped: a different Binance account is now signed in to the Agentic Wallet, so nothing more was ordered. Reconnect your account, then approve again.',
  REFUSED_LIMIT:`Stopped: Binance refused the next order under a limit set in your Binance app.${none}`,
  REFUSED_INPUT:`Stopped: Binance refused the next order's amount.${none}`,
  REFUSED_TOKEN:`Stopped: this token is outside your Agentic Wallet's token scope in the Binance app.${none}`,
  REFUSED_NO_ROUTE:`Stopped: Binance found no route for the next order.${none}`,
  REFUSED_MODE:`Stopped: your Agentic Wallet's mode in the Binance app does not allow this trade.${none}`,
  REFUSED_WALLET:`Stopped: Binance refused the Agentic Wallet for this order. Reconnect it in your Binance app.${none}`,
  UNSUPPORTED_DECIMALS:`Stopped: a token in this plan uses a unit the agent cannot size.${none}`,
  NOT_TRADABLE:'Stopped: a stock in this plan is not tradable on BNB Chain right now.',
  STEP_EXISTS:'Stopped: a trade in this plan was already started another way.',
  PLAN_ENDED:'Stopped: this plan was stopped or has ended.',
  PLAN_EXPIRED:'Stopped: this plan\'s approval expired before all its trades ran. Approve the strategy again for a fresh plan.',
  BRIEF_CHANGED:'Stopped: the strategy changed after you approved this plan. Approve it again to trade.',
  AGENT_SETTING_CHANGED:'Stopped: this agent no longer trades on its own. Change Trade approval in its settings and approve again.'};
export function AgenticPanel({plan,wallet}:{plan:AgentPlan;wallet:string;onRefresh?:()=>void}){
  const agentic=useAgentic(wallet,plan.id),run=agentic.state?.run,demo=useResearchDemo();
  if(plan.agent?.approval!=='AUTO_WITHIN_LIMITS'&&plan.wallet!=='AGENTIC')return !['APPROVED','PARTIAL','UNKNOWN'].includes(plan.status)?null:<p className="ap-note"><b>{plan.agent?`${plan.agent.name}: ${approvalText.PER_TRADE.toLowerCase()}.`:'You confirm every trade.'}</b> Confirm each trade with your wallet below.{plan.agent?' To let the agent trade on its own within Binance limits, change Trade approval in its settings.':''}</p>;
  return <section className="ra-autonomy" aria-label="Agentic Wallet">
    <header><div><h4>{run?runTitle[run.status]??`Agent ${run.status.toLowerCase()}`:'Let your agent trade within limits'}</h4><p>Binance Agentic Wallet · Binance enforces the limits you set in its app.</p></div></header>
    <AgenticConnect agentic={agentic}/>
    {agentic.connected&&<>
      <p className="ra-caption">{(()=>{const sales=plan.legs.filter(l=>l.side==='SELL').length,buys=plan.legs.length-sales;
        return [sales?`This plan sells ${sales} holding${sales===1?'':'s'} for USDT`:'',buys?`${sales?'then buys':'This plan buys'} ${usdt((BigInt(plan.budgetAtoms)-BigInt(plan.cashAtoms)).toString())} of stocks`:''].filter(Boolean).join(', ')+`, in ${plan.legs.length} order${plan.legs.length===1?'':'s'}, one at a time.`;})()}</p>
      {!run&&!demo&&<button className="ra-primary" disabled={agentic.busy||plan.status!=='APPROVED'} onClick={()=>void agentic.post({operation:'START',planId:plan.id})}>Start agent</button>}
      {run?.status==='RUNNING'&&!demo&&<button className="ra-text" disabled={agentic.busy} onClick={()=>void agentic.post({operation:'STOP',planId:plan.id})}>Stop remaining trades</button>}
      {run&&run.status!=='RUNNING'&&run.reason&&<p className="ra-caption">{runReason[run.reason]??run.reason}</p>}
    </>}
  </section>;
}

// The owner's tokens of this strategy's stocks, read on BNB Chain when asked, in the owner's wallet and (when bound)
// the Agentic Wallet. Selling creates a sale plan from the wallet that holds the tokens: the owner then signs each
// sale (own wallet) or starts the agent (Agentic Wallet).
type Held={instrument:string;platform:string;contract:string;symbol:string;decimals:number;raw:string;priceUsd:number|null};
type WalletHoldings={wallet:'PERSONAL'|'AGENTIC';address:string;holdings:Held[]};
export function BscHoldings({agent,strategyId}:{agent:AgentController;strategyId:string}){
  const [held,setHeld]=useState<WalletHoldings[]|null>(null),demo=useResearchDemo();
  async function load(){const b=await agent.act({operation:'BSC_HOLDINGS',strategyId});if(b)setHeld((b as {wallets:WalletHoldings[]}).wallets);}
  async function sell(wallet:'PERSONAL'|'AGENTIC',instruments?:string[]){const b=await agent.act({operation:'BSC_CLOSE',strategyId,wallet,...(instruments?{instruments}:{})});if(b)setHeld(null);}
  const value=(h:Held)=>{const n=Number(BigInt(h.raw))/10**h.decimals;return h.priceUsd?` ≈ $${(n*h.priceUsd).toLocaleString('en-US',{maximumFractionDigits:2})}`:'';};
  if(demo)return <section className="bsc-holdings" aria-label="Holdings in this strategy"><div className="bsc-holdings-head"><div><b>Holdings in this strategy</b><small>The owner reads them on BNB Chain and sells with one click. Here every position was sold back to USDT: see the sale below.</small></div></div></section>;
  return <section className="bsc-holdings" aria-label="Your holdings in this strategy">
    <div className="bsc-holdings-head"><div><b>Your holdings in this strategy</b><small>{held?'Read on BNB Chain just now':'Read on BNB Chain when you ask.'}</small></div>
      <button disabled={agent.busy} onClick={()=>void load()}>{held?'Refresh':'Check holdings'}</button></div>
    {held&&held.map(w=><div key={w.wallet} className="bsc-holdings-wallet"><small className="bsc-holdings-where">{w.wallet==='AGENTIC'?'Agentic Wallet':'Your wallet'} · {w.address.slice(0,6)}…{w.address.slice(-4)}</small>
      {w.holdings.length?<>
        <ul>{w.holdings.map(h=><li key={h.contract}><span><b>{h.instrument}</b><small>{tokenUnits(h.raw,h.decimals)} {h.symbol}{value(h)}</small></span><button disabled={agent.busy} onClick={()=>void sell(w.wallet,[h.instrument])}>Sell</button></li>)}</ul>
        <div className="ra-inline-actions"><button className="ra-primary" disabled={agent.busy} onClick={()=>void sell(w.wallet)}>Sell all</button>
          <small className="ra-caption">Creates a sale plan below. {w.wallet==='AGENTIC'?'Start it to sell from your Agentic Wallet within your Binance limits.':'You confirm each sale in your wallet.'}</small></div></>
        :<p className="ra-caption">No tokens of this strategy&apos;s stocks here.</p>}</div>)}
  </section>;
}
