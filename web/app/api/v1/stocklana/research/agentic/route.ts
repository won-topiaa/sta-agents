import {requireRequesterSession,RequesterAuthError} from '@/lib/requester-auth';
import {researchPrincipal,allowedStocksFor,isBscPrincipal} from '@/lib/research-principal';
import {AgentStore,reject} from '@/lib/research-agent-core.mjs';
import {ResearchStoreError} from '@/lib/research-store.mjs';
import {agenticBinding,bindAgentic,startAgentic,stopAgentic,agenticRun,quotaLeftOf,agenticWalletOf,assertAgenticIdle} from '@/lib/research-agentic.mjs';
import {agenticOperatorGate} from '@/lib/research-agentic-operator.mjs';
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
    if(!b||typeof b!=='object')reject('Invalid Agentic Wallet request.');
    const planId=String(b.planId??'');
    // Stopping is scoped to the plan's owner and only ends trading, so it never needs the wallet.
    if(b.operation==='STOP')return Response.json({run:stopAgentic(s,address,planId)},{headers});
    // Signing in, binding and starting are for the operator named by XTXC_AGENTIC_OWNER only (fail closed when unset).
    agenticOperatorGate(address,String(b.operation));
    const binding=agenticBinding(s);
    if(binding&&binding.owner!==s.owner(address))reject('This Agentic Wallet is connected to another account.',409);
    const bindSignedIn=async()=>bindAgentic(s,address,agenticWalletOf(await gateway('GET','/v1/agentic/address')));
    if(b.operation==='SIGNIN'){
      const signin=await gateway<{qrCodeId?:string;status?:string}>('POST','/v1/agentic/signin',{});
      if(signin?.qrCodeId)return Response.json({signin},{headers});
      // The CLI is still signed in, so there is no QR to scan: bind the wallet it is signed in to.
      if(/ALREADY_CONNECTED/i.test(String(signin?.status??'')))return Response.json({binding:await bindSignedIn()},{headers});
      reject('Binance did not start a sign-in. Try again.',502);
    }
    // Renews the CLI session before it lapses: sign out, then a fresh QR sign-in that VERIFY completes as usual.
    if(b.operation==='RENEW'){
      if(binding?.owner!==s.owner(address))reject('Connect the Agentic Wallet first.',409);
      assertAgenticIdle(s);
      await gateway('POST','/v1/agentic/signout',{});
      const signin=await gateway<{qrCodeId?:string}>('POST','/v1/agentic/signin',{});
      if(!signin?.qrCodeId)reject('Binance did not start a new sign-in. Try again.',502);
      return Response.json({signin},{headers});
    }
    if(b.operation==='VERIFY'){
      const qrCodeId=String(b.qrCodeId??'');
      if(!qrCodeId)reject('Start the sign-in again to get a new QR code.',409);
      await gateway('POST','/v1/agentic/verify',{qrCodeId},330000);
      return Response.json({binding:await bindSignedIn()},{headers});
    }
    if(b.operation==='START'){
      const quota=await gateway<Quota>('GET','/v1/agentic/quota');
      return Response.json({run:startAgentic(s,address,planId,quotaLeftOf(quota))},{headers});
    }
    reject('Unknown Agentic Wallet operation.');
  }catch(e){return failure(e);}
}
