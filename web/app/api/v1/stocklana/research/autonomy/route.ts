import {requireRequesterSession,RequesterAuthError} from '@/lib/requester-auth';
import {stocklanaBody} from '@/lib/stocklana-execution';
import {AgentStore} from '@/lib/research-agent-core.mjs';
import {LISTED_STOCKS} from '@/lib/stock-listing-scope';
import {ResearchStoreError} from '@/lib/research-store.mjs';
import {autonomyRequest} from '@/lib/research-autonomy-transport';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, X-Skew-Expected-Requester'};
let store:AgentStore|undefined;
function db(){const path=process.env.XTXC_RESEARCH_DB;if(!path?.startsWith('/var/lib/xtxc-research/'))throw Error('EXECUTION_UNAVAILABLE');return store??=new AgentStore(path,LISTED_STOCKS);}
async function owner(r:Request){const s=await requireRequesterSession(r);if(s.agentKeyId||!s.address.startsWith('solana:'))throw new RequesterAuthError('OWNER_SESSION_REQUIRED','Sign in with your personal Solana wallet.',403);return s.address;}
const messages:Record<string,string>={DELEGATED_WALLET_NOT_CONNECTED:'Connect your agent wallet first.',PLAN_IDENTITY_MISMATCH:'The strategy version changed. Review it again.',CURRENT_APPROVED_PLAN_REQUIRED:'Review and approve a fresh allocation first.',PLAN_ALREADY_USED_OR_TOO_LARGE:'Use a fresh allocation for this agent wallet.',REVIEW_AGENT_WALLET_HOLDINGS:'Rebuild this allocation using your agent wallet holdings.',AGENT_WALLET_NEEDS_USDC:'Add the displayed USDC budget to your agent wallet, then start.',AGENT_WALLET_NEEDS_SOL:'Add SOL to your agent wallet for network fees and token account rent.',OWNER_APPROVAL_REQUIRED:'Confirm the strategy approval in your wallet first.',APPROVAL_CHANGED:'Reload the approved allocation before starting.',POLICY_STOPPED:'This approval has been stopped.',APPROVAL_NOT_PREPARED:'Prepare the approval again before signing.',QUOTE_ASSET_OR_SLIPPAGE_MISMATCH:'Refresh this stock allocation to use the current token route.'};
function failure(e:unknown){if(e instanceof RequesterAuthError||e instanceof ResearchStoreError)return Response.json({error:{message:e.message}},{status:e.status,headers});const code=e instanceof Error?e.message:'EXECUTION_UNAVAILABLE';return Response.json({error:{code,message:messages[code]??'Execution needs a fresh check. No replacement order was created.'}},{status:code==='APPROVAL_NOT_FOUND'?404:409,headers});}
export async function GET(r:Request){try{const address=await owner(r),q=new URL(r.url).searchParams,planId=q.get('planId')??'';db().plan(address,planId);const result=await autonomyRequest(address.slice(7),'STATUS',{id:planId,withHoldings:q.get('holdings')==='1'});db().syncAutonomy(address,planId,result.execution);return Response.json(result,{headers});}catch(e){return failure(e);}}
export async function POST(r:Request){try{
 const address=await owner(r),body=await stocklanaBody(r,5000) as Record<string,unknown>;
 if(Object.keys(body).some(k=>!['operation','planId','approvalHash','signedTransactionBase64','expiresAt','feeBudgetLamports'].includes(k))||typeof body.planId!=='string')throw Error('INVALID_REQUEST');
 const plan=db().plan(address,body.planId),rawOwner=address.slice(7);
 if(body.operation==='DRAFT'||body.operation==='START')db().assertAutonomyAllowed(address,plan);
 if(body.operation==='DRAFT'){
  const result=await autonomyRequest(rawOwner,'DRAFT',{plan,expiresAt:body.expiresAt??'0',feeBudgetLamports:body.feeBudgetLamports??null});
  const execution=result.execution as {id:string};
  db().claimAutonomy(address,plan.id,execution.id);return Response.json(result,{headers});
 }
 if(!['PREPARE_APPROVAL','SUBMIT_APPROVAL','START','STOP'].includes(String(body.operation)))throw Error('INVALID_REQUEST');
 const claim=db().db.prepare('SELECT policy_id FROM agent_autonomy_claims WHERE plan_id=?').get(plan.id);
 if(!claim)throw Error('OWNER_APPROVAL_REQUIRED');
 if(body.operation!=='STOP'&&!['APPROVED','PARTIAL'].includes(plan.status))throw Error('POLICY_STOPPED');
 return Response.json(await autonomyRequest(rawOwner,String(body.operation),{id:claim.policy_id,approvalHash:body.approvalHash,signedTransactionBase64:body.signedTransactionBase64}),{headers});
}catch(e){return failure(e);}}
