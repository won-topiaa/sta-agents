import {generateKeyPairSync,sign} from 'node:crypto';
import {getProgramDerivedAddress,getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import {keyString,keyBytes,USDC,TOKEN,MAINNET,COMPUTE,STOCKMESH,policyTransaction,verifyExactSignature} from '../../lib/research-autonomy-policy.mjs';
import {briefHash,hash as reportHash} from '../../lib/research-agent-core.mjs';
import {operatingMessage} from '../../lib/research-ongoing-policy.mjs';
export const key=n=>keyString(Buffer.alloc(32,n));
export function fixture() {
 const ownerPair=generateKeyPairSync('ed25519'),walletPair=generateKeyPairSync('ed25519');
 const pub=p=>keyString(p.publicKey.export({format:'der',type:'spki'}).subarray(-32));
 const owner=pub(ownerPair),wallet=pub(walletPair);
 const strategy={id:'12345678-1234-1234-1234-123456789abc',name:'Managed stocks',objective:'Follow validated research within the budget.',budget:'4',instruments:['NVDA','MSFT'],weights:[],cashBps:null};
 const goal={targetReturnBps:100,horizonDays:30,maxDrawdownBps:2000,maxWeightBps:10000,minCashBps:0,costBps:20};
 const c={schema:'sta.operating-mandate/v1',id:'ab'.repeat(32),owner,wallet,strategyId:strategy.id,briefHash:briefHash(strategy),executionChain:'solana:mainnet',startsAt:'0',expiresAt:'0',capitalAtoms:'4000000',buyTurnoverAtoms:'10000000',perBuyAtoms:'2000000',maxOrders:'100',feeBudgetLamports:'1000000',maxSlippageBps:20,maxLossBps:2000,minCashBps:0,maxWeightBps:10000,rebalanceBandBps:100,minTradeAtoms:'10000',pollMs:1000,maxResearchAgeMs:86400000,riskAction:'LIQUIDATE',riskReductionBps:5000,assets:[{instrument:'NVDA',mint:key(195),rawDecimals:0},{instrument:'MSFT',mint:key(196),rawDecimals:0}],goal};
 const binding={owner,address:wallet,walletId:'fixture-wallet',providerPolicyHash:'fixture-policy-hash',signerId:'signer',authorizationKeyHash:'auth',policyId:'provider-policy'};
 const signature=()=>sign(null,Buffer.from(operatingMessage(c)),ownerPair.privateKey).toString('base64');
 const research=(instrument='NVDA',updatedAt=Date.now()-1000,weightBps=5000)=>{
  const result={decision:'REVIEW',dataset:{id:'frozen-fixture'},candidates:['a','b','c'].map((id,i)=>({id,weights:[{instrument,weightBps}],horizonMedianBps:200,holdoutDrawdownBps:100,stressHorizonMedianBps:150,holdoutReturnBps:500,windowCount:5,curve:{dates:['a','b','c'],strategy:[1,1.01,1.03]},verdict:'ELIGIBLE',reasons:[],specHash:'cd'.repeat(32),recommendedOnTraining:i===0}))};
  return {owner,strategy,input:{version:'xtxc-research-agent/1',owner:`solana:${owner}`,strategy,goal,briefHash:c.briefHash},result:{...result,reportHash:reportHash(result)},runId:'fixture-run',updatedAt};
 };
 return {c,binding,signature,research,strategy,ownerPair,walletPair};
}
export async function preparedTrade(x,leg,counter=0) {
 const wallet=x.c.wallet,mint=leg.mint;
 const nonce=(await getProgramDerivedAddress({programAddress:STOCKMESH,seeds:[Buffer.from('stocklana'),keyBytes(wallet)]}))[0];
 const ata=async m=>(await getProgramDerivedAddress({programAddress:'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',seeds:[keyBytes(wallet),keyBytes(TOKEN),keyBytes(m)]}))[0];
 const src=await ata(leg.side==='BUY'?USDC:mint),dst=await ata(leg.side==='BUY'?mint:USDC);
 const accounts=[wallet,nonce,src,leg.side==='BUY'?USDC:mint,TOKEN,dst,leg.side==='BUY'?mint:USDC,key(111)];
 const d=Buffer.alloc(65);d.set([2,2,1,0]);d.writeBigUInt64LE(BigInt(counter),4);d.writeBigUInt64LE(BigInt(leg.inputAtoms),12);d.writeBigUInt64LE(BigInt(leg.minimumOutputAtoms),20);d.writeBigUInt64LE(999999999n,28);d.set([2,3,4,5,6,4],36);d.set([0,0,1,1],42);d.writeBigUInt64LE(BigInt(leg.inputAtoms),46);d[54]=7;d[55]=9;d.set([0,2,3,4,5,6,7,2,3],56);
 const cu=Buffer.from([2,0x40,0x0d,0x03,0]),price=Buffer.alloc(9);price[0]=3;
 const ix=[{programAddress:COMPUTE,accounts:[],data:cu},{programAddress:COMPUTE,accounts:[],data:price},{programAddress:STOCKMESH,accounts:accounts.map((address,i)=>({address,role:i===0?3:[1,2,5].includes(i)?1:0})),data:d}];
 const unsigned=policyTransaction(wallet,ix,{blockhash:key(201+counter),lastValidBlockHeight:'9999999'}).transactionBase64;
 const tx=getTransactionDecoder().decode(Buffer.from(unsigned,'base64'));
 const signed=Buffer.from(getTransactionEncoder().encode({...tx,signatures:{[wallet]:sign(null,Buffer.from(tx.messageBytes),x.walletPair.privateKey)}})).toString('base64');
 return {prepared:{owner:wallet,quoteId:`q${counter}`,preparedId:`p${counter}`,submitAllowed:true,transactionBase64:unsigned,expiresAt:new Date(Date.now()+120000).toISOString()},signed,signature:verifyExactSignature(unsigned,signed,wallet)};
}
export const observation=(c,cash,holdings=[],slot=100)=>({owner:c.wallet,cashAtoms:String(cash),holdings, equityAtoms:String(BigInt(cash)+holdings.reduce((n,h)=>n+BigInt(h.valueAtoms),0n)),stateSlot:slot,balanceHash:'fixture-balance-hash',observedAt:new Date().toISOString()});
export function finalReceipt(order,signed,before,after,slot=1000) {
 const indexes=[order.facts.keys.indexOf(order.facts.source),order.facts.keys.indexOf(order.facts.destination)];
 const b=(index,mint,n)=>({accountIndex:index,mint,owner:order.wallet,uiTokenAmount:{amount:String(n)}});
 const [sourceMint,destMint]=order.facts.side==='BUY'?[USDC,order.facts.mint]:[order.facts.mint,USDC];
 return {genesisHash:MAINNET,status:{confirmationStatus:'finalized',slot,err:null},tx:{slot,transaction:[signed,'base64'],meta:{err:null,fee:Number(order.facts.networkFeeLamports),preTokenBalances:[b(indexes[0],sourceMint,before[0]),b(indexes[1],destMint,before[1])],postTokenBalances:[b(indexes[0],sourceMint,after[0]),b(indexes[1],destMint,after[1])]}}};
}
