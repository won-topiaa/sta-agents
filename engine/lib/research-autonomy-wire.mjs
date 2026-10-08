import {getProgramDerivedAddress,getTransactionDecoder} from '@solana/kit';
import {STOCKMESH,USDC,TOKEN,TOKEN22,SYSTEM,ATA,COMPUTE,ALT,MAINNET,
 requirePolicy as need,hash,keyBytes,keyString,integer} from './research-autonomy-policy.mjs';
const u64=(d,p)=>{need(p+8<=d.length,'TRUNCATED_WIRE');return d.readBigUInt64LE(p);};
// Decode the SIGNED message, never client-supplied instruction summaries. ALT
// addresses come from pinned mainnet reads, not from API caller arguments.
export async function decodeMessage(base64,resolveLookup){
 const wire=Buffer.from(base64,'base64');need(wire.toString('base64')===base64&&wire.length<=1232,'INVALID_WIRE');
 const tx=getTransactionDecoder().decode(wire),d=Buffer.from(tx.messageBytes);let p=0;
 const take=n=>{need(n>=0&&p+n<=d.length,'TRUNCATED_WIRE');const r=d.subarray(p,p+n);p+=n;return r;};
 const byte=()=>take(1)[0];
 const short=()=>{let n=0;for(let i=0;i<3;i++){const b=byte();need(i<2||b<=3,'INVALID_SHORTVEC');n|=(b&127)<<(7*i);if(!(b&128)){need(i===0||b!==0,'NONCANONICAL_SHORTVEC');return n;}}throw new Error('INVALID_SHORTVEC');};
 let v='legacy';if(d[0]&128){need(byte()===128,'UNSUPPORTED_MESSAGE_VERSION');v=0;}
 const required=byte(),readonlySigned=byte(),readonlyUnsigned=byte(),count=short();
 need(count>0&&count<=256&&required===1&&readonlySigned===0&&readonlyUnsigned<count,'INVALID_MESSAGE_AUTHORITY');
 const keys=Array.from({length:count},()=>keyString(take(32))),blockhash=keyString(take(32));
 const writable=keys.map((_,i)=>i<count-readonlyUnsigned),instructions=[];
 const n=short();need(n>0&&n<=20,'INVALID_INSTRUCTION_COUNT');
 for(let i=0;i<n;i++){const programIndex=byte(),indices=[...take(short())],data=Buffer.from(take(short()));instructions.push({programIndex,indices,data});}
 const lookups=[];
 if(v===0){const n=short();need(n<=8,'TOO_MANY_LOOKUPS');for(let i=0;i<n;i++)lookups.push({address:keyString(take(32)),w:[...take(short())],r:[...take(short())]});}
 need(p===d.length,'TRAILING_MESSAGE_BYTES');
 const resolved=await Promise.all(lookups.map(async l=>{
  const a=await resolveLookup(l.address);need(a?.genesisHash===MAINNET&&a.owner===ALT&&!a.executable,'UNVERIFIED_LOOKUP');
  const data=Buffer.from(a.dataBase64,'base64');need(data.length>=56&&(data.length-56)%32===0&&data.readUInt32LE(0)===1&&u64(data,4)===18446744073709551615n,'INACTIVE_LOOKUP');
  // Require mature, frozen ALT contents for an unattended signing capability.
  need(data[21]===0,'MUTABLE_LOOKUP');
  const at=i=>{need(56+(i+1)*32<=data.length,'LOOKUP_OUT_OF_RANGE');return keyString(data.subarray(56+i*32,88+i*32));};
  return{w:l.w.map(at),r:l.r.map(at)};
 }));
 for(const r of resolved)for(const k of r.w){keys.push(k);writable.push(true);}for(const r of resolved)for(const k of r.r){keys.push(k);writable.push(false);}
 need(keys.length<=256&&new Set(keys).size===keys.length,'DUPLICATE_MESSAGE_ACCOUNT');
 for(const ix of instructions){need(ix.programIndex<keys.length&&!writable[ix.programIndex]&&ix.indices.every(i=>i<keys.length),'INVALID_INSTRUCTION_ACCOUNT');ix.program=keys[ix.programIndex];ix.accounts=ix.indices.map(i=>keys[i]);}
 return{wallet:keys[0],keys,writable,blockhash,instructions,messageHash:hash(d),messageBase64:d.toString('base64')};
}
const ata=async(w,m,t)=>(await getProgramDerivedAddress({programAddress:ATA,seeds:[keyBytes(w),keyBytes(t),keyBytes(m)]}))[0];
export const inspectStockMeshBuy=(base64,wallet,expected,resolveLookup)=>inspectStockMeshTrade(base64,wallet,{...expected,side:'BUY'},resolveLookup);
export async function inspectStockMeshTrade(base64,wallet,expected,resolveLookup){
 need(['BUY','SELL'].includes(expected.side),'INVALID_TRADE_SIDE');
 const sell=expected.side==='SELL';
 const m=await decodeMessage(base64,resolveLookup);need(m.wallet===wallet,'WALLET_CHANGED');
 const swaps=m.instructions.filter(i=>i.program===STOCKMESH&&i.data[0]===2);
 need(swaps.length===1,'ONE_EXACT_SWAP_REQUIRED');const swap=swaps[0],d=swap.data,a=swap.accounts;
 need(d.length>=42&&d[3]===0&&d[1]>=2&&d[1]<=5&&d[2]>=1&&d[2]<=4&&a.length>=6&&a.length<=64&&a[0]===wallet,'INVALID_STOCKMESH_GRAPH');
 const nonce=(await getProgramDerivedAddress({programAddress:STOCKMESH,seeds:[Buffer.from('stocklana'),keyBytes(wallet)]}))[0];need(a[1]===nonce,'WRONG_STOCKMESH_NONCE');
 const input=u64(d,12),minOutput=u64(d,20),deadline=u64(d,28);let p=36;const assets=[];
 for(let i=0;i<d[1];i++){const row=d.subarray(p,p+3);need(row.length===3&&[...row].every(i=>i>=2&&i<a.length),'INVALID_ASSET');p+=3;const [account,mint,token]=[...row].map(i=>a[i]);need([TOKEN,TOKEN22].includes(token)&&account===await ata(wallet,mint,token),'FOREIGN_ASSET_ACCOUNT');assets.push({account,mint,token});}
 need(assets[0].mint===(sell?expected.mint:USDC)&&assets.at(-1).mint===(sell?USDC:expected.mint)&&(sell?assets.at(-1):assets[0]).token===TOKEN,'WRONG_TRADE_ASSET');
 need(input===integer(expected.inputAtoms)&&input>0n&&minOutput>=integer(expected.minimumOutputAtoms)&&minOutput>0n,'WRONG_TRADE_AMOUNT');
 for(let i=0;i<d[2];i++){need(p+14<=d.length,'TRUNCATED_GRAPH');const x=d.subarray(p,p+14),n=x[13];need(x[0]<=8&&x[1]<x[2]&&x[2]<assets.length&&x[3]<=1&&x[12]<a.length&&n<=24&&n>=8&&u64(x,4)>0n,'INVALID_GRAPH_LEG');p+=14;need(p+n<=d.length&&[...d.subarray(p,p+n)].every(i=>i<a.length&&i!==1),'INVALID_GRAPH_ACCOUNTS');p+=n;}need(p===d.length,'TRAILING_GRAPH_BYTES');
 let cu=null,price=null,initialized=false;const created=new Set();
 for(const ix of m.instructions){
  if(ix===swap)continue;
  if(ix.program===COMPUTE){need(ix.accounts.length===0,'INVALID_COMPUTE_ACCOUNTS');if(ix.data[0]===2){need(cu===null&&ix.data.length===5,'DUPLICATE_CU_LIMIT');cu=ix.data.readUInt32LE(1);need(cu>0&&cu<=1400000,'INVALID_CU_LIMIT');}else{need(ix.data[0]===3&&price===null&&ix.data.length===9,'INVALID_COMPUTE_INSTRUCTION');price=u64(ix.data,1);}continue;}
  need(m.instructions.indexOf(ix)<m.instructions.indexOf(swap),'POST_SWAP_MUTATION');
  if(ix.program===STOCKMESH){need(!initialized&&ix.data.length===1&&ix.data[0]===0&&ix.accounts.length===3&&ix.accounts[0]===wallet&&ix.accounts[1]===nonce&&ix.accounts[2]===SYSTEM,'UNAPPROVED_STOCKMESH_OPCODE');initialized=true;continue;}
  if(ix.program===ATA){const [payer,target,owner,mint,sys,token]=ix.accounts;need(ix.data.length===1&&ix.data[0]===1&&ix.accounts.length===6&&payer===wallet&&owner===wallet&&sys===SYSTEM&&!created.has(target)&&assets.some(a=>a.account===target&&a.mint===mint&&a.token===token),'UNAPPROVED_ATA');created.add(target);continue;}
  // No SOL transfer, arbitrary token transfer/approve, durable nonce, policy
  // publication, opaque provider instruction or tip recipient may be added.
  need(false,'UNAPPROVED_TOP_LEVEL_INSTRUCTION');
 }
 need(cu!==null&&price!==null,'EXPLICIT_NETWORK_FEE_REQUIRED');
 return{...m,nonceAddress:nonce,nonceSequence:String(u64(d,4)),createsNonce:initialized,inputAtoms:String(input),minimumOutputAtoms:String(minOutput),mint:expected.mint,side:expected.side,sourceMint:assets[0].mint,destinationMint:assets.at(-1).mint,source:assets[0].account,destination:assets.at(-1).account,deadlineSlot:String(deadline),networkFeeLamports:String(5000n+(BigInt(cu)*price+999999n)/1000000n),setupAccounts:[...created,...(initialized?[nonce]:[])]};
}
