import {hash,reject} from './research-agent-core.mjs';
// Separate verifier of the calculation/approval boundary. No model can upgrade it.
export function auditEvaluation(result,input){
 if(!result||!Array.isArray(result.candidates)||result.candidates.length<3||result.candidates.length>6||new Set(result.candidates.map(c=>c.id)).size!==result.candidates.length)reject('Invalid research candidate set.');
 const checks=[];
 for(const c of result.candidates){
  if(c.weights.some(w=>!input.strategy.instruments.includes(w.instrument)||!Number.isSafeInteger(w.weightBps)||w.weightBps<0||w.weightBps>input.goal.maxWeightBps)||new Set(c.weights.map(w=>w.instrument)).size!==c.weights.length||c.weights.reduce((n,w)=>n+w.weightBps,0)>10000-input.goal.minCashBps)reject('Calculated weights violate research limits.');
  if(!['horizonMedianBps','holdoutDrawdownBps','stressHorizonMedianBps','holdoutReturnBps'].every(k=>Number.isSafeInteger(c[k]))||c.windowCount<3||!Array.isArray(c.curve?.dates)||c.curve.strategy.length!==c.curve.dates.length||c.curve.strategy.some(x=>!Number.isFinite(x)||x<=0))reject('Calculated research evidence is invalid.');
  const pass=c.horizonMedianBps>=input.goal.targetReturnBps&&c.holdoutDrawdownBps<=input.goal.maxDrawdownBps&&(c.fullDrawdownBps??0)<=input.goal.maxDrawdownBps&&c.stressHorizonMedianBps>=input.goal.targetReturnBps&&c.holdoutReturnBps>0&&c.weights.length>0;
  if(c.verdict==='ELIGIBLE'&&(!pass||c.reasons.length))reject('A failed calculation cannot authorize a strategy.');
  checks.push({candidateId:c.id,verdict:c.verdict,checks:['universe','integer_weights','concentration','cash','holdout','cost_stress','finite_curve'],specHash:c.specHash});
 }
 const decision=result.candidates.some(c=>c.verdict==='ELIGIBLE')?'REVIEW':'DECLINED';
 if(result.decision!==decision)reject('The research decision differs from its candidates.');
 return{schema:'xtxc.independent-evaluation-check/v1',decision,checks,inputHash:hash(input),resultHash:hash(result)};
}
