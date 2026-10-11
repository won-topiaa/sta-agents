export type AgentChoice={style:string;preset:string;matched:boolean;profile:any;fallback:any;added:{id:string;params:Record<string,unknown>;evidence:string}[]};
export function chooseAgentPreset(text:string):{style:string;preset:string;matched:boolean};
export function agentForRequest(text:string,suggestions?:any[]):AgentChoice;
export function describeAgent(agent:AgentChoice,usedFallback?:boolean):string;
