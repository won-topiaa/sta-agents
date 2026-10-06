import {requireRequesterSession,RequesterAuthError} from '@/lib/requester-auth';
import {stocklanaBody} from '@/lib/stocklana-execution';
import {walletConnectionRequest} from '@/lib/research-wallet-transport';
import {autonomyRequest} from '@/lib/research-autonomy-transport';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, X-Skew-Expected-Requester'};
async function owner(request:Request){const s=await requireRequesterSession(request);if(s.agentKeyId||!s.address.startsWith('solana:'))throw new RequesterAuthError('OWNER_SESSION_REQUIRED','Sign in with your Solana wallet.',403);return s.address.slice(7);}
const messages:Record<string,string>={OWNER_NOT_LINKED_TO_PRIVY_USER:'Use the same Solana wallet for XTXC and Privy.',USER_OWNED_DELEGATED_WALLET_REQUIRED:'Create an agent wallet, then authorize the XTXC signer.',PROVIDER_SIGNER_NOT_AUTHORIZED:'Authorize the XTXC signer with its displayed policy.',PRIVY_LOGIN_REQUIRED:'Sign in to connect your agent wallet.',PRIVY_TOKEN_INVALID:'Your wallet login expired. Sign in again.',EXISTING_AGENT_WALLET:'This account already has an agent wallet. Reconnect that wallet.',OWNER_SESSION_MISMATCH:'Use your personal wallet to sign in, not the agent wallet.'};
function failure(e:unknown){if(e instanceof RequesterAuthError)return Response.json({error:{message:e.message}},{status:e.status,headers});const code=e instanceof Error?e.message:'';return Response.json({error:{message:messages[code]??'The wallet connection could not be verified. Nothing was started.'}},{status:409,headers});}
export async function GET(request:Request){try{return Response.json(await walletConnectionRequest(await owner(request),'STATUS'),{headers});}catch(e){return failure(e);}}
export async function POST(request:Request){try{const address=await owner(request),b=await stocklanaBody(request,23000) as Record<string,unknown>;if(!b||!['CONNECT','DISCONNECT'].includes(String(b.operation))||Object.keys(b).some(k=>!['operation','walletId','address','accessToken'].includes(k)))throw Error('INVALID_REQUEST');if(b.operation==='DISCONNECT')await autonomyRequest(address,'STOP_ALL',{});return Response.json(await walletConnectionRequest(address,String(b.operation),{walletId:b.walletId,address:b.address,accessToken:b.accessToken}),{headers});}catch(e){return failure(e);}}
