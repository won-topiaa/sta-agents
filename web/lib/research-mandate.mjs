// Unsigned mandate adapter. No RPC, owner key, signer, deployment or background
// sender. Admission still happens in the on-chain program, not in these helpers.
import {address,getAddressEncoder,getAddressDecoder,getProgramDerivedAddress,
  createTransactionMessage,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,compileTransaction,getTransactionEncoder} from '@solana/kit';
export const MANDATE_VERSION='xtxc.trading-mandate/v1';
export const MAINNET_GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const STOCKMESH='Am6Xc88xbowj6kNDdjmg13wPvvRvTdijcWvadFCZKFPD';
export const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SYSTEM='11111111111111111111111111111111';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const WSOL='So11111111111111111111111111111111111111112';
const enc=getAddressEncoder(),dec=getAddressDecoder();
const bytes=k=>Buffer.from(enc.encode(address(k)));
const uint=v=>{if(typeof v!=='string'||! /^(0|[1-9][0-9]*)$/.test(v)||BigInt(v)>18446744073709551615n)throw new Error('Amounts and timestamps require exact u64 decimal strings.');return BigInt(v);};
const u64=v=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(uint(v));return b;};
const hex=v=>{if(typeof v!=='string'||! /^[0-9a-f]{64}$/.test(v)||/^0+$/.test(v))throw new Error('A nonzero 32-byte identity/approval hash is required.');return Buffer.from(v,'hex');};
const meta=(key,role=0)=>({address:address(key),role});
const ix=(program,accounts,data)=>({programAddress:address(program),accounts,data:new Uint8Array(data)});
export async function mandateAddresses(program,owner,id){
 if([STOCKMESH,SYSTEM,TOKEN,TOKEN22].includes(program))throw new Error('A separately deployed mandate program is required.');
 const [state,bump]=await getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from('xtxc-mandate-v1'),bytes(owner),hex(id)]});
 const [authority,authorityBump]=await getProgramDerivedAddress({programAddress:address(program),seeds:[Buffer.from('xtxc-trader-v1'),bytes(state)]});
 const [nonce]=await getProgramDerivedAddress({programAddress:address(STOCKMESH),seeds:[Buffer.from('stocklana'),bytes(authority)]});
 return{state,bump,authority,authorityBump,nonce};
}
async function tokenAccount(owner,mint,program){return(await getProgramDerivedAddress({programAddress:address(ATA),seeds:[bytes(owner),bytes(program),bytes(mint)]}))[0];}
export function validateMandate(c){
 if(c.schema!==MANDATE_VERSION||c.executionChain!=='solana:mainnet'||c.evidenceChain!=='solana:devnet')throw new Error('Mainnet execution and devnet evidence must be separate.');
 bytes(c.program);bytes(c.owner);bytes(c.executor);hex(c.id);hex(c.approvalHash);
 if(c.owner===c.executor||[SYSTEM,TOKEN,TOKEN22,STOCKMESH].includes(c.executor)||c.owner===SYSTEM)throw new Error('Use a separate bounded executor, never the owner key.');
 const [start,end,funding,turnover,perOrder,trades]=[c.startsAt,c.expiresAt,c.fundingCapAtoms,c.buyTurnoverCapAtoms,c.perBuyCapAtoms,c.maxTrades].map(uint);
 if(start>=end||end>9223372036854775807n||funding===0n||turnover===0n||perOrder===0n||perOrder>turnover||trades===0n)throw new Error('Invalid immutable mandate limits.');
 if(!Array.isArray(c.stocks)||c.stocks.length<1||c.stocks.length>12||new Set(c.stocks.map(s=>s.mint)).size!==c.stocks.length)throw new Error('Approve 1–12 distinct exact stock mints per mandate.');
 for(const r of c.stocks){bytes(r.mint);if([SYSTEM,USDC,WSOL].includes(r.mint)||! [TOKEN,TOKEN22].includes(r.tokenProgram)||!Number.isInteger(r.rawDecimals)||r.rawDecimals<0||r.rawDecimals>12)throw new Error('Invalid exact stock identity.');
  if(uint(r.minSellPriceAtoms)===0n||uint(r.maxBuyPriceAtoms)<uint(r.minSellPriceAtoms)||uint(r.maxSellAtoms)===0n)throw new Error('Approve explicit buy/sell price collars and sale limits.');
 }
 return c;
}
export function mandateWire(c){
 validateMandate(c);
 return Buffer.concat([Buffer.from([0]),bytes(c.executor),hex(c.id),hex(c.approvalHash),
  ...[c.startsAt,c.expiresAt,c.fundingCapAtoms,c.buyTurnoverCapAtoms,c.perBuyCapAtoms,c.maxTrades].map(u64),Buffer.from([c.stocks.length]),
  ...c.stocks.flatMap(r=>[bytes(r.mint),Buffer.from([r.tokenProgram===TOKEN?0:1,r.rawDecimals]),u64(r.maxBuyPriceAtoms),u64(r.minSellPriceAtoms),u64(r.maxSellAtoms)])]);
}
export async function approvalInstruction(c){const p=await mandateAddresses(c.program,c.owner,c.id);return ix(c.program,[meta(c.owner,3),meta(p.state,1),meta(p.authority),meta(SYSTEM)],mandateWire(c));}
export async function fundingInstruction(c,amount){
 validateMandate(c);if(uint(amount)===0n||uint(amount)>uint(c.fundingCapAtoms))throw new Error('Funding exceeds the approved budget.');
 const p=await mandateAddresses(c.program,c.owner,c.id);
 return ix(c.program,[meta(c.owner,2),meta(p.state,1),meta(p.authority),meta(await tokenAccount(c.owner,USDC,TOKEN),1),meta(await tokenAccount(p.authority,USDC,TOKEN),1),meta(USDC),meta(TOKEN)],Buffer.concat([Buffer.from([1]),u64(amount)]));
}
export async function revokeInstruction(c){validateMandate(c);const p=await mandateAddresses(c.program,c.owner,c.id);return ix(c.program,[meta(c.owner,2),meta(p.state,1)],Buffer.from([2]));}
export async function withdrawalInstruction(c,mint,tokenProgram,amount){
 validateMandate(c);if(![TOKEN,TOKEN22].includes(tokenProgram)||uint(amount)===0n)throw new Error('Invalid withdrawal.');
 const p=await mandateAddresses(c.program,c.owner,c.id);
 return ix(c.program,[meta(c.owner,2),meta(p.state,1),meta(p.authority),meta(await tokenAccount(p.authority,mint,tokenProgram),1),meta(mint),meta(await tokenAccount(c.owner,mint,tokenProgram),1),meta(tokenProgram)],Buffer.concat([Buffer.from([4]),u64(amount)]));
}
export async function nonceInstruction(c){validateMandate(c);const p=await mandateAddresses(c.program,c.owner,c.id);return ix(c.program,[meta(c.owner,2),meta(p.state),meta(p.authority,1),meta(p.nonce,1),meta(STOCKMESH),meta(SYSTEM)],Buffer.from([5]));}
export async function tradeInstruction(c,settlement,expectedCounter){
 validateMandate(c);const p=await mandateAddresses(c.program,c.owner,c.id);
 if(settlement.programAddress!==STOCKMESH||settlement.data?.[0]!==2||settlement.accounts?.[0]?.address!==p.authority||settlement.accounts?.[1]?.address!==p.nonce||settlement.accounts.length>64)throw new Error('Compile StockMesh for the mandate authority, not the owner wallet.');
 if(settlement.accounts.some((a,i)=>i>0&&a.role>=2)||settlement.accounts.some(a=>[p.state,c.executor,c.program].includes(a.address)))throw new Error('Unexpected signing or mandate accounts in settlement.');
 return ix(c.program,[meta(p.state,1),meta(c.executor,2),meta(STOCKMESH),...settlement.accounts.map(a=>meta(a.address,a.role%2))],Buffer.concat([Buffer.from([3]),u64(expectedCounter),Buffer.from(settlement.data)]));
}
// No setup instruction is smuggled into this wrapper. Owner pays ATA/nonce rent
// explicitly during activation; the runner receives a ready account afterward.
export function unsignedMandateTransaction(payer,instructions,lifetime){
 let message=createTransactionMessage({version:'legacy'});
 message=setTransactionMessageFeePayer(address(payer),message);
 message=setTransactionMessageLifetimeUsingBlockhash({blockhash:lifetime.blockhash,lastValidBlockHeight:BigInt(lifetime.lastValidBlockHeight)},message);
 for(const i of instructions)message=appendTransactionMessageInstruction(i,message);
 const tx=compileTransaction(message),wire=Buffer.from(getTransactionEncoder().encode(tx));
 if(wire.length>1232)throw new Error('This approval/setup exceeds a Solana packet. Split owner-approved setup steps; do not change the mandate.');
 return{transactionBase64:wire.toString('base64'),messageBase64:Buffer.from(tx.messageBytes).toString('base64'),wireBytes:wire.length,requiredSigners:Object.keys(tx.signatures)};
}
export async function decodeObservedMandate(c,observation,now=Math.floor(Date.now()/1000)){
 validateMandate(c);const p=await mandateAddresses(c.program,c.owner,c.id);
 if(observation.genesisHash!==MAINNET_GENESIS||observation.commitment!=='finalized'||observation.address!==p.state||observation.owner!==c.program||!Number.isSafeInteger(observation.slot)||observation.slot<=0)throw new Error('An actual finalized mainnet mandate account is required.');
 const d=Buffer.from(observation.dataBase64,'base64'),num=p=>d.readBigUInt64LE(p);
 if(d.length!==232+c.stocks.length*96||d.subarray(0,8).toString()!=='XTXCMND1'||dec.decode(d.subarray(8,40))!==c.owner||dec.decode(d.subarray(40,72))!==c.executor||d.subarray(72,104).toString('hex')!==c.id||d.subarray(104,136).toString('hex')!==c.approvalHash)throw new Error('Mandate identity or approved version changed.');
 const limits=[c.startsAt,c.expiresAt,c.fundingCapAtoms,c.buyTurnoverCapAtoms,c.perBuyCapAtoms,c.maxTrades];
 for(const [i,offset] of [136,144,152,168,184,192].entries())if(num(offset)!==uint(limits[i]))throw new Error('On-chain mandate limits differ from approval.');
 if(d[209]!==c.stocks.length||d[210]!==p.bump||d[211]!==p.authorityBump||d.subarray(212,216).some(Boolean)||d.subarray(224,232).some(Boolean)||num(160)>num(152)||num(176)>num(168)||num(200)>num(192)||d[208]>1)throw new Error('Invalid mandate state.');
 for(const [i,r] of c.stocks.entries()){const p=232+96*i;if(dec.decode(d.subarray(p,p+32))!==r.mint||dec.decode(d.subarray(p+32,p+64))!==r.tokenProgram||d[p+64]!==r.rawDecimals||d.subarray(p+65,p+72).some(Boolean)||num(p+72)!==uint(r.maxBuyPriceAtoms)||num(p+80)!==uint(r.minSellPriceAtoms)||num(p+88)!==uint(r.maxSellAtoms))throw new Error('On-chain asset limits differ from approval.');}
 return{...p,approvalHash:c.approvalHash,owner:c.owner,executor:c.executor,revoked:d[208]===1,
  phase:d[208]?'REVOKED':BigInt(now)>=num(144)?'EXPIRED':BigInt(now)<num(136)?'NOT_STARTED':num(200)>=num(192)?'TRADE_LIMIT':num(176)>=num(168)?'BUY_LIMIT':'ACTIVE',
  fundedAtoms:String(num(160)),buySpentAtoms:String(num(176)),sellReceivedAtoms:String(num(216)),tradeCount:String(num(200)),observedSlot:observation.slot};
}
