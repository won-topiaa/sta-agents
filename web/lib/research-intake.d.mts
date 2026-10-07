import type {ResearchBrief} from './research-workspace';
import type {ResearchGoal} from './research-agent-types';
import type {AgentStore} from './research-agent-core.mjs';
export type ResearchIntake={brief:ResearchBrief;goal:ResearchGoal;missing:string[];unavailable:string[];universeSource?:'STARTER_RESEARCH'|'YOUR_REQUEST';defaults:string[];executionChain:'solana:mainnet'|'eip155:56';evidenceChain:'solana:devnet'|'eip155:56';authority:'RESEARCH_DRAFT_ONLY';trace:{model:string;promptHash:string;responseHash:string;inputTokens:number;outputTokens:number;latencyMs:number}};
export function intakeContext(value:unknown,allowed:readonly string[]):{brief:ResearchBrief;goal:ResearchGoal;missing:string[]}|null;
export type IntakeCatalog={themes:Readonly<Record<string,readonly string[]>>;starter:readonly string[];executionChain:ResearchIntake['executionChain'];evidenceChain:ResearchIntake['evidenceChain']};
export const CATALOGS:{solana:IntakeCatalog;bsc:IntakeCatalog};
export function interpretResearch(text:string,allowed:readonly string[],context:{brief:ResearchBrief;goal:ResearchGoal;missing?:string[]}|null,config:NodeJS.ProcessEnv,store:AgentStore,fetcher?:typeof fetch,selected?:string[],catalog?:IntakeCatalog):Promise<ResearchIntake>;
