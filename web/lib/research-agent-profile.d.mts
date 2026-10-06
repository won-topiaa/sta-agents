import type {ResearchGoal} from './research-agent-types';
export type AgentApproval='PER_TRADE'|'AUTO_WITHIN_LIMITS';
export type AgentRule={id:string;params:Record<string,number>};
export type AgentProfileBody={name:string;style:string;preset:string;rules:AgentRule[];philosophy:string;risk:{maxWeightBps:number;minCashBps:number;maxDrawdownBps:number};rebalance:'weekly'|'monthly';approval:AgentApproval};
export type AgentProfile=AgentProfileBody&{schema:'xtxc.agent-profile/v1';id:string;revision:number};
export type AgentSnapshot={id:string;revision:number;name:string;style:string;approval:AgentApproval};
export const PROFILE_SCHEMA:'xtxc.agent-profile/v1';
export const APPROVALS:AgentApproval[];
export const REBALANCES:('weekly'|'monthly')[];
export class AgentProfileError extends Error{constructor(message:string,status?:number);status:number}
export function normalizeRule(rule:unknown,style:string):AgentRule;
export function normalizeProfile(p:unknown):AgentProfile;
export function profileBody(p:AgentProfileBody):AgentProfileBody;
export function presetBody(name:string,style?:string,preset?:string):AgentProfileBody;
export function clampGoal(goal:ResearchGoal,profile:{risk:AgentProfileBody['risk']}):ResearchGoal;
export function agentSnapshot(p:AgentProfile):AgentSnapshot;
