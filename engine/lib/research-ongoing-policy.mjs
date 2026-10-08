import {createPublicKey, verify} from 'node:crypto';
import {canonical, hash, integer, keyBytes, USDC, SYSTEM, requirePolicy as need} from './research-autonomy-policy.mjs';
import {validateGoal} from './research-agent-core.mjs';

export const ONGOING_SCHEMA = 'sta.operating-mandate/v1';
export const OPERATING_DOMAIN = 'STA continuing trading authority v1\n';
const keys = ['schema','id','owner','wallet','strategyId','briefHash','executionChain','startsAt','expiresAt',
  'capitalAtoms','buyTurnoverAtoms','perBuyAtoms','maxOrders','feeBudgetLamports','maxSlippageBps',
  'maxLossBps','minCashBps','maxWeightBps','rebalanceBandBps','minTradeAtoms','pollMs','maxResearchAgeMs',
  'riskAction','riskReductionBps','assets','goal'];

// This is an owner-signed permission enforced by the isolated Privy gate. It
// does not claim that a devnet account enforces mainnet trading authority.
export function validateOperatingMandate(c) {
  need(c && Object.keys(c).every(k=>keys.includes(k)) && keys.every(k=>Object.hasOwn(c,k)), 'INVALID_OPERATING_MANDATE');
  need(c.schema===ONGOING_SCHEMA && c.executionChain==='solana:mainnet', 'WRONG_CHAIN');
  keyBytes(c.owner); keyBytes(c.wallet);
  need(c.owner!==c.wallet && c.owner!==SYSTEM && c.wallet!==SYSTEM, 'INVALID_AUTHORITY');
  need(/^[a-f0-9]{64}$/.test(c.id) && !/^0+$/.test(c.id) && /^[a-f0-9]{64}$/.test(c.briefHash), 'INVALID_HASH');
  need(typeof c.strategyId==='string' && /^[a-f0-9-]{36}$/.test(c.strategyId), 'INVALID_STRATEGY');
  const start=integer(c.startsAt), end=integer(c.expiresAt);
  need(end===0n || end>start, 'INVALID_EXPIRY');
  need(integer(c.capitalAtoms)>0n && integer(c.buyTurnoverAtoms)>0n && integer(c.perBuyAtoms)>0n &&
    integer(c.perBuyAtoms)<=integer(c.buyTurnoverAtoms) && integer(c.perBuyAtoms)<=integer(c.capitalAtoms) &&
    integer(c.maxOrders)>0n && integer(c.minTradeAtoms)>0n, 'INVALID_LIMITS');
  if(c.feeBudgetLamports!==null) need(integer(c.feeBudgetLamports)>0n, 'INVALID_FEE_BUDGET');
  for(const [k,min,max] of [['maxSlippageBps',1,100],['maxLossBps',1,10000],['minCashBps',0,10000],
    ['maxWeightBps',1,10000],['rebalanceBandBps',0,10000],['riskReductionBps',1,10000],
    ['pollMs',1000,3600000],['maxResearchAgeMs',1000,86400000]])
    need(Number.isSafeInteger(c[k]) && c[k]>=min && c[k]<=max, 'INVALID_'+k.toUpperCase());
  need(['REDUCE','LIQUIDATE'].includes(c.riskAction), 'INVALID_RISK_ACTION');
  need(Array.isArray(c.assets) && c.assets.length>=1 && c.assets.length<=64 &&
    new Set(c.assets.map(a=>a.mint)).size===c.assets.length && new Set(c.assets.map(a=>a.instrument)).size===c.assets.length, 'INVALID_UNIVERSE');
  need(integer(c.maxOrders)>BigInt(c.assets.length),'RISK_EXIT_ORDER_RESERVE');
  for(const a of c.assets) {
    need(Object.keys(a).sort().join(',')==='instrument,mint,rawDecimals' && /^[A-Z0-9.]{1,32}$/.test(a.instrument), 'INVALID_ASSET');
    keyBytes(a.mint); need(![USDC,SYSTEM].includes(a.mint) && Number.isSafeInteger(a.rawDecimals) && a.rawDecimals>=0 && a.rawDecimals<=12, 'INVALID_ASSET');
  }
  const goal=validateGoal(c.goal);
  need(canonical(goal)===canonical(c.goal) && goal.maxWeightBps<=c.maxWeightBps && goal.minCashBps>=c.minCashBps && goal.maxDrawdownBps<=c.maxLossBps, 'GOAL_OUTSIDE_MANDATE');
  return c;
}
export function operatingMessage(c) { return OPERATING_DOMAIN+canonical(validateOperatingMandate(c)); }
export function verifyOperatingSignature(c, signature) {
  need(typeof signature==='string' && signature.length<=88, 'OWNER_SIGNATURE_REQUIRED');
  const sig=Buffer.from(signature,'base64');
  need(sig.length===64 && sig.toString('base64')===signature, 'INVALID_OWNER_SIGNATURE');
  const key=createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),keyBytes(c.owner)])});
  need(verify(null,Buffer.from(operatingMessage(c)),key,sig), 'INVALID_OWNER_SIGNATURE');
  return hash(Buffer.concat([Buffer.from(operatingMessage(c)),sig]));
}
export function mandateActive(c, now=Date.now()) {
  return BigInt(Math.floor(now/1000))>=integer(c.startsAt) && (c.expiresAt==='0'||BigInt(Math.floor(now/1000))<integer(c.expiresAt));
}
