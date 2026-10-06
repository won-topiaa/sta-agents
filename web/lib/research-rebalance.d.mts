import type { ResearchStrategy } from './research-workspace';
import type { AgentPlan, ResearchCandidate, RebalanceDraft } from './research-agent-types';
export function atomsDecimal(amount:string,decimals?:number):string;
export function rebalanceAllocation(strategy:ResearchStrategy,candidate:ResearchCandidate,portfolio:unknown,quote:(input:any)=>Promise<any>):Promise<Omit<RebalanceDraft,'id'|'runId'|'candidateId'|'reportHash'>&{snapshot:{balanceHash:string}}>;
export function selectedSnapshot(portfolio:unknown,owner:string,instruments:string[]):{balanceHash:string};
export function assertStepFunds(plan:AgentPlan,index:number,portfolio:unknown):unknown;
