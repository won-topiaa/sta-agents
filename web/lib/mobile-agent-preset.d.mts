export type AgentChoice={style:string;preset:string;matched:boolean;funds:boolean;profile:any;fallback:any;added:{id:string;params:Record<string,unknown>;evidence:string}[]};
export function chooseAgentPreset(...texts:string[]):{style:string;preset:string;matched:boolean};
export function asksForRules(text:string):boolean;
export function agentForRequest(texts:string|string[],suggestions?:any[],options?:{fundsOnly?:boolean}):AgentChoice;
export function describeAgent(agent:AgentChoice,saved?:any,options?:{reused?:boolean}):string;
