export type AgentParamSpec={default:number;display:'days'|'number'|'percent'|'count'|'dollars_log10'}&({options:number[]}|{min:number;max:number;step:number});
export type AgentRuleSpec={label:string;help:string;styles:string[];params:Record<string,AgentParamSpec>;requires?:[string,'<',string][];filter?:Record<string,unknown>;risk_off?:Record<string,unknown>;top_n_cap?:string};
export type AgentPreset={label:string;help:string;rebalance:'weekly'|'monthly';rules:{id:string;params:Record<string,number>}[]};
export type AgentStyle={label:string;help:string;available:boolean;presets:Record<string,AgentPreset>};
export type AgentRuleCatalog={schema:'xtxc.agent-rules/v1';styles:Record<string,AgentStyle>;rules:Record<string,AgentRuleSpec>;limits:{rules:number;filters:number;philosophy_chars:number;name_chars:number}};
export const AGENT_RULES:AgentRuleCatalog;
