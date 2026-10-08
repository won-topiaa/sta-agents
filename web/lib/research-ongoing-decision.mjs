import {canonical, hash, integer, requirePolicy as need} from './research-autonomy-policy.mjs';
import {hash as reportHash, briefHash} from './research-agent-core.mjs';
import {auditEvaluation} from './research-evaluation-audit.mjs';
import {atomsDecimal, checkedSellQuote, boundedMap} from './research-rebalance.mjs';

export function chooseOperatingResearch(c, research, now=Date.now()) {
  need(research && research.owner===c.owner && research.strategy?.id===c.strategyId &&
    research.input?.owner===`solana:${c.owner}` &&
    briefHash(research.strategy)===c.briefHash && research.input?.briefHash===c.briefHash &&
    canonical(research.input.goal)===canonical(c.goal), 'RESEARCH_SCOPE_CHANGED');
  need(Number.isSafeInteger(research.updatedAt) && now-research.updatedAt>=0 && now-research.updatedAt<=c.maxResearchAgeMs, 'STALE_RESEARCH');
  const {reportHash:identity,...result}=research.result??{};
  need(identity===reportHash(result), 'RESEARCH_REPORT_CHANGED');
  need(canonical(research.input.strategy.instruments.slice().sort())===canonical(c.assets.map(a=>a.instrument).sort()) &&
    briefHash(research.input.strategy)===c.briefHash, 'RESEARCH_SCOPE_CHANGED');
  auditEvaluation(result,research.input);
  const candidates=result.candidates.filter(x=>x.verdict==='ELIGIBLE').sort((a,b)=>
    Number(b.recommendedOnTraining===true)-Number(a.recommendedOnTraining===true)||a.id.localeCompare(b.id));
  return {reportHash:identity, candidate:candidates[0]??null, datasetId:result.dataset?.id??null};
}
export function checkedOperatingPortfolio(c,p,now=Date.now()) {
  need(p?.schema==='skew.stockmesh.portfolio/v1' && p.owner===c.wallet && p.network==='mainnet-beta' &&
    Number.isSafeInteger(p.stateSlot) && p.stateSlot>0 && Number.isFinite(Date.parse(p.observedAt)) &&
    now-Date.parse(p.observedAt)<=30000 && Date.parse(p.observedAt)<=now+1000 &&
    Array.isArray(p.cash) && Array.isArray(p.holdings), 'FRESH_PORTFOLIO_REQUIRED');
  need(p.otherStockHoldingsTruncated!==true && !(p.otherStockHoldings?.length), 'UNSUPPORTED_HELD_ASSET');
  const cash=p.cash.filter(x=>x.symbol==='USDC'); need(cash.length===1, 'CASH_IDENTITY_REQUIRED');
  integer(cash[0].atoms);
  need(new Set(p.holdings.map(h=>h.mint)).size===p.holdings.length, 'DUPLICATE_HELD_ASSET');
  for(const h of p.holdings) {
    integer(h.atoms); if(h.atoms==='0')continue;
    need(c.assets.some(a=>a.mint===h.mint && a.instrument===h.instrument && a.rawDecimals===h.rawDecimals), 'HELD_ASSET_OUTSIDE_MANDATE');
  }
  const holdings=p.holdings.filter(h=>h.atoms!=='0').map(h=>({instrument:h.instrument,mint:h.mint,rawDecimals:h.rawDecimals,atoms:h.atoms})).sort((a,b)=>a.mint.localeCompare(b.mint));
  return {owner:c.wallet,cashAtoms:cash[0].atoms,holdings,stateSlot:p.stateSlot,observedAt:p.observedAt,
    balanceHash:hash(canonical({cashAtoms:cash[0].atoms,holdings}))};
}
export async function observeOperatingPortfolio(c,stockmesh,now=Date.now()) {
  const p=checkedOperatingPortfolio(c,await stockmesh.portfolio(c.wallet),now);
  const holdings=await boundedMap(p.holdings,async h=>{
    const q=await stockmesh.quote({instrument:h.instrument,side:'SELL',inputAtoms:h.atoms,productMint:h.mint,
      notional:atomsDecimal(h.atoms,h.rawDecimals),notionalAsset:'USDC',maxSlippageBps:c.maxSlippageBps});
    const value=checkedSellQuote(q,h,h.atoms);
    need(integer(q.output.estimatedAtoms)>0n && value>=integer(q.output.estimatedAtoms)*BigInt(10000-c.maxSlippageBps)/10000n, 'VALUATION_SLIPPAGE_MISMATCH');
    need(Number.isFinite(Date.parse(q.expiresAt)),'VALUATION_EXPIRY_REQUIRED');
    return {...h,valueAtoms:String(value),valuationExpiresAt:Date.parse(q.expiresAt)};
  });
  const fresh=checkedOperatingPortfolio(c,await stockmesh.portfolio(c.wallet));
  need(fresh.balanceHash===p.balanceHash && fresh.stateSlot>=p.stateSlot, 'PORTFOLIO_CHANGED_DURING_VALUATION');
  need(holdings.every(h=>h.valuationExpiresAt>Date.now()),'VALUATION_EXPIRED');
  return {...fresh,holdings,equityAtoms:String(holdings.reduce((n,h)=>n+integer(h.valueAtoms),integer(p.cashAtoms))),checkedAt:Date.now()};
}

// Cash-flow adjustment uses actual verified fills, then accounts separately for
// any unmatched cash movement. Unexplained stock movement freezes the next buy;
// it cannot silently reset a loss baseline or turn a transfer into profit.
export function operatingRisk(previous,observation,receipts=[],maxLossBps) {
  const equity=integer(observation.equityAtoms);
  if(!previous)return {highWaterAtoms:String(equity),drawdownBps:0,latched:false,flowAtoms:'0',observation};
  const expected=new Map(previous.observation.holdings.map(h=>[h.mint,integer(h.atoms)]));
  let cash=integer(previous.observation.cashAtoms);
  for(const r of receipts) {
    const n=expected.get(r.mint)??0n;
    if(r.phase!=='RECONCILED')continue;
    if(r.side==='BUY'){cash-=integer(r.inputAtoms);expected.set(r.mint,n+integer(r.outputAtoms));}
    else {cash+=integer(r.outputAtoms);expected.set(r.mint,n-integer(r.inputAtoms));}
  }
  const actual=new Map(observation.holdings.map(h=>[h.mint,integer(h.atoms)]));
  need([...new Set([...expected.keys(),...actual.keys()])].every(m=>(expected.get(m)??0n)===(actual.get(m)??0n)), 'EXTERNAL_STOCK_MOVEMENT');
  const flow=integer(observation.cashAtoms)-cash;
  let high=BigInt(previous.highWaterAtoms)+flow; if(high<0n)high=0n; if(equity>high)high=equity;
  const loss=high===0n?0:Number((high-equity)*10000n/high);
  return {highWaterAtoms:String(high),drawdownBps:loss,latched:previous.latched||loss>=maxLossBps,
    flowAtoms:String(BigInt(previous.flowAtoms)+flow),observation};
}
const min=(a,b)=>a<b?a:b;
export function decideOperatingTrade(c,observation,research,risk,usage) {
  const equity=integer(observation.equityAtoms), managed=min(equity,integer(c.capitalAtoms));
  const band=managed*BigInt(c.rebalanceBandBps)/10000n, dust=integer(c.minTradeAtoms);
  const target=new Map((research?.candidate?.weights??[]).map(w=>[w.instrument,w.weightBps]));
  const sales=[];
  for(const h of observation.holdings) {
    const value=integer(h.valueAtoms); if(value===0n)continue;
    if(risk.latched) {
      const keep=c.riskAction==='LIQUIDATE'?0n:integer(usage.riskTargets?.[h.mint]??'0');
      const amount=integer(h.atoms)>keep?integer(h.atoms)-keep:0n;
      if(amount>0n)sales.push({side:'SELL',instrument:h.instrument,mint:h.mint,inputAtoms:String(amount),inputDecimals:h.rawDecimals,
        minimumCashAtoms:'1',valueAtoms:String(value*amount/integer(h.atoms)),reason:'LOSS_LIMIT_EXIT'});
      continue;
    }
    const desired=research?.candidate ? managed*BigInt(target.get(h.instrument)??0)/10000n :
      min(value,managed*BigInt(c.maxWeightBps)/10000n);
    const excess=value-desired;
    if(excess<=band || excess<dust)continue;
    const amount=desired===0n?integer(h.atoms):integer(h.atoms)*excess/value;
    if(amount>0n)sales.push({side:'SELL',instrument:h.instrument,mint:h.mint,inputAtoms:String(amount),inputDecimals:h.rawDecimals,
      minimumCashAtoms:'1',valueAtoms:String(excess),reason:'REBALANCE_SELL'});
  }
  sales.sort((a,b)=>BigInt(a.valueAtoms)===BigInt(b.valueAtoms)?a.mint.localeCompare(b.mint):BigInt(a.valueAtoms)>BigInt(b.valueAtoms)?-1:1);
  if(sales.length)return {action:'TRADE',leg:sales[0]};
  if(risk.latched)return {action:'HOLD',reason:'RISK_REDUCED_CASH_HELD'};
  if(!research?.candidate)return {action:'HOLD',reason:'WAITING_ELIGIBLE_RESEARCH'};
  const remaining=integer(c.buyTurnoverAtoms)-integer(usage.buyReservedAtoms);
  if(remaining<=0n)return {action:'HOLD',reason:'BUY_TURNOVER_EXHAUSTED'};
  const cashFloor=equity-managed+managed*BigInt(c.minCashBps)/10000n;
  const available=integer(observation.cashAtoms)>cashFloor?integer(observation.cashAtoms)-cashFloor:0n;
  const buys=[];
  for(const a of c.assets) {
    const held=observation.holdings.find(h=>h.mint===a.mint),value=held?integer(held.valueAtoms):0n;
    const desired=managed*BigInt(target.get(a.instrument)??0)/10000n, deficit=desired-value;
    const amount=min(min(min(deficit,available),integer(c.perBuyAtoms)),remaining);
    if(deficit>band && amount>=dust)buys.push({side:'BUY',instrument:a.instrument,mint:a.mint,inputAtoms:String(amount),inputDecimals:6,minimumCashAtoms:'0',reason:'REBALANCE_BUY'});
  }
  buys.sort((a,b)=>BigInt(a.inputAtoms)===BigInt(b.inputAtoms)?a.mint.localeCompare(b.mint):BigInt(a.inputAtoms)>BigInt(b.inputAtoms)?-1:1);
  return buys.length?{action:'TRADE',leg:buys[0]}:{action:'HOLD',reason:'TARGET_SATISFIED'};
}
