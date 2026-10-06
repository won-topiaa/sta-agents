import type { AgentStore } from './research-agent-core.mjs';
export type AnchorRow={id:string;planId:string;owner:string;phase:string;cluster:'devnet';genesisHash:string;commitment:string;transactionBase64:string;feeLamports:string;balanceLamports:string;shortfallLamports:string;lastValidBlockHeight:number;signature?:string;receipt?:{type:'ApprovalAnchorReceipt';cluster:'devnet';signature:string;slot:number;confirmation:string;explorerUrl:string}};
export class AnchorService {
 constructor(store:AgentStore);
 list(address:string,planId:string):AnchorRow[];
 prepare(address:string,planId:string):Promise<AnchorRow>;
 submit(address:string,id:string,wire:string):Promise<AnchorRow>;
 status(address:string,id:string):Promise<AnchorRow>;
}
