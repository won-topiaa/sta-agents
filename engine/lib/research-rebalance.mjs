import { hash, budgetAtoms, reject } from './research-agent-core.mjs';
const uint=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,23})$/.test(x)?BigInt(x):reject('Invalid portfolio amount.');
const min=(a,b)=>a<b?a:b;
export async function boundedMap(rows,fn){const results=new Array(rows.length);let next=0;const until=Date.now()+75000;await Promise.all(Array.from({length:Math.min(2,rows.length)},async()=>{while(next<rows.length){if(Date.now()>until)reject('Holdings valuation timed out. Try a smaller selection.',503);const index=next++;results[index]=await fn(rows[index]);}}));return results;}
export const atomsDecimal=(amount,decimals=6)=>{if(!Number.isSafeInteger(decimals)||decimals<0||decimals>12)reject('Invalid token precision.');const n=uint(amount),unit=10n**BigInt(decimals);return decimals?`${n/unit}.${(n%unit).toString().padStart(decimals,'0')}`:String(n);};
export function selectedSnapshot(portfolio,owner,instruments,now=Date.now()){
 if(portfolio.owner!==owner||portfolio.network!=='mainnet-beta'||!Number.isFinite(Date.parse(portfolio.observedAt))||now-Date.parse(portfolio.observedAt)>30000||Date.parse(portfolio.observedAt)>now+3000)reject('Refresh wallet holdings before reviewing this plan.',409);
 const cash=portfolio.cash?.find(c=>c.symbol==='USDC');if(!cash)reject('USDC balance is unavailable.',409);uint(cash.atoms);
 if(portfolio.otherStockHoldingsTruncated||portfolio.otherStockHoldings?.some(h=>instruments.includes(h.instrument)))reject('A selected stock has an unsupported held product. Choose a supported holdings scope.',409);
 const holdings=portfolio.holdings.filter(h=>instruments.includes(h.instrument)).map(h=>({instrument:h.instrument,mint:h.mint,productId:h.productId,rawDecimals:h.rawDecimals,atoms:h.atoms})).sort((a,b)=>a.mint<b.mint?-1:1);
 if(holdings.length>64||new Set(holdings.map(h=>h.mint)).size!==holdings.length)reject('Selected holdings exceed the supported review scope.',409);
 for(const h of holdings){uint(h.atoms);atomsDecimal(h.atoms,h.rawDecimals);}
 const balances={cashAtoms:cash.atoms,holdings};return{...balances,owner,observedAt:portfolio.observedAt,stateSlot:portfolio.stateSlot,balanceHash:hash(balances)};
}
export function checkedSellQuote(q,h,amount,now=Date.now()){
 if(q.schema!=='skew.stockmesh.liquidation-quote/v1'||q.side!=='SELL'||q.instrument!==h.instrument||q.inputProduct?.mint!==h.mint||q.inputProduct?.inputAtoms!==amount||q.output?.symbol!=='USDC'||q.output?.decimals!==6||Date.parse(q.expiresAt)<=now)reject('A held-product sell quote is not current.',409);
 if(uint(q.output.minimumAtoms)<=0n||uint(q.output.estimatedAtoms)<uint(q.output.minimumAtoms))reject('Invalid held-product value.',409);
 return uint(q.output.minimumAtoms);
}
export async function rebalanceAllocation(strategy,candidate,portfolio,quote,now=Date.now()){
 const owner=portfolio.owner,snapshot=selectedSnapshot(portfolio,owner,strategy.instruments,now),additional=uint(budgetAtoms(strategy.budget));
 if(uint(snapshot.cashAtoms)<additional)reject('Additional cash exceeds your refreshed USDC balance.',409);
 const sell=async(h,amount)=>{const q=await quote({instrument:h.instrument,side:'SELL',inputAtoms:amount,notional:atomsDecimal(amount,h.rawDecimals),notionalAsset:'USDC',maxSlippageBps:20,productMint:h.mint});return{quote:q,value:checkedSellQuote(q,h,amount)};};
 // Bounded and owner-triggered; no catalog-wide RPC polling or invented stock prices.
 const valued=await boundedMap(snapshot.holdings.filter(h=>uint(h.atoms)>0n),async h=>{const v=await sell(h,h.atoms);return{...h,valueAtoms:String(v.value),quoteId:v.quote.quoteId};});
 const heldTotal=valued.reduce((s,h)=>s+uint(h.valueAtoms),0n),total=additional+heldTotal;
 const weights=new Map(candidate.weights.map(w=>[w.instrument,w.weightBps]));
 if([...weights].some(([i,w])=>!strategy.instruments.includes(i)||!Number.isSafeInteger(w)||w<0)||[...weights.values()].reduce((a,b)=>a+b,0)>10000)reject('Invalid target allocation.');
 const values=new Map(strategy.instruments.map(i=>[i,valued.filter(h=>h.instrument===i).reduce((s,h)=>s+uint(h.valueAtoms),0n)]));
 const targets=new Map(strategy.instruments.map(i=>[i,total*BigInt(weights.get(i)??0)/10000n]));
 const sales=[],remaining=new Map(values);let proceeds=0n;
 for(const instrument of strategy.instruments){let excess=(values.get(instrument)??0n)-(targets.get(instrument)??0n);if(excess<=0n)continue;
  for(const h of valued.filter(h=>h.instrument===instrument)){if(excess<=0n)break;const amount=uint(h.atoms)*min(excess,uint(h.valueAtoms))/uint(h.valueAtoms);if(amount===0n)continue;const actual=await sell(h,String(amount));
   sales.push({instrument,side:'SELL',inputAtoms:String(amount),inputDecimals:h.rawDecimals,productMint:h.mint,minimumCashAtoms:String(actual.value)});proceeds+=actual.value;
   const removedValue=uint(h.valueAtoms)*amount/uint(h.atoms);remaining.set(instrument,remaining.get(instrument)-removedValue);excess-=removedValue;
  }
 }
 const cashTarget=total-[...targets.values()].reduce((a,b)=>a+b,0n);
 if(additional+proceeds<cashTarget)reject('Quoted sales cannot preserve the target cash reserve. Refresh the review.',409);
 const capacity=additional+proceeds-cashTarget;
 const deficits=strategy.instruments.map(i=>({instrument:i,amount:(targets.get(i)??0n)-(remaining.get(i)??0n)})).filter(x=>x.amount>0n),sum=deficits.reduce((s,h)=>s+h.amount,0n);
 const buys=deficits.map(h=>({instrument:h.instrument,side:'BUY',inputDecimals:6,inputAtoms:String(sum>capacity?h.amount*capacity/sum:h.amount)})).filter(h=>uint(h.inputAtoms)>0n);
 const spent=buys.reduce((s,h)=>s+uint(h.inputAtoms),0n);
 return{budgetScope:'SELECTED_HOLDINGS_PLUS_NEW_CASH',legs:[...sales,...buys],cashAtoms:String(additional+proceeds-spent),cashFloorAtoms:String(uint(snapshot.cashAtoms)-additional+cashTarget),portfolioValueAtoms:String(total),heldValueAtoms:String(heldTotal),snapshot,valuations:valued,valuationMethod:'CURRENT_HELD_PRODUCT_SELL_MINIMUM',createdAt:Date.now(),expiresAt:Date.now()+60000};
}
export function assertStepFunds(plan,index,portfolio,executionWallet=plan.owner.slice(7)){
 if(plan.snapshot?.owner&&plan.snapshot.owner!==executionWallet)reject('This allocation belongs to a different execution wallet.',409);
 const now=selectedSnapshot(portfolio,executionWallet,plan.universe??plan.legs.map(l=>l.instrument));
 if(plan.snapshot&&index===0&&now.balanceHash!==plan.snapshot.balanceHash)reject('Your holdings changed since review. Rebuild this allocation.',409);
 const leg=plan.legs[index];
 if(leg.side==='SELL'){
  const held=now.holdings.find(h=>h.mint===leg.productMint&&h.instrument===leg.instrument&&h.rawDecimals===leg.inputDecimals);
  if(!held||uint(held.atoms)<uint(leg.inputAtoms))reject('The approved stock quantity is no longer available.',409);
 }else if(uint(now.cashAtoms)<uint(leg.inputAtoms)+uint(plan.cashFloorAtoms??'0'))reject('This purchase would consume cash outside the approved allocation.',409);
 return now;
}
