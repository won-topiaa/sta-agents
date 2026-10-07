"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {AgentPlan} from '@/lib/research-agent-types';
import type {AgentController,RefusalQuote} from './research-agent-panel';
import {ensureResearchSession,researchPrincipalOf,evmProvider} from './research-session';
import {approvalText} from './research-agent-profile';

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
type Prepared={kind:'APPROVE'|'SWAP';tx:{from:string;to:string;data:string;value:string;gas:string;gasPrice?:string;minReceiveAmount?:string};quote?:{vendor:string;toTokenAmount:string;priceImpactPercent?:string}|null};

export function BscPlanExecution({plan,agent,onRefresh}:{plan:AgentPlan;agent:AgentController;wallet:string;onRefresh:()=>void}){
  const [busy,setBusy]=useState<number|null>(null),[error,setError]=useState<string|null>(null),[pending,setPending]=useState<Record<number,Prepared>>({});
  const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const stepOf=(i:number)=>plan.steps.find(s=>s.index===i);
  const refused=agent.failure?.operation==='BSC_PREPARE'&&agent.failure.planId===plan.id?agent.failure:null;
  async function prepare(i:number){
    setBusy(i);setError(null);
    try{const b=await agent.act({operation:'BSC_PREPARE',planId:plan.id,index:i,slippagePercent:'1'});if(b&&live.current)setPending(p=>({...p,[i]:b.prepared as Prepared}));}
    finally{if(live.current)setBusy(null);}
  }
  async function sign(i:number){
    const p=pending[i];if(!p)return;setBusy(i);setError(null);
    try{
      const provider=evmProvider();if(!provider)throw new Error('Enable your BNB Chain wallet.');
      if(await provider.request({method:'eth_chainId'})!=='0x38')await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]});
      const toHex=(v:string)=>'0x'+BigInt(v).toString(16);
      // The wallet shows and signs exactly the checked transaction; the server re-reads it on chain.
      const hash=await provider.request({method:'eth_sendTransaction',params:[{from:p.tx.from,to:p.tx.to,data:p.tx.data,value:toHex(p.tx.value),gas:toHex(p.tx.gas),...(p.tx.gasPrice?{gasPrice:toHex(p.tx.gasPrice)}:{})}]}) as string;
      try{sessionStorage.setItem(`xtxc-bsc-sent:${plan.id}:${i}`,hash);}catch{}
      await agent.act({operation:'BSC_SENT',planId:plan.id,index:i,txHash:hash});
      if(live.current)setPending(x=>{const n={...x};delete n[i];return n;});onRefresh();
    }catch(e){if(live.current)setError(e instanceof Error?e.message:'The wallet did not send the transaction.');}
    finally{if(live.current)setBusy(null);}
  }
  const checking=plan.steps.some(s=>['APPROVE_SENT','SUBMITTED'].includes(s.phase));
  useEffect(()=>{if(!checking)return;const t=setInterval(()=>{const s=plan.steps.find(s=>['APPROVE_SENT','SUBMITTED'].includes(s.phase));if(s&&!agent.busy)void agent.act({operation:'BSC_CHECK',planId:plan.id,index:s.index}).then(onRefresh);},5000);return()=>clearInterval(t);},[checking,plan.id,plan.steps,agent,onRefresh]);
  const planLive=['APPROVED','PARTIAL','UNKNOWN'].includes(plan.status);
  return <details open className="bsc-exec"><summary>Trade with your BNB Chain wallet</summary>
    {!planLive&&plan.status!=='COMPLETE'&&<p className="ra-caption">This plan {plan.status==='REVOKED'?'was stopped':'has expired'}, so its remaining trades can no longer be sent. Approve a strategy again under Results to get a new plan.</p>}
    {planLive&&<ol className="bsc-how"><li><b>Get a quote.</b> We check the route and dry-run it on BNB Chain.</li><li><b>Approve the token you pay with.</b> USDT for a purchase, the stock token for a sale. Your wallet allows exactly this amount, nothing more.</li><li><b>Confirm the swap.</b> Your wallet signs the checked transaction.</li></ol>}
    <div className="ra-trade-legs">{plan.legs.map((leg,i)=>{
      const step=stepOf(i),phase=step?.phase??'READY',p=pending[i],prevDone=i===0||stepOf(i-1)?.phase==='RECONCILED';
      const canPrepare=prevDone&&['READY','ALLOWANCE_READY','FAILED','APPROVE_PREPARED','SWAP_PREPARED'].includes(phase)&&['APPROVED','PARTIAL'].includes(plan.status);
      const receipt=(step as {receipts?:{hash:string;kind:string;status:string}[]}|undefined)?.receipts?.filter(r=>r.kind==='SWAP').at(-1);
      const stage=stageOf(phase),started=Boolean(p)||!['READY','FAILED'].includes(phase);
      // A sale spends the stock token (whole holding) for USDT; a purchase spends USDT.
      const sell=leg.side==='SELL',paying=sell?leg.productSymbol??'token':'USDT',amount=sell?`${tokenUnits(leg.inputAtoms,leg.inputDecimals??18)} ${leg.productSymbol??leg.instrument}`:usdt(leg.inputAtoms);
      return <div key={i} className="bsc-leg"><span><small className="bsc-leg-count">Trade {i+1} of {plan.legs.length}</small><b>{sell?'Sell':'Buy'} {leg.instrument}</b><small>{amount} · {sell&&phase==='RECONCILED'?'Sold':phaseText[phase]??phase}</small>
          <ol className="bsc-track" aria-label={`Trade ${i+1} progress`}>{[`Approve ${paying}`,'Swap','Confirmed'].map((t,k)=><li key={t} className={k<stage?'done':started&&k===stage?'now':''}>{t}</li>)}</ol>
          {p&&<small>{p.kind==='APPROVE'?`Lets the Binance router spend exactly ${amount}`:`Route: ${p.quote?.vendor??'Binance'} · dry run passed`}</small>}
          {receipt&&<a href={`https://bscscan.com/tx/${receipt.hash}`} target="_blank" rel="noreferrer">View on BscScan ↗</a>}
          {refused?.index===i&&refused.quote&&<RefusedQuote quote={refused.quote} code={refused.code} message={agent.error}/>}</span>
        {phase==='RECONCILED'?<span className="bsc-done">{sell?'Sold':'Purchased'}</span>:p?<button className="ra-primary" disabled={busy!==null} onClick={()=>void sign(i)}>{busy===i?'Waiting for wallet…':p.kind==='APPROVE'?`Approve ${paying} in wallet`:'Confirm swap in wallet'}</button>
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
  const api='/api/v1/stocklana/research/agentic',live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const headers=useCallback(()=>({'Content-Type':'application/json','X-Skew-Expected-Requester':researchPrincipalOf(wallet)}),[wallet]);
  const load=useCallback(()=>fetch(`${api}${planId?`?planId=${planId}`:''}`,{cache:'no-store',headers:headers()}).then(r=>r.json().then(b=>r.ok?b as AgenticState:null)).catch(()=>null),[planId,headers]);
  useEffect(()=>{let on=true;void load().then(s=>{if(on&&s)setState(s);});const t=setInterval(()=>void load().then(s=>{if(on&&s)setState(s);}),8000);return()=>{on=false;clearInterval(t);};},[load]);
  async function post(body:Record<string,unknown>,timeout=30000){
    setBusy(true);setError(null);
    try{await ensureResearchSession(wallet);const r=await fetch(api,{method:'POST',headers:headers(),body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)}),b=await r.json();if(!r.ok)throw new Error(b.error?.message??'Request failed.');const s=await load();if(live.current&&s)setState(s);return b;}
    catch(e){if(live.current)setError(e instanceof Error?e.message:'Request failed.');return null;}finally{if(live.current)setBusy(false);}
  }
  async function connect(){const b=await post({operation:'SIGNIN'});if(!b?.signin)return;setSignin(b.signin);const v=await post({operation:'VERIFY',qrCodeId:b.signin.qrCodeId},340000);if(live.current)setSignin(null);return v;}
  const connected=Boolean(state&&state.status!=='UNCONNECTED'&&state.bound?.mine);
  return{state,signin,busy,error,connected,connect,post};
}
export function AgenticConnect({agentic}:{agentic:ReturnType<typeof useAgentic>}){
  const {state,signin,busy,error,connected}=agentic;
  if(connected){
    const left=pick(state?.quota,['quotaLeft','leftQuota','left','remaining']),limit=pick(state?.quota,['dailyLimit','limit','quota'])??pick(state?.settings,['dailyLimit','dailyQuota']);
    return <p className="ap-bar-limits">Binance Agentic Wallet <a href={`https://bscscan.com/address/${state?.bound?.address}`} target="_blank" rel="noreferrer">{state?.bound?.address?.slice(0,6)}…{state?.bound?.address?.slice(-4)}</a> · daily limit left <b>{left??'—'}</b>{limit&&<> of {limit}</>} USD · limits are set in your Binance app</p>;
  }
  return <div className="ap-agentic">
    {signin?.urlForWeb?<p>Open <a href={signin.urlForWeb} target="_blank" rel="noreferrer">Binance sign-in</a> and scan it with the Binance app{signin.pairingCode&&<>, then confirm code <b>{signin.pairingCode}</b></>}. Waiting…</p>
      :<><span>This agent trades through a Binance Agentic Wallet. Its daily limit and token scope are set and enforced in the Binance app.</span>
        <button className="rw-button" disabled={busy} onClick={()=>void agentic.connect()}>{busy?'Opening…':'Connect Agentic Wallet'}</button></>}
    {error&&<p className="ra-error" role="alert">{error}</p>}
  </div>;
}
export function AgenticPanel({plan,wallet}:{plan:AgentPlan;wallet:string;onRefresh?:()=>void}){
  const agentic=useAgentic(wallet,plan.id),run=agentic.state?.run;
  if(plan.agent?.approval!=='AUTO_WITHIN_LIMITS')return !['APPROVED','PARTIAL','UNKNOWN'].includes(plan.status)?null:<p className="ap-note"><b>{plan.agent?`${plan.agent.name}: ${approvalText.PER_TRADE.toLowerCase()}.`:'You confirm every trade.'}</b> Confirm each trade with your wallet below.{plan.agent?' To let the agent trade on its own within Binance limits, change Trade approval in its settings.':''}</p>;
  return <section className="ra-autonomy" aria-label="Agentic Wallet">
    <header><div><h4>{run?`Agent ${run.status.toLowerCase()}`:'Let your agent trade within limits'}</h4><p>Binance Agentic Wallet · Binance enforces the limits you set in its app.</p></div></header>
    <AgenticConnect agentic={agentic}/>
    {agentic.connected&&<>
      <p className="ra-caption">{(()=>{const sales=plan.legs.filter(l=>l.side==='SELL').length,buys=plan.legs.length-sales;
        return [sales?`This plan sells ${sales} holding${sales===1?'':'s'} for USDT`:'',buys?`${sales?'then buys':'This plan buys'} ${usdt((BigInt(plan.budgetAtoms)-BigInt(plan.cashAtoms)).toString())} of stocks`:''].filter(Boolean).join(', ')+`, in ${plan.legs.length} order${plan.legs.length===1?'':'s'}, one at a time.`;})()}</p>
      {!run&&<button className="ra-primary" disabled={agentic.busy||plan.status!=='APPROVED'} onClick={()=>void agentic.post({operation:'START',planId:plan.id})}>Start agent</button>}
      {run?.status==='RUNNING'&&<button className="ra-text" disabled={agentic.busy} onClick={()=>void agentic.post({operation:'STOP',planId:plan.id})}>Stop remaining trades</button>}
      {run&&run.status!=='RUNNING'&&run.reason&&<p className="ra-caption">{run.reason}</p>}
    </>}
  </section>;
}

// The owner's tokens of this strategy's stocks, read on BNB Chain when asked. Selling creates a sale plan: the owner
// then signs each sale (own wallet) or starts the agent (Agentic Wallet).
type Held={instrument:string;platform:string;contract:string;symbol:string;decimals:number;raw:string;priceUsd:number|null};
export function BscHoldings({agent,strategyId}:{agent:AgentController;strategyId:string}){
  const [held,setHeld]=useState<{wallet:'PERSONAL'|'AGENTIC';holdings:Held[]}|null>(null);
  async function load(){const b=await agent.act({operation:'BSC_HOLDINGS',strategyId});if(b)setHeld(b as {wallet:'PERSONAL'|'AGENTIC';holdings:Held[]});}
  async function sell(instruments?:string[]){const b=await agent.act({operation:'BSC_CLOSE',strategyId,...(instruments?{instruments}:{})});if(b)setHeld(null);}
  const value=(h:Held)=>{const n=Number(BigInt(h.raw))/10**h.decimals;return h.priceUsd?` ≈ $${(n*h.priceUsd).toLocaleString('en-US',{maximumFractionDigits:2})}`:'';};
  return <section className="bsc-holdings" aria-label="Your holdings in this strategy">
    <div className="bsc-holdings-head"><div><b>Your holdings in this strategy</b><small>{held?(held.wallet==='AGENTIC'?'In your Agentic Wallet':'In your wallet')+' · read on BNB Chain':'Read on BNB Chain when you ask.'}</small></div>
      <button disabled={agent.busy} onClick={()=>void load()}>{held?'Refresh':'Check holdings'}</button></div>
    {held&&(held.holdings.length?<>
      <ul>{held.holdings.map(h=><li key={h.contract}><span><b>{h.instrument}</b><small>{tokenUnits(h.raw,h.decimals)} {h.symbol}{value(h)}</small></span><button disabled={agent.busy} onClick={()=>void sell([h.instrument])}>Sell</button></li>)}</ul>
      <div className="ra-inline-actions"><button className="ra-primary" disabled={agent.busy} onClick={()=>void sell()}>Sell all</button>
        <small className="ra-caption">Creates a sale plan below. {held.wallet==='AGENTIC'?'Start it to let your agent sell within your Binance limits.':'You confirm each sale in your wallet.'}</small></div></>
      :<p className="ra-caption">This wallet holds none of this strategy&apos;s stock tokens.</p>)}
  </section>;
}
