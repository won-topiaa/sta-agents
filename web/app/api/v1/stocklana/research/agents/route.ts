import {requireRequesterSession,RequesterAuthError} from '@/lib/requester-auth';
import {researchPrincipal,allowedStocksFor,isBscPrincipal} from '@/lib/research-principal';
import {AgentStore,reject} from '@/lib/research-agent-core.mjs';
import {ResearchStoreError} from '@/lib/research-store.mjs';
import {AGENT_RULES} from '@/lib/agent-rules.mjs';
import {suggestRules} from '@/lib/research-agent-suggest.mjs';
import {stocklanaBody} from '@/lib/stocklana-execution';

// The owner's own agents. Saving an agent changes only how research is designed;
// it never grants execution authority (approvals and signing stay separate).
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, X-Skew-Expected-Requester'};
const stores=new Map<string,AgentStore>();
function db(address:string){const path=process.env.XTXC_RESEARCH_DB;if(!path?.startsWith('/var/lib/xtxc-research/')&&!path?.startsWith('/srv/xtxc-operations/research-test/'))reject('Research storage is unavailable.',503);const chain=isBscPrincipal(address)?'bsc':'solana';let s=stores.get(chain);if(!s){s=new AgentStore(path,allowedStocksFor(address));stores.set(chain,s);}return s;}
async function owner(request:Request){return researchPrincipal(await requireRequesterSession(request));}
function failure(e:unknown){if(e instanceof RequesterAuthError||e instanceof ResearchStoreError)return Response.json({error:{message:e.message}},{status:e.status,headers});return Response.json({error:{message:'Agents are temporarily unavailable. Your saved agents are unchanged.'}},{status:503,headers});}

export async function GET(request:Request){
  try{const address=await owner(request);return Response.json({owner:address,agents:db(address).agents(address),catalog:AGENT_RULES},{headers});}
  catch(e){return failure(e);}
}
export async function POST(request:Request){
  try{
    const address=await owner(request),b=await stocklanaBody(request,12000) as Record<string,unknown>,s=db(address);
    if(!b||typeof b!=='object')reject('Invalid agent request.');
    if(b.operation==='SUGGEST_RULES'){
      // Same durable per-owner admission as research interpretation.
      s.db.exec('CREATE TABLE IF NOT EXISTS agent_suggest_rate(owner TEXT PRIMARY KEY, window INTEGER NOT NULL, requests INTEGER NOT NULL)');
      const o=s.owner(address),window=Math.floor(Date.now()/3600000);
      s.transaction(()=>{const r=s.db.prepare('SELECT * FROM agent_suggest_rate WHERE owner=?').get(o) as {window:number;requests:number}|undefined;if(r?.window===window&&Number(r.requests)>=20)reject('Too many suggestion requests. Try again later.',429);s.db.prepare('INSERT INTO agent_suggest_rate VALUES(?,?,1) ON CONFLICT(owner) DO UPDATE SET window=excluded.window,requests=CASE WHEN window=excluded.window THEN requests+1 ELSE 1 END').run(o,window);});
      return Response.json(await suggestRules(String(b.text??''),String(b.style??''),process.env,s,fetch),{headers});
    }
    if(b.operation!=='CREATE'&&b.operation!=='UPDATE')reject('Unknown agent operation.');
    const agent=s.saveAgent(address,b);
    return Response.json({owner:address,agent,agents:s.agents(address)},{headers});
  }catch(e){return failure(e);}
}
