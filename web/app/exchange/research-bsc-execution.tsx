"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import type {AgentPlan} from '@/lib/research-agent-types';
import type {AgentController} from './research-agent-panel';
import {ensureResearchSession,researchPrincipalOf,evmProvider} from './research-session';
import {approvalText} from './research-agent-profile';

// BNB Smart Chain execution for an approved plan. Personal wallet: every approval and swap is a
// separate signature over a transaction the server already checked and dry-ran. Agentic Wallet:
// the agent runs the approved legs within the limits the owner set in the Binance app.
const usdt=(atoms:string)=>`${(Number(BigInt(atoms)/10n**12n)/1e6).toLocaleString('en-US',{maximumFractionDigits:2})} USDT`;
const phaseText:Record<string,string>={READY:'Ready',APPROVE_PREPARED:'Approval ready to sign',APPROVE_SENT:'Approval confirming',ALLOWANCE_READY:'Approved · swap next',
  SWAP_PREPARED:'Swap ready to sign',SUBMITTED:'Confirming on BNB Chain',RECONCILED:'Purchased',FAILED:'Reverted · nothing bought',UNKNOWN:'Needs a check',
  AGENTIC_SUBMITTING:'Agent ordering',AGENTIC_SUBMITTED:'Agent order pending'};
type Prepared={kind:'APPROVE'|'SWAP';tx:{from:string;to:string;data:string;value:string;gas:string;gasPrice?:string;minReceiveAmount?:string};quote?:{vendor:string;toTokenAmount:string;priceImpactPercent?:string}|null};

export function BscPlanExecution({plan,agent,onRefresh}:{plan:AgentPlan;agent:AgentController;wallet:string;onRefresh:()=>void}){
  const [busy,setBusy]=useState<number|null>(null),[error,setError]=useState<string|null>(null),[pending,setPending]=useState<Record<number,Prepared>>({});
  const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const stepOf=(i:number)=>plan.steps.find(s=>s.index===i);
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
  return <details open className="bsc-exec"><summary>Trade with your BNB Chain wallet</summary>
    <small>Each step is checked and dry-run on BNB Chain before your wallet asks you to sign. USDT approvals are for the exact amount only.</small>
    <div className="ra-trade-legs">{plan.legs.map((leg,i)=>{
      const step=stepOf(i),phase=step?.phase??'READY',p=pending[i],prevDone=i===0||stepOf(i-1)?.phase==='RECONCILED';
      const canPrepare=prevDone&&['READY','ALLOWANCE_READY','FAILED','APPROVE_PREPARED','SWAP_PREPARED'].includes(phase)&&['APPROVED','PARTIAL'].includes(plan.status);
      const receipt=(step as {receipts?:{hash:string;kind:string;status:string}[]}|undefined)?.receipts?.filter(r=>r.kind==='SWAP').at(-1);
      return <div key={i}><span><b>BUY {leg.instrument}</b><small>{usdt(leg.inputAtoms)} · {phaseText[phase]??phase}</small>
          {p&&<small>{p.kind==='APPROVE'?'Approve exactly this amount of USDT for the Binance router':`Swap via ${p.quote?.vendor??'route'} · dry run passed`}</small>}
          {receipt&&<a href={`https://bscscan.com/tx/${receipt.hash}`} target="_blank" rel="noreferrer">BscScan receipt</a>}</span>
        {phase==='RECONCILED'?<span>Purchased</span>:p?<button className="ra-primary" disabled={busy!==null} onClick={()=>void sign(i)}>{busy===i?'Waiting for wallet…':p.kind==='APPROVE'?'Sign approval':'Sign swap'}</button>
          :<button disabled={busy!==null||!canPrepare} onClick={()=>void prepare(i)}>{busy===i?'Checking…':phase==='ALLOWANCE_READY'?'Prepare swap':'Prepare'}</button>}
      </div>;})}</div>
    {(error||agent.error)&&<p className="ra-error" role="alert">{error??agent.error}</p>}
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
  if(plan.agent?.approval!=='AUTO_WITHIN_LIMITS')return <p className="ap-note">{plan.agent?`${plan.agent.name}: ${approvalText.PER_TRADE.toLowerCase()}.`:'This plan has no agent.'} Sign each trade with your wallet below{plan.agent?', or let the agent trade on its own within limits in its settings':''}.</p>;
  return <section className="ra-autonomy" aria-label="Agentic Wallet">
    <header><div><h4>{run?`Agent ${run.status.toLowerCase()}`:'Let your agent trade within limits'}</h4><p>Binance Agentic Wallet · Binance enforces the limits you set in its app.</p></div></header>
    <AgenticConnect agentic={agentic}/>
    {agentic.connected&&<>
      <p className="ra-caption">This plan buys {usdt((BigInt(plan.budgetAtoms)-BigInt(plan.cashAtoms)).toString())} in {plan.legs.length} orders, one at a time.</p>
      {!run&&<button className="ra-primary" disabled={agentic.busy||plan.status!=='APPROVED'} onClick={()=>void agentic.post({operation:'START',planId:plan.id})}>Start agent</button>}
      {run?.status==='RUNNING'&&<button className="ra-text" disabled={agentic.busy} onClick={()=>void agentic.post({operation:'STOP',planId:plan.id})}>Stop remaining trades</button>}
      {run&&run.status!=='RUNNING'&&run.reason&&<p className="ra-caption">{run.reason}</p>}
    </>}
  </section>;
}
