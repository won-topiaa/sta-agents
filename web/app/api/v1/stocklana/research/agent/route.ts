import { requireRequesterSession, RequesterAuthError } from '@/lib/requester-auth';
import { researchPrincipal, allowedStocksFor, isBscPrincipal, bscWallet } from '@/lib/research-principal';
import { gateway } from '@/lib/bnb-gateway';
import { checkSent } from '@/lib/bsc-execution.mjs';
import { bscProduct } from '@/lib/bsc-research-universe.mjs';
import { BSC_USDT } from '@/lib/binance-web3.mjs';
import { AgentStore, reject } from '@/lib/research-agent-core.mjs';
import { ResearchStoreError } from '@/lib/research-store.mjs';
import { stocklanaBody, stocklanaQuote, stocklanaPrepare, stocklanaSubmit, stocklanaOrders, stocklanaPortfolio } from '@/lib/stocklana-execution';
import { atomsDecimal, rebalanceAllocation, assertStepFunds, selectedSnapshot } from '@/lib/research-rebalance.mjs';
import { ServiceExchangeError } from '@/lib/service-exchange/errors';
import {autonomyRequest} from '@/lib/research-autonomy-transport';
import {walletConnectionRequest} from '@/lib/research-wallet-transport';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, X-Skew-Expected-Requester'};
const stores=new Map<string,AgentStore>();
function db(address:string){const path=process.env.XTXC_RESEARCH_DB;if(!path?.startsWith('/var/lib/xtxc-research/')&&!path?.startsWith('/srv/xtxc-operations/research-test/'))reject('Research storage is unavailable.',503);
  const chain=isBscPrincipal(address)?'bsc':'solana';let s=stores.get(chain);if(!s){s=new AgentStore(path,allowedStocksFor(address));stores.set(chain,s);}return s;}
async function owner(request:Request){return researchPrincipal(await requireRequesterSession(request));}
function failure(e:unknown){if(e instanceof RequesterAuthError||e instanceof ResearchStoreError||e instanceof ServiceExchangeError)return Response.json({error:{message:e.message}},{status:e.status,headers});return Response.json({error:{message:'Research is temporarily unavailable. Your saved work is unchanged.'}},{status:503,headers});}
export async function GET(request:Request){try{const address=await owner(request),q=new URL(request.url).searchParams;return Response.json(db(address).view(address,q.get('id')??'',Number(q.get('after')??0)),{headers});}catch(e){return failure(e);}}
const str=(v:unknown)=>typeof v==='string'?v:reject('Invalid research request.');
const index=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0?Number(v):reject('Invalid trade step.');
const decimal=(a:string)=>{const n=BigInt(a);return`${n/1000000n}.${(n%1000000n).toString().padStart(6,'0')}`;};

export async function POST(request:Request){
  try{
    const address=await owner(request),b=await stocklanaBody(request,12000) as Record<string,unknown>,s=db(address);
    if(!b||typeof b!=='object')reject('Invalid research request.');
    const bsc=isBscPrincipal(address);
    if(bsc&&['REVIEW_REBALANCE','PREPARE','SUBMIT','CHECK'].includes(String(b.operation)))reject('Use the BNB Chain trade steps for this plan.',409);
    if(b.operation==='BSC_PREPARE'||b.operation==='BSC_SENT'||b.operation==='BSC_CHECK'){
      if(!bsc)reject('BNB Chain trade steps need a BNB Chain wallet session.',409);
      const id=str(b.planId),i=index(b.index),user=bscWallet(address);
      if(b.operation==='BSC_PREPARE'){
        const {pending}=await gateway<{pending:string}>('GET',`/v1/nonce?address=${user}`);
        const {plan}=s.assertBscPreparable(address,id,i,pending),leg=plan.legs[i],product=bscProduct(leg.instrument);
        if(!product)reject(`${leg.instrument} is not tradable on BNB Chain.`,409);
        if(leg.side&&leg.side!=='BUY')reject('Only purchases are available on BNB Chain yet.',409);
        const slippage=b.slippagePercent==null?'1':String(b.slippagePercent);
        const prepared=await gateway<{step:'APPROVE'|'SWAP';tx:Record<string,string>;quote?:unknown;simulation?:unknown}>('POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:product.contract,amount:leg.inputAtoms,slippagePercent:slippage},60000);
        return Response.json({prepared:s.bscPrepared(address,id,i,prepared.step,prepared,pending),product},{headers});
      }
      const step=s.bscStep(address,id,i);
      if(b.operation==='BSC_SENT'){
        const hash=str(b.txHash);if(!/^0x[0-9a-fA-F]{64}$/.test(hash))reject('Invalid transaction hash.');
        if(!step.doc.prepared)reject('No prepared transaction for this step.',409);
        const observed=await gateway<{tx:{from:string;to:string;input:string;value:string}|null;receipt:{status:string}|null}>('GET',`/v1/tx?hash=${hash}`);
        try{checkSent(observed.tx,step.doc.prepared.tx);}catch(e){reject(e instanceof Error?e.message:'Transaction mismatch.',409);}
        s.bscSent(address,id,i,hash);
        return Response.json({step:s.bscReceipt(address,id,i,observed.receipt)},{headers});
      }
      if(!step.doc.sent)return Response.json({step:step.doc,phase:step.phase},{headers});
      const observed=await gateway<{receipt:{status:string;blockNumber:number}|null}>('GET',`/v1/tx?hash=${step.doc.sent.hash}`);
      return Response.json({step:s.bscReceipt(address,id,i,observed.receipt)},{headers});
    }
    if(b.operation==='RUN'){const runId=s.enqueue(address,str(b.strategyId),b.goal,str(b.requestId));return Response.json({runId},{headers});}
    if(b.operation==='CANCEL'){s.cancel(address,str(b.runId));return Response.json({cancelled:true},{headers});}
    if(b.operation==='REVIEW_REBALANCE'){
      const runId=str(b.runId),candidateId=str(b.candidateId),reportHash=str(b.reportHash),{strategy,candidate}=s.reviewCandidate(address,runId,candidateId,reportHash);
      if(b.walletScope!=null&&!['PERSONAL','AGENT_WALLET'].includes(String(b.walletScope)))reject('Choose an execution wallet.');
      let executionWallet=address.slice(7);
      if(b.walletScope==='AGENT_WALLET'){
        const response=await walletConnectionRequest(executionWallet,'VERIFY');
        const binding=response.binding as {owner?:string;address?:string}|undefined;
        if(binding?.owner!==executionWallet||!binding?.address)reject('Connect your agent wallet before reviewing its holdings.',409);
        executionWallet=binding.address;
      }
      const portfolio=await stocklanaPortfolio({owner:executionWallet});
      const allocation=await rebalanceAllocation(strategy,candidate,portfolio,stocklanaQuote);
      const refreshed=selectedSnapshot(await stocklanaPortfolio({owner:executionWallet}),executionWallet,strategy.instruments);
      if(refreshed.balanceHash!==allocation.snapshot.balanceHash)reject('Holdings changed during review. Refresh the allocation.',409);
      return Response.json({draft:s.saveRebalanceDraft(address,runId,candidateId,reportHash,allocation)},{headers});
    }
    if(b.operation==='APPROVE'){
      // Independent strategy approvals never wait on another strategy's orders.
      const plan=await s.approveReplacingUnused(address,str(b.runId),str(b.candidateId),str(b.reportHash),b.draftId==null?null:str(b.draftId),async(rawOwner:string,id:string)=>{
        try{return (await autonomyRequest(rawOwner,'DISCARD_UNSIGNED_DRAFT',{id})).execution;}
        catch{reject('The previous wallet approval is already signed or active. Stop it before approving another plan.',409);}
      });
      return Response.json({plan},{headers});
    }
    if(b.operation==='MONITOR')return Response.json({monitor:s.monitor(address,str(b.strategyId),b.goal,b.enabled===true)},{headers});
    if(b.operation==='REVOKE'){const id=str(b.planId);s.plan(address,id);const claim=s.db.prepare('SELECT policy_id FROM agent_autonomy_claims WHERE plan_id=?').get(id);if(claim)await autonomyRequest(address.slice(7),'STOP',{id:claim.policy_id});s.revoke(address,id);return Response.json({revoked:true},{headers});}
    if(b.operation==='PREPARE'){
      const id=str(b.planId),i=index(b.index),r=s.reserveStep(address,id,i);
      if(r.existing)return Response.json({prepared:r.existing},{headers});
      const leg=r.plan.legs[i];
      // The approved integer allocation, not arbitrary client amounts, enters StockMesh.
      try{
        const portfolio=await stocklanaPortfolio({owner:address.slice(7)});assertStepFunds(r.plan,i,portfolio);
        const quote=await stocklanaQuote(leg.side==='SELL'?{instrument:leg.instrument,side:'SELL',notional:atomsDecimal(leg.inputAtoms,leg.inputDecimals),productMint:leg.productMint,notionalAsset:'USDC',maxSlippageBps:r.plan.maxSlippageBps}:{instrument:leg.instrument,side:'BUY',notional:decimal(leg.inputAtoms),notionalAsset:'USDC',maxSlippageBps:r.plan.maxSlippageBps});
        const prepared=await stocklanaPrepare({owner:address.slice(7),quoteId:quote.quoteId},address);
        s.bindPrepared(address,id,i,prepared,quote);
        return Response.json({prepared},{headers});
      }catch(e){s.releaseUnsignedPreparation(address,id,i);throw e;}
    }
    if(b.operation==='SUBMIT'){
      const id=str(b.planId),i=index(b.index),r=s.authorizeSubmit(address,id,i);
      const signedTransactionBase64=str(b.signedTransactionBase64);
      if(signedTransactionBase64.length>2000)reject('Invalid signed transaction.');
      // Mark ambiguous BEFORE the network call. Timeouts never create replacement orders.
      s.recordStep(address,id,i,'UNKNOWN');
      const result=await stocklanaSubmit({owner:address.slice(7),preparedId:r.prepared.preparedId,quoteId:r.prepared.quoteId,signedTransactionBase64},address);
      s.recordStep(address,id,i,result.phase,result);
      return Response.json({submission:result},{headers});
    }
    if(b.operation==='CHECK'){
      const id=str(b.planId),i=index(b.index),r=s.step(address,id,i);
      if(!r.prepared)reject('No transaction has been prepared for this step.',409);
      const result=await stocklanaOrders({owner:address.slice(7),preparedId:r.prepared.preparedId},address);
      const observed=result.orders.find(o=>o.preparedId===r.prepared.preparedId);
      if(observed)s.recordStep(address,id,i,observed.phase,observed);
      return Response.json({order:observed??null},{headers});
    }
    reject('Unknown research operation.');
  }catch(e){return failure(e);}
}
