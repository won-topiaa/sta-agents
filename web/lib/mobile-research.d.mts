export const RESEARCH_API:string;
export function researchState(view:any):{active:boolean;label:string;error:string|null};
export function followupQuestion(draft:any):string;
export function agentRequestId(profile:any):Promise<string>;
export function closestAgent(agents:any[],profile:any):any;
export function beginResearch(input:{api:(path:string,body?:unknown)=>Promise<any>;text:string;draft:any;chooseAgent:(draft:any)=>any;ids:{strategy:string;run:string};onDraft?:(draft:any)=>void;onStage?:(stage:string)=>void;onSaved?:(strategy:any)=>void}):Promise<any>;
