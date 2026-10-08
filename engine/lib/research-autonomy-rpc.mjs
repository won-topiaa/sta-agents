import {readFileSync,statSync} from 'node:fs';
import {getTransactionDecoder} from '@solana/kit';
import {MAINNET,DEVNET,STOCKMESH,ALT,keyBytes,hash,policyAddress,verifyExactSignature,requirePolicy as need} from './research-autonomy-policy.mjs';
import {inspectStockMeshTrade} from './research-autonomy-wire.mjs';

async function boundedJson(response){need(response.ok,'RPC_UNAVAILABLE');const reader=response.body?.getReader();need(reader,'RPC_EMPTY');let size=0;const chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;need(size<=2*1024*1024,'RPC_RESPONSE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel();}let r;try{r=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Error('RPC_INVALID_JSON');}need(r?.id===1&&!r.error&&Object.hasOwn(r,'result'),'RPC_ERROR');return r.result;}
// Only read/simulation methods exist on this object. It cannot submit or sign.
export class MainnetObservationRpc {
 constructor(endpointFile,fetcher=fetch){const mode=statSync(endpointFile).mode;need((mode&0o077)===0,'RPC_SECRET_FILE_PERMISSIONS');this.endpoint=readFileSync(endpointFile,'utf8').trim();need(new URL(this.endpoint).protocol==='https:','RPC_HTTPS_REQUIRED');this.fetcher=fetcher;this.active=0;}
 async call(method,params=[]){need(['getGenesisHash','getAccountInfo','simulateTransaction','getSignatureStatuses','getTransaction','isBlockhashValid','getBalance','getTokenAccountBalance'].includes(method),'RPC_METHOD_NOT_ALLOWED');need(this.active<3,'RPC_CONCURRENCY_LIMIT');this.active++;try{return await boundedJson(await this.fetcher(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}));}catch(e){throw new Error(e?.code??'MAINNET_OBSERVATION_UNAVAILABLE');}finally{this.active--;}}
 async pin(expected=MAINNET){need(expected===MAINNET&&await this.call('getGenesisHash')===MAINNET,'WRONG_MAINNET_GENESIS');}
 async lookup(address){await this.pin();const r=await this.call('getAccountInfo',[address,{encoding:'base64',commitment:'finalized'}]);need(r?.value&&r.value.owner===ALT&&r.value.data?.[1]==='base64','LOOKUP_NOT_AVAILABLE');return{genesisHash:MAINNET,owner:r.value.owner,executable:r.value.executable,dataBase64:r.value.data[0],slot:r.context.slot};}
 async simulate(wire,facts){await this.pin();const messageHash=hash(getTransactionDecoder().decode(Buffer.from(wire,'base64')).messageBytes);need(messageHash===facts.messageHash,'SIMULATION_WIRE_CHANGED');const r=await this.call('simulateTransaction',[wire,{encoding:'base64',commitment:'confirmed',sigVerify:false,replaceRecentBlockhash:false}]);need(r?.value&&r.value.err===null&&r.context.slot<=Number(facts.deadlineSlot),'SIMULATION_FAILED');return{genesisHash:MAINNET,messageHash,err:r.value.err,slot:r.context.slot,units:r.value.unitsConsumed};}
 async blockhashValid(blockhash){return(await this.call('isBlockhashValid',[blockhash,{commitment:'confirmed'}]))?.value===true;}
 async transaction(signature){const r=await this.call('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]);const status=r?.value?.[0];if(status?.confirmationStatus!=='finalized')return null;const tx=await this.call('getTransaction',[signature,{commitment:'finalized',encoding:'base64',maxSupportedTransactionVersion:0}]);if(!tx)return null;return{genesisHash:MAINNET,status,tx};}
 async expiredNoFill(row){
  // Missing history is not proof. Finalized nonce evidence is mandatory.
  await this.pin();
  need(verifyExactSignature(row.prepared.transactionBase64,row.signedTransactionBase64,row.wallet)===row.signature,'EXPIRY_SIGNATURE_MISMATCH');
  const f=await inspectStockMeshTrade(row.signedTransactionBase64,row.wallet,row.facts,a=>this.lookup(a));
  need(f.messageHash===row.facts.messageHash,'EXPIRY_MESSAGE_MISMATCH');
  const expired=await this.call('isBlockhashValid',[f.blockhash,{commitment:'finalized'}]);
  if(expired?.value!==false)return null;
  const history=await this.call('getSignatureStatuses',[[row.signature],{searchTransactionHistory:true}]);
  if(!Array.isArray(history?.value)||history.value.length!==1||history.value[0]!==null)return null;
  const deadline=Number(f.deadlineSlot);need(Number.isSafeInteger(deadline)&&deadline<Number.MAX_SAFE_INTEGER,'INVALID_EXPIRY_SLOT');
  const a=await this.call('getAccountInfo',[f.nonceAddress,{encoding:'base64',commitment:'finalized',minContextSlot:deadline+1}]);
  const proof=verifyUnchangedNonce(f,row.wallet,a);if(!proof)return null;
  return{schema:'xtxc.signed-expiry/v1',phase:'EXPIRED_NO_FILL',signature:row.signature,messageHash:f.messageHash,genesisHash:MAINNET,blockhash:f.blockhash,blockhashExpired:true,historyAbsent:true,deadlineSlot:f.deadlineSlot,...proof,reason:'FINALIZED_UNCHANGED_STOCKMESH_NONCE',networkFeeStatus:'UNKNOWN'};
 }
}
export function verifyUnchangedNonce(f,wallet,a){
 const slot=a?.context?.slot;if(!Number.isSafeInteger(slot)||BigInt(slot)<=BigInt(f.deadlineSlot)||!Object.hasOwn(a,'value'))return null;
 if(a.value===null)return f.createsNonce&&f.nonceSequence==='0'?{slot,nonceAddress:f.nonceAddress,nonceSequence:null,expectedSequence:'0'}:null;
 const v=a.value;if(v.owner!==STOCKMESH||v.executable!==false||v.data?.[1]!=='base64')return null;
 const d=Buffer.from(v.data[0],'base64');
 if(d.length!==64||d.subarray(0,8).toString()!=='SKEWSEQ1'||!d.subarray(8,40).equals(keyBytes(wallet))||String(d.readBigUInt64LE(40))!==f.nonceSequence)return null;
 return{slot,nonceAddress:f.nonceAddress,nonceSequence:f.nonceSequence,expectedSequence:f.nonceSequence};
}
export class DevnetPolicyReader {
 constructor(fetcher=fetch){this.fetcher=fetcher;}
 async call(method,params=[]){need(['getGenesisHash','getAccountInfo','getLatestBlockhash','getFeeForMessage','getSignatureStatuses','getTransaction'].includes(method),'DEVNET_READ_METHOD_NOT_ALLOWED');return boundedJson(await this.fetcher('https://api.devnet.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}));}
 async pin(){need(await this.call('getGenesisHash')===DEVNET,'WRONG_DEVNET_GENESIS');}
 async observe(config){await this.pin();const {state}=await policyAddress(config),r=await this.call('getAccountInfo',[state,{encoding:'base64',commitment:'finalized'}]);need(r?.value?.data?.[1]==='base64'&&!r.value.executable,'DEVNET_POLICY_ABSENT');return{genesisHash:DEVNET,commitment:'finalized',address:state,owner:r.value.owner,slot:r.context.slot,observedAt:Date.now(),dataBase64:r.value.data[0]};}
}
