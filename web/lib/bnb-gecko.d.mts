export type GeckoMarket={pool:string;contract:string;chainId:56;priceUsd:number;liquidityUsd:number;poolVolume24hUsd:number|null;change24h:number|null;dex:string;observedAt:string;source:'GeckoTerminal'};
export type BinancePrice={priceUsd:number;referencePriceUsd:number|null;observedAt:string;source:'Binance Web3 RWA Data'};
export type GeckoResponse={status:'AVAILABLE'|'REFERENCE'|'NO_POOL'|'UNAVAILABLE'|'RATE_LIMITED';market:GeckoMarket|null;retryAfter:number;binance?:BinancePrice;mapping?:{contract:string;productId:string;state:string;coinId:string|null;underlyingChart?:{symbol:string;kind:'UNDERLYING_STOCK_NOT_TOKEN_PRICE'}|null;checkedAt:string|null;stale:boolean}};
export function selectGeckoMarket(payload:unknown,contract:string,observedAt?:string):GeckoMarket|null;
export function geckoEmbedUrl(pool:string,resolution?:string):string;
export function createGeckoReader(options?:Record<string,unknown>):(contract:string)=>Promise<GeckoResponse>;
