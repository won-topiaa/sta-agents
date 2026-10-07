import {requireRequesterSession,RequesterAuthError} from '@/lib/requester-auth';
import {researchPrincipal,allowedStocksFor,isBscPrincipal} from '@/lib/research-principal';
import {AgentStore,reject} from '@/lib/research-agent-core.mjs';
import {ResearchStoreError} from '@/lib/research-store.mjs';
import {defaultGoal} from '@/lib/research-agent-types';
import {CATALOGS,interpretResearch,intakeContext} from '@/lib/research-intake.mjs';
import {stocklanaBody} from '@/lib/stocklana-execution';
import {readFile,stat} from 'node:fs/promises';
import {readyResearchDraft} from '@/lib/research-data-availability.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, X-Skew-Expected-Requester'};
const stores=new Map<string,AgentStore>();
export async function POST(request:Request){
 try{
  const session={address:researchPrincipal(await requireRequesterSession(request))},LISTED_STOCKS=allowedStocksFor(session.address),chain=isBscPrincipal(session.address)?'bsc':'solana';
  const path=process.env.XTXC_RESEARCH_DB;if(!path?.startsWith('/var/lib/xtxc-research/')&&!path?.startsWith('/srv/xtxc-operations/research-test/'))reject('Research storage is unavailable.',503);
  let s0=stores.get(chain);if(!s0){s0=new AgentStore(path,LISTED_STOCKS);stores.set(chain,s0);}const s=s0,b=await stocklanaBody(request,18000) as {text:string;strategyId?:string;draft?:unknown;stocks?:string[]};
  // A supplied draft grants no execution rights; any saved strategy still
  // requires the authenticated owner's lookup even when draft context exists.
  const saved=b.strategyId?{brief:s.get(s.owner(session.address),b.strategyId),goal:s.view(session.address,b.strategyId).runs[0]?.goal??defaultGoal()}:null;
  const context=b.draft?intakeContext(b.draft,LISTED_STOCKS):saved;
  if(b.stocks!==undefined&&(!Array.isArray(b.stocks)||b.stocks.length>16||b.stocks.some(x=>!new Set<string>(LISTED_STOCKS).has(x))))reject('Choose supported stocks.');
  // Account-bound rate admission is durable. It never creates an execution approval.
  s.db.exec('CREATE TABLE IF NOT EXISTS research_intake_rate(owner TEXT PRIMARY KEY, window INTEGER NOT NULL, requests INTEGER NOT NULL)');
  const owner=s.owner(session.address),window=Math.floor(Date.now()/3600000);
  s.transaction(()=>{const r=s.db.prepare('SELECT * FROM research_intake_rate WHERE owner=?').get(owner);if(r?.window===window&&Number(r.requests)>=20)reject('Too many interpretation requests. Try again later.',429);s.db.prepare('INSERT INTO research_intake_rate VALUES(?,?,1) ON CONFLICT(owner) DO UPDATE SET window=excluded.window,requests=CASE WHEN window=excluded.window THEN requests+1 ELSE 1 END').run(owner,window);});
  let draft=await interpretResearch(b.text,LISTED_STOCKS,context,process.env,s,fetch,b.stocks??[],CATALOGS[chain]);
  if(draft.universeSource==='STARTER_RESEARCH'){
   const manifest=(process.env.XTXC_RESEARCH_DATA_ROOT??'/var/lib/xtxc-research/data')+'/prices/quant_release.json';
   if((await stat(manifest)).size>2_000_000)reject('Research data is being refreshed.',503);
   draft=readyResearchDraft(draft,JSON.parse(await readFile(manifest,'utf8')));
  }
  return Response.json({draft},{headers});
 }catch(e){if(e instanceof RequesterAuthError||e instanceof ResearchStoreError)return Response.json({error:{message:e.message}},{status:e.status,headers});return Response.json({error:{message:'Could not read the research request.'}},{status:503,headers});}
}
