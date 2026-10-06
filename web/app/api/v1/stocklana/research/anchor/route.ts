import { requireRequesterSession, RequesterAuthError } from '@/lib/requester-auth';
import { LISTED_STOCKS } from '@/lib/stock-listing-scope';
import { AgentStore, reject } from '@/lib/research-agent-core.mjs';
import { AnchorService } from '@/lib/research-anchor.mjs';
import { ResearchStoreError } from '@/lib/research-store.mjs';
import { stocklanaBody } from '@/lib/stocklana-execution';
import { ServiceExchangeError } from '@/lib/service-exchange/errors';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, X-Skew-Expected-Requester'};
let anchors:AnchorService|undefined;
function service(){const path=process.env.XTXC_RESEARCH_DB;if(!path?.startsWith('/var/lib/xtxc-research/')&&!path?.startsWith('/srv/xtxc-operations/research-test/'))reject('Research storage unavailable.',503);return anchors??=new AnchorService(new AgentStore(path,LISTED_STOCKS));}
async function owner(request:Request){const s=await requireRequesterSession(request);if(s.agentKeyId||!s.address.startsWith('solana:'))throw new RequesterAuthError('RESEARCH_SESSION_REQUIRED','Sign in with your Solana wallet.',403);return s.address;}
function failure(e:unknown){if(e instanceof RequesterAuthError||e instanceof ResearchStoreError||e instanceof ServiceExchangeError)return Response.json({error:{message:e.message}},{status:e.status,headers});return Response.json({error:{message:'The devnet record could not be checked. No trading authority changed.'}},{status:503,headers});}
const text=(x:unknown)=>typeof x==='string'&&x.length<=1800?x:reject('Invalid approval request.');
export async function GET(request:Request){try{const address=await owner(request),planId=new URL(request.url).searchParams.get('planId');return Response.json({records:service().list(address,text(planId))},{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const address=await owner(request),b=await stocklanaBody(request,4000) as Record<string,unknown>;let record;
 if(b.operation==='PREPARE')record=await service().prepare(address,text(b.planId));
 else if(b.operation==='SUBMIT')record=await service().submit(address,text(b.anchorId),text(b.signedTransactionBase64));
 else if(b.operation==='CHECK')record=await service().status(address,text(b.anchorId));
 else reject('Unknown approval operation.');
 return Response.json({record},{headers});
}catch(e){return failure(e);}}
