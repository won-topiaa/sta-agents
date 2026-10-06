"use client";
import {useEffect,useRef,useState} from 'react';
import type {SolanaSignTransactionFeature} from '@solana/wallet-standard-features';
import type {AnchorRow} from '@/lib/research-anchor.mjs';
import {wireBytes} from '@/lib/stock-trade-review';
import {sameTransactionMessage} from '@/lib/stock-order-state';
import {ensureSolanaSession} from './stocklana-exchange-client';
const endpoint='/api/v1/stocklana/research/anchor';
export function ResearchAnchor({wallet,planId}:{wallet:string|null;planId:string}){
 const [record,setRecord]=useState<AnchorRow|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[canRetry,setCanRetry]=useState(false);
 const context=useRef(''),live=useRef(true),flight=useRef(false);context.current=`${wallet}:${planId}`;
 const storageKey=`xtxc.devnet-approval:${wallet}:${planId}`;
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 useEffect(()=>{const abort=new AbortController(),key=context.current;setRecord(null);setError(null);if(wallet)void fetch(`${endpoint}?planId=${planId}`,{cache:'no-store',headers:{'X-Skew-Expected-Requester':`solana:${wallet}`},signal:abort.signal}).then(r=>r.ok?r.json():null).then(b=>{if(key===context.current&&live.current)setRecord(b?.records?.[0]??null);}).catch(()=>{});try{setCanRetry(Boolean(sessionStorage.getItem(storageKey)));}catch{setCanRetry(false);}return()=>abort.abort();},[wallet,planId,storageKey]);
 async function request(body:Record<string,unknown>){const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Skew-Expected-Requester':`solana:${wallet}`},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)}),b=await r.json();if(!r.ok)throw Error(b.error?.message??'Approval record is unavailable.');return b.record as AnchorRow;}
 async function run(mode:'SIGN'|'CHECK'|'RETRY'){
  if(!wallet||flight.current)return;flight.current=true;setBusy(true);setError(null);const key=context.current;
  try{await ensureSolanaSession(wallet);if(key!==context.current)throw Error('The selected account changed.');let next:AnchorRow;
   if(mode==='CHECK'){if(!record)return;next=await request({operation:'CHECK',anchorId:record.id});}
   else if(mode==='RETRY'){
    const saved=JSON.parse(sessionStorage.getItem(storageKey)??'null');if(!saved||saved.owner!==wallet||saved.planId!==planId)throw Error('No signed devnet record is saved.');
    next=await request({operation:'SUBMIT',anchorId:saved.anchorId,signedTransactionBase64:saved.wire});
   }else{
    next=await request({operation:'PREPARE',planId});if(key!==context.current||!live.current)return;setRecord(next);
    if(next.phase!=='PREPARED')return;
    if(BigInt(next.shortfallLamports)>0n)throw Error(`This address needs ${(Number(next.shortfallLamports)/1e9).toFixed(6)} devnet SOL. Mainnet SOL is not used.`);
    const {getWallets}=await import('@wallet-standard/app'),w=getWallets().get().find(w=>w.accounts.some(a=>a.address===wallet)),account=w?.accounts.find(a=>a.address===wallet),feature=w?.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction']|undefined;
    if(!account||!feature||!feature.supportedTransactionVersions.includes('legacy'))throw Error('Connect a wallet supporting Solana devnet records.');
    const out=await feature.signTransaction({account,transaction:wireBytes(next.transactionBase64),chain:'solana:devnet'});
    if(out.length!==1||!sameTransactionMessage(wireBytes(next.transactionBase64),out[0].signedTransaction))throw Error('The wallet changed the approval record. Nothing was sent.');
    const wire=btoa(String.fromCharCode(...out[0].signedTransaction));sessionStorage.setItem(storageKey,JSON.stringify({owner:wallet,planId,anchorId:next.id,wire}));setCanRetry(true);
    if(key!==context.current||!live.current)throw Error('Account changed. The signed devnet record is saved, not sent.');
    next=await request({operation:'SUBMIT',anchorId:next.id,signedTransactionBase64:wire});
   }
   if(key===context.current&&live.current){setRecord(next);if(['CONFIRMED','FINALIZED','FAILED'].includes(next.phase)){sessionStorage.removeItem(storageKey);setCanRetry(false);}}
  }catch(e){if(key===context.current&&live.current)setError(e instanceof Error?e.message:'Record request failed.');}
  finally{flight.current=false;if(live.current)setBusy(false);}
 }
 return <section className="ra-anchor" aria-label="Approval record"><div><b>Approval record</b><small>Solana devnet · public plan hash, not a purchase</small></div>
 {record?.receipt?<a href={record.receipt.explorerUrl} target="_blank" rel="noreferrer">{record.phase==='FINALIZED'?'Finalized':'Confirmed'} · View record</a>:<div className="ra-inline-actions">
 {record&&!['EXPIRED_UNSENT','FAILED'].includes(record.phase)&&<button disabled={busy} onClick={()=>void run('CHECK')}>Check record</button>}
 {canRetry&&<button disabled={busy} onClick={()=>void run('RETRY')}>Retry signed record</button>}
 {(!record||['PREPARED','EXPIRED_UNSENT','FAILED'].includes(record.phase))&&<button disabled={busy||!wallet} onClick={()=>void run('SIGN')}>{busy?'Waiting…':'Record on devnet'}</button>}
 </div>}
 {record?.signature&&!record.receipt&&<a href={`https://explorer.solana.com/tx/${record.signature}?cluster=devnet`} target="_blank" rel="noreferrer">{record.phase} · Devnet transaction</a>}
 {error&&<p className="ra-error" role="alert">{error}</p>}
 </section>;
}
