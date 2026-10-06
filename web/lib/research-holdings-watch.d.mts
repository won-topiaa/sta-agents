import type {AgentStore} from './research-agent-core.mjs';
export class HoldingsWatch {constructor(store:AgentStore,portfolio:(body:any)=>Promise<any>,quote:(body:any)=>Promise<any>);run(owner:string,strategyId:string):Promise<{checked:boolean;status?:string}>;}
