import {requireRequesterSession,RequesterAuthError} from '@/lib/requester-auth';
import {researchPrincipal,allowedStocksFor,isBscPrincipal} from '@/lib/research-principal';
import {AgentStore,reject} from '@/lib/research-agent-core.mjs';
import {ResearchStoreError} from '@/lib/research-store.mjs';
import {agenticBinding,bindAgentic,startAgentic,stopAgentic,agenticRun,quotaLeftOf} from '@/lib/research-agentic.mjs';
import {gateway} from '@/lib/bnb-gateway';
import {stocklanaBody} from '@/lib/stocklana-execution';

// Binance Agentic Wallet for agents that trade on their own within limits. Sign-in is a QR scan in
// the Binance app; limits (daily USD quota, token scope) are set there and enforced by Binance.
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, X-Skew-Expected-Requester'};
let store:AgentStore|undefined;
function db(address:string){const path=process.env.XTXC_RESEARCH_DB;if(!path?.startsWith('/var/lib/xtxc-research/')&&!path?.startsWith('/srv/xtxc-operations/research-test/'))reject('Research storage is unavailable.',503);return store??=new AgentStore(path,allowedStocksFor(address));}
async function owner(request:Request){const a=researchPrincipal(await requireRequesterSession(request));if(!isBscPrincipal(a))reject('The Agentic Wallet is for BNB Chain accounts.',403);return a;}
function failure(e:unknown){if(e instanceof RequesterAuthError||e instanceof ResearchStoreError)return Response.json({error:{message:e.message}},{status:e.status,headers});return Response.json({error:{message:'Agentic Wallet is temporarily unavailable.'}},{status:503,headers});}
type Quota={quotaLeft?:string|number;quotaUsed?:string|number;dailyLimit?:string|number};

export async function GET(request:Request){
  try{
    const address=await owner(request),s=db(address),binding=agenticBinding(s),mine=binding?.owner===s.owner(address);
    const status=await gateway<{status:string}>('GET','/v1/agentic/status');
    const connected=Boolean(status?.status&&status.status!=='UNCONNECTED');
    const [settings,quota]=connected&&mine?await Promise.all([gateway('GET','/v1/agentic/settings'),gateway<Quota>('GET','/v1/agentic/quota')]):[null,null];
    const planId=new URL(request.url).searchParams.get('planId');
    return Response.json({status:status?.status??'UNKNOWN',bound:binding?{mine,address:mine?binding.address:null}:null,settings,quota,run:planId&&mine?agenticRun(s,planId):null},{headers});
  }catch(e){return failure(e);}
}
export async function POST(request:Request){
  try{
    const address=await owner(request),s=db(address),b=await stocklanaBody(request,4000) as Record<string,unknown>;
    const binding=agenticBinding(s);
    if(binding&&binding.owner!==s.owner(address))reject('This Agentic Wallet is connected to another account.',409);
    // One gateway drives one Agentic Wallet. When XTXC_AGENTIC_OWNER names the operator's BNB Chain address, only that
    // account may sign it in and bind it.
    const operator=process.env.XTXC_AGENTIC_OWNER;
    if(operator&&!binding&&address.toLowerCase()!==`eip155:56:${operator.toLowerCase()}`)reject('The Agentic Wallet is reserved for the operator account.',403);
    if(b.operation==='SIGNIN')return Response.json({signin:await gateway('POST','/v1/agentic/signin',{})},{headers});
    if(b.operation==='VERIFY'){
      await gateway('POST','/v1/agentic/verify',{qrCodeId:String(b.qrCodeId??'')},330000);
      const a=await gateway<{address?:string;evmAddress?:string;addresses?:{address:string;binanceChainId?:string}[]}>('GET','/v1/agentic/address');
      const wallet=a?.address??a?.evmAddress??a?.addresses?.find(x=>!x.binanceChainId||x.binanceChainId==='56')?.address;
      return Response.json({binding:bindAgentic(s,address,wallet)},{headers});
    }
    const planId=String(b.planId??'');
    if(b.operation==='START'){
      const quota=await gateway<Quota>('GET','/v1/agentic/quota');
      return Response.json({run:startAgentic(s,address,planId,quotaLeftOf(quota))},{headers});
    }
    if(b.operation==='STOP')return Response.json({run:stopAgentic(s,address,planId)},{headers});
    reject('Unknown Agentic Wallet operation.');
  }catch(e){return failure(e);}
}
