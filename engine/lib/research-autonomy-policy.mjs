// The demo's 2-USDC / 1-USDC orders are INPUTS, never policy constants.
// This is a devnet reservation/attestation protocol, not mainnet enforcement.
import {createHash,createPublicKey,verify} from 'node:crypto';
import {address,getAddressEncoder,getAddressDecoder,getProgramDerivedAddress,
 getTransactionDecoder,getTransactionEncoder,getBase58Decoder,createTransactionMessage,
 setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,
 appendTransactionMessageInstruction,compileTransaction} from '@solana/kit';
export const DEVNET='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const MAINNET='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const STOCKMESH='Am6Xc88xbowj6kNDdjmg13wPvvRvTdijcWvadFCZKFPD';
export const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SYSTEM='11111111111111111111111111111111';
export const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE='ComputeBudget111111111111111111111111111111';
export const ALT='AddressLookupTab1e1111111111111111111111111';
export class PolicyError extends Error {constructor(code){super(code);this.name='PolicyError';this.code=code;}}
export function requirePolicy(ok,code){if(!ok)throw new PolicyError(code);}
export const hash=v=>createHash('sha256').update(v).digest('hex');
export function canonical(v){if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);if(typeof v==='number'){requirePolicy(Number.isSafeInteger(v),'UNSAFE_NUMBER');return String(v);}if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';requirePolicy(v&&typeof v==='object','INVALID_DOCUMENT');return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
export const keyBytes=k=>Buffer.from(getAddressEncoder().encode(address(k)));
export const keyString=b=>getAddressDecoder().decode(b);
export function integer(v){requirePolicy(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&BigInt(v)<=18446744073709551615n,'INVALID_INTEGER');return BigInt(v);}
const u64=v=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(integer(v));return b;};
export function digest(v){requirePolicy(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&!/^0+$/.test(v),'INVALID_HASH');return Buffer.from(v,'hex');}
// Ordered trade commitment, not a mutable mint allow-list. Proofs bind index,
// side, exact input quantity and minimum USDC proceeds. 128 legs fit in a
// 7-hash proof while approvals remain a fixed size under Solana's packet limit.
export const isPlanPolicy=c=>c.schema==='xtxc.autonomy-policy/v2';
export function tradeLeaf(t,index){
 requirePolicy(['BUY','SELL'].includes(t.side)&&Number.isSafeInteger(index)&&index>=0&&index<128,'INVALID_TRADE');
 keyBytes(t.mint);const amount=integer(t.inputAtoms),minimum=integer(t.minimumCashAtoms??'0');
 requirePolicy(amount>0n&&(t.side==='SELL'?minimum>0n:minimum===0n),'INVALID_TRADE');
 return Buffer.from(hash(Buffer.concat([Buffer.from('STA:trade:v2'),u64(String(index)),Buffer.from([t.side==='SELL'?1:0]),keyBytes(t.mint),u64(t.inputAtoms),u64(String(minimum))])),'hex');
}
const branch=(a,b)=>Buffer.from(hash(Buffer.concat([Buffer.from('STA:branch:v2'),a,b])),'hex');
export function tradeTree(trades,index=0){
 requirePolicy(Array.isArray(trades)&&trades.length>=1&&trades.length<=128&&index>=0&&index<trades.length,'INVALID_TRADE_COUNT');
 let nodes=trades.map(tradeLeaf),position=index;const proof=[];
 while(nodes.length>1){proof.push(nodes[position^1]??nodes[position]);const next=[];for(let i=0;i<nodes.length;i+=2)next.push(branch(nodes[i],nodes[i+1]??nodes[i]));nodes=next;position>>=1;}
 return{root:nodes[0].toString('hex'),proof:proof.map(x=>x.toString('hex'))};
}
export function validatePolicy(c){
 requirePolicy(['xtxc.autonomy-policy/v1','xtxc.autonomy-policy/v2'].includes(c.schema)&&c.executionChain==='solana:mainnet'&&c.evidenceChain==='solana:devnet','WRONG_CHAIN');
 for(const k of [c.program,c.owner,c.verifier,c.wallet])keyBytes(k);
 requirePolicy(![SYSTEM,TOKEN,TOKEN22,STOCKMESH].includes(c.program)&&c.owner!==c.verifier&&![c.owner,c.verifier,c.wallet].includes(SYSTEM),'INVALID_AUTHORITY');
 digest(c.id);digest(c.approvalHash);
 const start=integer(c.startsAt),end=integer(c.expiresAt),budget=integer(c.buyBudgetAtoms),per=integer(c.perBuyAtoms),orders=integer(c.maxOrders);
 requirePolicy((end===0n||end>start)&&end<=9223372036854775807n&&start<=9223372036854775807n&&(isPlanPolicy(c)?budget>=0n&&per>=0n:budget>0n&&per>0n)&&per<=budget&&orders>0n,'INVALID_LIMITS');
 requirePolicy(Array.isArray(c.mints)&&c.mints.length>=1&&c.mints.length<=(isPlanPolicy(c)?64:8)&&new Set(c.mints).size===c.mints.length,'INVALID_UNIVERSE');
 for(const m of c.mints){keyBytes(m);requirePolicy(![SYSTEM,USDC].includes(m),'INVALID_STOCK');}
 if(isPlanPolicy(c)){
  const tree=tradeTree(c.trades);
  requirePolicy(c.tradeRoot===tree.root&&orders===BigInt(c.trades.length),'TRADE_COMMITMENT_MISMATCH');
  requirePolicy(c.trades.every(t=>c.mints.includes(t.mint))&&c.mints.every(m=>c.trades.some(t=>t.mint===m)),'INVALID_UNIVERSE');
  const buys=c.trades.filter(t=>t.side==='BUY');
  requirePolicy(buys.reduce((n,t)=>n+integer(t.inputAtoms),0n)===budget&&buys.reduce((n,t)=>n>integer(t.inputAtoms)?n:integer(t.inputAtoms),0n)===per,'TRADE_BUDGET_MISMATCH');
 }
 requirePolicy(Number.isInteger(c.maxSlippageBps)&&c.maxSlippageBps>=1&&c.maxSlippageBps<=100,'INVALID_SLIPPAGE');
 // Fees are disclosed separately. null means no user fee cap; it does NOT
 // disable one-signature-per-order, bounded relay or the unresolved-order lock.
 if(c.feeBudgetLamports!==null)integer(c.feeBudgetLamports);
 return c;
}
export async function policyAddress(c){validatePolicy(c);const [state,bump]=await getProgramDerivedAddress({programAddress:address(c.program),seeds:[Buffer.from('xtxc-demo-policy1'),keyBytes(c.owner),digest(c.id)]});return{state,bump};}
export async function policyInstruction(c,operation,args={}){
 const {state}=await policyAddress(c);let data,actor=c.verifier;
 if(operation==='APPROVE'){actor=c.owner;data=Buffer.concat([Buffer.from([isPlanPolicy(c)?4:0]),keyBytes(c.verifier),keyBytes(c.wallet),digest(c.id),digest(c.approvalHash),...[c.startsAt,c.expiresAt,c.buyBudgetAtoms,c.perBuyAtoms,c.maxOrders].map(u64),...(isPlanPolicy(c)?[digest(c.tradeRoot)]:[Buffer.from([c.mints.length]),...c.mints.map(keyBytes)])]);}
 else if(operation==='RESERVE'){
  data=Buffer.concat([Buffer.from([isPlanPolicy(c)?5:1]),u64(args.counter),u64(args.inputAtoms),keyBytes(args.mint),digest(args.messageHash)]);
  if(isPlanPolicy(c)){const index=Number(integer(args.counter)),t=c.trades[index];requirePolicy(t&&t.mint===args.mint&&t.inputAtoms===args.inputAtoms&&t.side===args.side,'TRADE_NOT_APPROVED');const {proof}=tradeTree(c.trades,index);data=Buffer.concat([data,Buffer.from([t.side==='SELL'?1:0]),u64(t.minimumCashAtoms??'0'),Buffer.from([proof.length]),...proof.map(digest)]);}
 }
 else if(operation==='SETTLE'){requirePolicy(['RECONCILED','FAILED_FINALIZED','EXPIRED_UNSIGNED','EXPIRED_NO_FILL'].includes(args.phase),'INVALID_RECEIPT_PHASE');data=Buffer.concat([Buffer.from([2]),digest(args.messageHash),digest(args.receiptHash),Buffer.from([args.phase==='RECONCILED'?1:2])]);}
 else if(operation==='REVOKE'){actor=c.owner;data=Buffer.from([3]);}else throw new PolicyError('INVALID_OPERATION');
 return{programAddress:address(c.program),accounts:[{address:address(actor),role:operation==='APPROVE'?3:2},{address:state,role:1},...(operation==='APPROVE'?[{address:address(SYSTEM),role:0}]:[])],data};
}
export function policyTransaction(payer,instructions,lifetime,version='legacy'){requirePolicy(version==='legacy'||version===0,'UNSUPPORTED_MESSAGE_VERSION');let m=createTransactionMessage({version});m=setTransactionMessageFeePayer(address(payer),m);m=setTransactionMessageLifetimeUsingBlockhash({blockhash:lifetime.blockhash,lastValidBlockHeight:integer(String(lifetime.lastValidBlockHeight))},m);for(const ix of instructions)m=appendTransactionMessageInstruction(ix,m);const tx=compileTransaction(m),wire=Buffer.from(getTransactionEncoder().encode(tx));requirePolicy(wire.length<=1232,'OVERSIZED_TRANSACTION');return{owner:payer,transactionBase64:wire.toString('base64'),messageHash:hash(tx.messageBytes),lastValidBlockHeight:String(lifetime.lastValidBlockHeight)};}
export async function ownerApprovalTransaction(c,lifetime){
 // Wallets may insert missing compute-budget instructions during approval.
 // Explicit zero priority price prevents that without weakening exact-wire
 // validation. V0 also avoids legacy account recompilation by wallet SDKs.
 const limit=Buffer.alloc(5);limit[0]=2;limit.writeUInt32LE(200000,1);
 const price=Buffer.alloc(9);price[0]=3;
 return policyTransaction(c.owner,[{programAddress:address(COMPUTE),accounts:[],data:limit},
  {programAddress:address(COMPUTE),accounts:[],data:price},await policyInstruction(c,'APPROVE')],lifetime,0);
}
export async function observePolicy(c,observation,now=Date.now()){
 const {state,bump}=await policyAddress(c);
 requirePolicy(observation.genesisHash===DEVNET&&observation.commitment==='finalized'&&observation.address===state&&observation.owner===c.program,'UNVERIFIED_DEVNET_POLICY');
 requirePolicy(Number.isSafeInteger(observation.slot)&&observation.slot>0&&Number.isSafeInteger(observation.observedAt)&&now-observation.observedAt>=-1000&&now-observation.observedAt<=15000,'STALE_POLICY');
 const d=Buffer.from(observation.dataBase64,'base64'),n=p=>d.readBigUInt64LE(p);
 requirePolicy(d.length===616&&d.subarray(0,8).toString()===(isPlanPolicy(c)?'XTXCDMP2':'XTXCDMP1'),'POLICY_LAYOUT');
 for(const [off,k] of [[8,c.owner],[40,c.verifier],[72,c.wallet]])requirePolicy(keyString(d.subarray(off,off+32))===k,'POLICY_AUTHORITY_CHANGED');
 requirePolicy(d.subarray(104,136).toString('hex')===c.id&&d.subarray(136,168).toString('hex')===c.approvalHash&&d[227]===bump&&d[226]===(isPlanPolicy(c)?0:c.mints.length),'POLICY_IDENTITY_CHANGED');
 for(const [off,v] of [[168,c.startsAt],[176,c.expiresAt],[184,c.buyBudgetAtoms],[208,c.maxOrders],[216,c.perBuyAtoms]])requirePolicy(n(off)===integer(v),'POLICY_LIMITS_CHANGED');
 if(isPlanPolicy(c))requirePolicy(d.subarray(344,376).toString('hex')===c.tradeRoot,'TRADE_COMMITMENT_MISMATCH');
 else for(const [i,m] of c.mints.entries())requirePolicy(keyString(d.subarray(344+i*32,376+i*32))===m,'POLICY_MINT_CHANGED');
 requirePolicy(d[224]<=1&&d[225]<=1&&d[336]<=2&&d[228]<=(isPlanPolicy(c)?1:0)&&!d.subarray(229,232).some(Boolean)&&!d.subarray(337,344).some(Boolean)&&!d.subarray(isPlanPolicy(c)?376:344+c.mints.length*32).some(Boolean)&&n(192)<=n(184)&&n(200)<=n(208),'INVALID_POLICY_STATE');
 return {state,slot:observation.slot,observedAt:observation.observedAt,count:String(n(200)),reservedAtoms:String(n(192)),pending:d[224]===1,revoked:d[225]===1,messageHash:d.subarray(232,264).toString('hex'),receiptHash:d.subarray(304,336).toString('hex'),pendingAtoms:String(n(264)),pendingMint:keyString(d.subarray(272,304)),pendingSide:d[228]?'SELL':'BUY',outcome:d[336],active:!d[225]&&BigInt(Math.floor(now/1000))>=n(168)&&(n(176)===0n||BigInt(Math.floor(now/1000))<n(176))};
}
export function allowOrder(c,s,order){validatePolicy(c);requirePolicy(s.active&&!s.revoked,'POLICY_INACTIVE');requirePolicy(!s.pending,'ORDER_UNRESOLVED');requirePolicy(integer(s.count)<integer(c.maxOrders),'ORDER_LIMIT');
 if(isPlanPolicy(c)){const t=c.trades[Number(s.count)];requirePolicy(t&&t.side===order.side&&t.mint===order.mint&&t.inputAtoms===order.inputAtoms,'TRADE_NOT_APPROVED');if(t.side==='SELL'){requirePolicy(integer(order.minimumOutputAtoms??order.minimumCashAtoms??'0')>=integer(t.minimumCashAtoms),'SELL_MINIMUM_NOT_APPROVED');return true;}}
 requirePolicy(order.side==='BUY'&&c.mints.includes(order.mint),'ASSET_NOT_APPROVED');const n=integer(order.inputAtoms);requirePolicy(n>0n&&n<=integer(c.perBuyAtoms),'PER_ORDER_LIMIT');requirePolicy(integer(s.reservedAtoms)+n<=integer(c.buyBudgetAtoms),'BUY_BUDGET_EXHAUSTED');return true;}
export function verifyExactSignature(unsignedBase64,signedBase64,wallet){
 requirePolicy(typeof signedBase64==='string'&&signedBase64.length<=1644,'INVALID_SIGNED_WIRE');
 const wire=Buffer.from(signedBase64,'base64'),tx=getTransactionDecoder().decode(wire),expected=getTransactionDecoder().decode(Buffer.from(unsignedBase64,'base64'));
 requirePolicy(wire.length<=1232&&wire.toString('base64')===signedBase64&&Buffer.from(getTransactionEncoder().encode(tx)).equals(wire)&&Buffer.from(tx.messageBytes).equals(Buffer.from(expected.messageBytes)),'SIGNER_CHANGED_TRANSACTION');
 const entries=Object.entries(tx.signatures);requirePolicy(entries.length===1&&entries[0][0]===wallet&&entries[0][1],'UNEXPECTED_SIGNER');
 const sig=Buffer.from(entries[0][1]),key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),keyBytes(wallet)]),format:'der',type:'spki'});
 requirePolicy(verify(null,Buffer.from(tx.messageBytes),key,sig),'INVALID_SIGNATURE');return getBase58Decoder().decode(sig);
}
