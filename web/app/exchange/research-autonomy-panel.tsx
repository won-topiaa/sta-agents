'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {SolanaSignTransactionFeature} from '@solana/wallet-standard-features';
import type {AgentPlan} from '@/lib/research-agent-types';
import {wireBytes} from '@/lib/stock-trade-review';
import {sameTransactionMessage} from '@/lib/stock-order-state';
import {ensureSolanaSession} from './stocklana-exchange-client';
import './research-autonomy-panel.css';

type Execution={id:string;planId:string;phase:string;wallet:string;approvalHash:string;error:string|null;config:{buyBudgetAtoms:string;perBuyAtoms:string;maxOrders:string;expiresAt:string;maxSlippageBps:number};approvalSignature:string|null;policyAccount:string|null;preparedApproval?:{transactionBase64:string};legs:{instrument:string;inputAtoms:string;inputDecimals:number;side:'BUY'|'SELL';mint:string}[];orders:{id:string;index:number;instrument:string;phase:string;signature:string|null;devnetSignature:string|null;settlementSignature:string|null;receipt?:{side?:'BUY'|'SELL';inputAtoms?:string;outputAtoms?:string;mint?:string}}[];portfolio?:{cash:{symbol:string;atoms:string;decimals:number}[];holdings:{instrument:string;mint:string;atoms:string;rawDecimals:number}[];observedAt:string};portfolioUnavailable?:boolean};
const api='/api/v1/stocklana/research/autonomy';
const usd=(n:string)=>`$${(Number(n)/1e6).toLocaleString('en-US',{maximumFractionDigits:6})}`;
const titles:Record<string,string>={DRAFT:'Review your allocation',APPROVAL_PENDING:'Recording your approval',READY:'Ready to start',RUNNING:'Investing',COMPLETE:'Investment complete',ATTENTION:'Check execution',STOPPED:'Stopped'};
const steps:Record<string,string>={RESERVING:'Checking approval',PERMITTED:'Approved',SIGNING:'Signing',SIGNING_UNKNOWN:'Checking signature',SIGNED:'Signed',UNKNOWN:'Confirming trade',RECONCILED:'Settled',FAILED_FINALIZED:'Trade failed',EXPIRED_UNSIGNED:'Expired before signing',EXPIRED_NO_FILL:'Expired · no purchase'};
const issues:Record<string,string>={PREPARED_TRANSACTION_EXPIRED:'The quote expired before signing. No replacement was created.',SIGNED_TRANSACTION_EXPIRED:'The signed transaction expired. Check its receipt before trying a new allocation.',SIGNING_OUTCOME_UNKNOWN:'The signing response is still unknown. No second transaction will be signed.',DEVNET_CONFIRMATION_PENDING:'Waiting for the verification receipt.',EXECUTION_NEEDS_REVIEW:'Execution needs a check. Existing orders remain recorded.'};
export function ResearchAutonomyPanel({plan,wallet,onBound,onRefresh}:{plan:AgentPlan;wallet:string|null;onBound:()=>void;onRefresh:()=>void}){
 const [data,setData]=useState<Execution|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[expiry,setExpiry]=useState('');
 const identity=useRef(''),alive=useRef(true),flight=useRef(false),refreshing=useRef(false),bound=useRef(onBound),changed=useRef(onRefresh);identity.current=`${wallet}:${plan.id}`;bound.current=onBound;changed.current=onRefresh;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{setData(null);setError(null);},[wallet,plan.id]);
 const refresh=useCallback(async(holdings=false)=>{
  if(!wallet||refreshing.current)return;const key=`${wallet}:${plan.id}`;refreshing.current=true;
  try{const r=await fetch(`${api}?planId=${plan.id}${holdings?'&holdings=1':''}`,{cache:'no-store',headers:{'X-Skew-Expected-Requester':`solana:${wallet}`},signal:AbortSignal.timeout(25000)}),b=await r.json();if(!alive.current||identity.current!==key)return;if(r.ok&&b.execution.planId===plan.id){setData(old=>({...b.execution,portfolio:b.execution.portfolio??old?.portfolio}));bound.current();}else if(r.status!==404)setError(b.error?.message??'Check your wallet connection.');}catch{if(alive.current&&identity.current===key)setError('Connection interrupted. Your saved orders are unchanged.');}finally{refreshing.current=false;}
 },[wallet,plan.id]);
 useEffect(()=>{void refresh(true);},[refresh]);
 const polling=Boolean(data&&['APPROVAL_PENDING','RUNNING','ATTENTION'].includes(data.phase));
 useEffect(()=>{if(!polling)return;const t=setInterval(()=>{if(!document.hidden)void refresh(false);},4000);return()=>clearInterval(t);},[polling,refresh]);
 useEffect(()=>{if(data?.orders.some(o=>o.phase==='RECONCILED')){void refresh(true);changed.current();}},[data?.orders.filter(o=>o.phase==='RECONCILED').length,refresh]);
 async function request(operation:string,extra:Record<string,unknown>={}){
  if(!wallet)throw Error('Connect your personal wallet.');const r=await fetch(api,{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Skew-Expected-Requester':`solana:${wallet}`},body:JSON.stringify({operation,planId:plan.id,...extra}),signal:AbortSignal.timeout(90000)}),b=await r.json();if(!r.ok)throw Error(b.error?.message??'Request was not completed.');return b.execution as Execution;
 }
 async function act(operation:string){
  if(!wallet||flight.current)return;flight.current=true;setBusy(true);setError(null);const key=identity.current;
  try{
   await ensureSolanaSession(wallet);if(identity.current!==key)throw Error('The connected account changed.');let result:Execution;
   if(operation==='SIGN'){
    const prepared=await request('PREPARE_APPROVAL');if(identity.current!==key||!alive.current)throw Error('The selected strategy changed.');
    const {getWallets}=await import('@wallet-standard/app'),w=getWallets().get().find(w=>w.accounts.some(a=>a.address===wallet)),account=w?.accounts.find(a=>a.address===wallet),feature=w?.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction']|undefined;
    if(!account||!feature||!prepared.preparedApproval)throw Error('Reconnect your Solana wallet to approve.');
    const wire=wireBytes(prepared.preparedApproval.transactionBase64),outputs=await feature.signTransaction({account,transaction:wire,chain:'solana:devnet'});
    if(identity.current!==key||!alive.current)throw Error('Account changed. Nothing was sent.');
    if(outputs.length!==1||!sameTransactionMessage(wire,outputs[0].signedTransaction))throw Error('The approval changed. Nothing was sent.');
    const signedTransactionBase64=btoa(String.fromCharCode(...outputs[0].signedTransaction));
    // A signed approval can be resubmitted byte-for-byte after a browser/network interruption.
    sessionStorage.setItem(`xtxc-policy-approval:${wallet}:${plan.id}`,signedTransactionBase64);
    result=await request('SUBMIT_APPROVAL',{signedTransactionBase64});
   }else if(operation==='RECOVER'){
    const signedTransactionBase64=sessionStorage.getItem(`xtxc-policy-approval:${wallet}:${plan.id}`);if(!signedTransactionBase64)throw Error('No saved approval in this browser.');result=await request('SUBMIT_APPROVAL',{signedTransactionBase64});
   }else result=await request(operation,operation==='DRAFT'?{expiresAt:expiry?String(Math.floor(new Date(expiry).getTime()/1000)):'0'}:operation==='START'?{approvalHash:data?.approvalHash}:{});
   if(alive.current&&identity.current===key){setData(result);bound.current();void refresh(true);}
  }catch(e){if(alive.current&&identity.current===key)setError(e instanceof Error?e.message:'Request failed.');}
  finally{flight.current=false;if(alive.current)setBusy(false);}
 }
 if(plan.snapshot?.owner&&plan.snapshot.owner===wallet)return null;
 // An agent set to approve every trade never hands its plan to the agent wallet (the server enforces this too).
 if(plan.agent?.approval==='PER_TRADE'&&!data)return <p className="ap-note">{plan.agent.name} asks you to approve every trade. Sign each trade with your personal wallet below, or change the agent&apos;s approval setting to let it trade on its own.</p>;
 return <section className="ra-autonomy" aria-label="Agent investment">
  <header><div><h4>{data?titles[data.phase]??'Agent investment':'Let your agent execute'}</h4><p>{data?`${usd(data.config.buyBudgetAtoms)} in buys · ${data.config.maxOrders} trades`:'Approve the allocation once. Your agent handles its buys and sells.'}</p></div>{data&&<button className="ra-text" disabled={busy} onClick={()=>void refresh(true)}>Refresh</button>}</header>
  {!data?<><button className="ra-primary" disabled={busy||!wallet||plan.status!=='APPROVED'} onClick={()=>void act('DRAFT')}>{busy?'Connecting…':'Use agent wallet'}</button><details><summary>Execution period</summary><label>Optional end time<input type="datetime-local" value={expiry} onChange={e=>setExpiry(e.target.value)}/></label><small>Blank means until this allocation finishes or you stop it.</small></details></>:<>
   <div className="ra-auto-wallet"><span>Agent wallet</span><a href={`https://explorer.solana.com/address/${data.wallet}`} target="_blank" rel="noreferrer">{data.wallet.slice(0,6)}…{data.wallet.slice(-6)}</a><button className="ra-text" onClick={()=>void navigator.clipboard.writeText(data.wallet)}>Copy address</button></div>
   {data.portfolio&&<div className="ra-auto-balances">{data.portfolio.cash.map(c=><span key={c.symbol}>{(Number(c.atoms)/10**c.decimals).toLocaleString('en-US',{maximumFractionDigits:6})} {c.symbol}</span>)}</div>}
   {data.phase==='DRAFT'&&<><div className="ra-trade-legs">{data.legs.map((l,i)=><div key={`${l.mint}:${i}`}><span>{l.side} {l.instrument}</span><b>{l.side==='SELL'?`${(Number(l.inputAtoms)/10**l.inputDecimals).toLocaleString('en-US',{maximumFractionDigits:9})} tokens`:usd(l.inputAtoms)}</b></div>)}</div><p className="ra-caption">This wallet only. No changes to the approved stocks or amounts. {data.config.expiresAt==='0'?'Ends when complete or stopped.':`Ends ${new Date(Number(data.config.expiresAt)*1000).toLocaleString()}.`}</p><button className="ra-primary" disabled={busy} onClick={()=>void act('SIGN')}>{busy?'Waiting for wallet…':'Approve in wallet'}</button>{error&&<button className="ra-text" disabled={busy} onClick={()=>void act('RECOVER')}>Retry saved approval</button>}<small className="ra-auto-note">Approval is recorded on Solana devnet using test SOL. Trades use mainnet assets after you start.</small></>}
   {data.phase==='READY'&&<><p className="ra-caption">Keep {usd(plan.budgetScope==='NEW_CAPITAL'?data.config.buyBudgetAtoms:plan.budgetAtoms)} USDC plus SOL for fees in this wallet. Approved sales settle before purchases.</p><button className="ra-primary" disabled={busy} onClick={()=>void act('START')}>{busy?'Checking balance…':'Start approved allocation'}</button></>}
   <ol className="ra-auto-orders">{data.orders.map(o=><li key={o.id}><div><b>{data.legs[o.index]?.side} {o.instrument}</b><span>{steps[o.phase]??o.phase}</span></div>{o.receipt?.outputAtoms&&<small>{(()=>{if(o.receipt?.side==='SELL')return `${usd(o.receipt.outputAtoms!)} USDC received`;const h=data.portfolio?.holdings.find(h=>h.mint===o.receipt?.mint);return h?`${(Number(o.receipt!.outputAtoms)/10**h.rawDecimals).toLocaleString('en-US',{maximumFractionDigits:9})} tokens received`:`${o.receipt.outputAtoms} base units received`;})()}</small>}<nav>{o.devnetSignature&&<a href={`https://explorer.solana.com/tx/${o.devnetSignature}?cluster=devnet`} target="_blank" rel="noreferrer">Verification</a>}{o.signature&&<a href={`https://explorer.solana.com/tx/${o.signature}`} target="_blank" rel="noreferrer">Trade receipt</a>}{o.settlementSignature&&<a href={`https://explorer.solana.com/tx/${o.settlementSignature}?cluster=devnet`} target="_blank" rel="noreferrer">Result record</a>}</nav></li>)}</ol>
   {data.portfolio?.holdings.length? <details><summary>Agent holdings</summary><div className="ra-trade-legs">{data.portfolio.holdings.map(h=><div key={h.mint}><span>{h.instrument}</span><b>{(Number(h.atoms)/10**h.rawDecimals).toLocaleString('en-US',{maximumFractionDigits:9})}</b></div>)}</div></details>:null}
   {data.approvalSignature&&<a className="ra-text" href={`https://explorer.solana.com/tx/${data.approvalSignature}?cluster=devnet`} target="_blank" rel="noreferrer">Strategy approval record</a>}
   {!['STOPPED','COMPLETE'].includes(data.phase)&&<button className="ra-text" disabled={busy} onClick={()=>void act('STOP')}>Stop remaining trades</button>}
   {data.phase==='STOPPED'&&<p role="status">Completed trades remain in your wallet. You can research and approve a new allocation.</p>}
   {data.error&&data.phase==='ATTENTION'&&<p className="ra-error" role="status">{issues[data.error]??(data.error==='STOCKMESH_RECONCILIATION_PENDING'?'Updating the trade receipt before the next order.':data.error==='STOCKLANA_SUBMISSION_CONFLICT'?'Checking the previous order. No duplicate purchase will be made.':data.error)}</p>}
  </>}
  {error&&<p className="ra-error" role="alert">{error} {!data&&<a href="/exchange/agent-wallet">Connect agent wallet</a>}</p>}
 </section>;
}
