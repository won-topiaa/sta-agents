import {randomUUID} from 'node:crypto';
import {briefHash,hash,reject} from './research-agent-core.mjs';
import {selectedSnapshot,checkedSellQuote,atomsDecimal,boundedMap} from './research-rebalance.mjs';

export async function valueWatch(portfolio,owner,instruments,quote){
 const snapshot=selectedSnapshot(portfolio,owner,instruments);
 const values=await boundedMap(snapshot.holdings.filter(h=>BigInt(h.atoms)>0n),async h=>{
  const q=await quote({instrument:h.instrument,side:'SELL',notional:atomsDecimal(h.atoms,h.rawDecimals),notionalAsset:'USDC',productMint:h.mint,maxSlippageBps:20});
  return{instrument:h.instrument,mint:h.mint,atoms:h.atoms,minimumCashAtoms:String(checkedSellQuote(q,h,h.atoms))};
 });
 return{balanceHash:snapshot.balanceHash,observedAt:Date.now(),scope:'SELECTED_STOCKS_AND_WALLET_USDC',cashAtoms:snapshot.cashAtoms,holdings:values,valueAtoms:String(values.reduce((a,v)=>a+BigInt(v.minimumCashAtoms),BigInt(snapshot.cashAtoms))),method:'CURRENT_HELD_PRODUCT_SELL_MINIMUM'};
}

export function watchTransition(previous,observation,maxLossBps){
 const value=BigInt(observation.valueAtoms),before=previous?.observation;
 const changed=before&&before.balanceHash!==observation.balanceHash;
 if(!previous||!before)return{status:'WATCHING',baselineAtoms:String(value),highWaterAtoms:String(value),drawdownBps:0,observation,startedAt:observation.observedAt,points:[{at:observation.observedAt,valueAtoms:String(value)}]};
 // Deposits, withdrawals and trades cannot be misrepresented as investment returns.
 if(changed||previous.status==='HOLDINGS_CHANGED')return{...previous,status:'HOLDINGS_CHANGED',observation,checkedAt:Date.now(),reason:'Restart monitoring to approve the changed holdings baseline.'};
 const high=value>BigInt(previous.highWaterAtoms)?value:BigInt(previous.highWaterAtoms),loss=high===0n?0:Number((high-value)*10000n/high);
 return{...previous,status:loss>=maxLossBps?'RISK_REVIEW_REQUIRED':'WATCHING',highWaterAtoms:String(high),drawdownBps:loss,observation,error:undefined,points:[...(previous.points??[]),{at:observation.observedAt,valueAtoms:String(value)}].slice(-672)};
}

export class HoldingsWatch {
 constructor(store,portfolio,quote){this.store=store;this.portfolio=portfolio;this.quote=quote;}
 async run(owner,strategyId){
  const s=this.store,key=s.owner(owner),strategy=s.get(key,strategyId);
  const claim=s.transaction(()=>{
   const r=s.db.prepare('SELECT document FROM agent_monitors WHERE owner=? AND strategy=?').get(key,strategyId);if(!r)return null;
   const m=JSON.parse(r.document);
   if(!m.enabled||m.expiresAt<=Date.now()||briefHash(strategy)!==m.briefHash||m.watchNextAt>Date.now())return null;
   const id=randomUUID();m.watchClaim=id;m.watchNextAt=Date.now()+900000;
   s.db.prepare('UPDATE agent_monitors SET document=? WHERE owner=? AND strategy=?').run(JSON.stringify(m),key,strategyId);return{id,monitor:m};
  });
  if(!claim)return{checked:false};
  let observation,error;
  try{
   observation=await valueWatch(await this.portfolio({owner:owner.slice(7)}),owner.slice(7),strategy.instruments,this.quote);
   const final=selectedSnapshot(await this.portfolio({owner:owner.slice(7)}),owner.slice(7),strategy.instruments);
   if(final.balanceHash!==observation.balanceHash)reject('Holdings changed during observation.',409);
  }catch{error='Holdings or sell values could not be refreshed. No action was taken.';}
  return s.transaction(()=>{
   const m=JSON.parse(s.db.prepare('SELECT document FROM agent_monitors WHERE owner=? AND strategy=?').get(key,strategyId)?.document??'null');
   if(!m?.enabled||m.watchClaim!==claim.id||m.expiresAt<=Date.now()||briefHash(s.get(key,strategyId))!==m.briefHash)return{checked:false};
   if(error)m.watch={...m.watch,status:'DATA_UNAVAILABLE',error,checkedAt:Date.now()};
   else{
    const prior=m.watch?.status;
    // A quote outage must not silently reset the high-water mark or cash-flow fence.
    const old=m.watch?.status==='DATA_UNAVAILABLE'?{...m.watch,status:m.watch.resumeStatus??'WATCHING'}:m.watch;
    m.watch=watchTransition(old,observation,m.goal.maxDrawdownBps);
    if(m.watch.status!==prior)s.event(key,strategyId,m.watch.status,{drawdownBps:m.watch.drawdownBps,scope:observation.scope});
   }
   if(error)m.watch.resumeStatus=claim.monitor.watch?.resumeStatus??claim.monitor.watch?.status;
   s.db.prepare('UPDATE agent_monitors SET document=? WHERE owner=? AND strategy=?').run(JSON.stringify(m),key,strategyId);
   return{checked:!error,status:m.watch.status};
  });
 }
}
