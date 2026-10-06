export type BscProduct={platform:'bstock'|'ondo';contract:string;symbol:string;decimals:number;ratio:string};
export const BSC_SNAPSHOT_AT:string;
export const BSC_RESEARCH_PRODUCTS:Record<string,{bstock?:Omit<BscProduct,'platform'>;ondo?:Omit<BscProduct,'platform'>}>;
export const BSC_RESEARCH_STOCKS:readonly string[];
export function bscProduct(ticker:string):BscProduct|null;
