import type {AgentStore} from './research-agent-core.mjs';
import type {AgentRule} from './research-agent-profile.mjs';
export type RuleSuggestion=AgentRule&{evidence:string};
export type RuleSuggestions={suggestions:RuleSuggestion[];unsupported:string[];trace:{model:string;promptHash:string;responseHash:string;inputTokens:number;outputTokens:number;latencyMs:number}};
export function catalogFor(style:string):{id:string;meaning:string;params:unknown}[];
export function resolveSuggestions(parsed:unknown,text:string,style:string):Omit<RuleSuggestions,'trace'>;
export function suggestRules(text:string,style:string,config:NodeJS.ProcessEnv,store:AgentStore,fetcher?:typeof fetch):Promise<RuleSuggestions>;
