import type {ResearchBrief} from './research-workspace';
import type {ResearchGoal} from './research-agent-types';
import type {AgentStore} from './research-agent-core.mjs';
export type ResearchIntake={brief:ResearchBrief;goal:ResearchGoal;missing:string[];unavailable:string[];universeSource?:'STARTER_RESEARCH'|'YOUR_REQUEST';defaults:string[];executionChain:'solana:mainnet';evidenceChain:'solana:devnet';authority:'RESEARCH_DRAFT_ONLY';trace:{model:string;promptHash:string;responseHash:string;inputTokens:number;outputTokens:number;latencyMs:number}};
export function intakeContext(value:unknown,allowed:readonly string[]):{brief:ResearchBrief;goal:ResearchGoal;missing:string[]}|null;
export function interpretResearch(text:string,allowed:readonly string[],context:{brief:ResearchBrief;goal:ResearchGoal;missing?:string[]}|null,config:NodeJS.ProcessEnv,store:AgentStore,fetcher?:typeof fetch,selected?:string[]):Promise<ResearchIntake>;
