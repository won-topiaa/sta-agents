import {createHmac} from 'node:crypto';

// Binance Web3 API (https://web3.binance.com/build) — signed REST client for BSC.
// Auth (dev-docs/authentication): X-OC-APIKEY, X-OC-TIMESTAMP (ISO-8601 with ms) and
// X-OC-SIGN = Base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath + body)),
// where requestPath includes the /build prefix and the raw query string, and body is
// '' for GET. Responses are {code, msg, data, timestamp, success}; code 0 is success.
// No private key ever goes to this API: it returns unsigned transactions or typed data.
export const WEB3_BASE='https://web3.binance.com';
export const BUILD_PREFIX='/build';
export const BSC='56';
export const BSC_USDT='0x55d398326f99059fF775485246999027B3197955';
export const BSC_USDC='0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';
const MAX_BODY=2_000_000;

export class Web3ApiError extends Error {
  constructor(code,message,httpStatus=0){super(message);this.code=String(code);this.httpStatus=httpStatus;}
  get retryable(){return this.httpStatus===429||this.code==='42900'||this.httpStatus>=500;}
}
export function signature(secret,timestamp,method,requestPath,body=''){
  return createHmac('sha256',secret).update(timestamp+method.toUpperCase()+requestPath+body).digest('base64');
}
// Raw query in insertion order; values are strings exactly as signed.
export function query(params={}){
  const entries=Object.entries(params).filter(([,v])=>v!==undefined&&v!==null);
  return entries.length?'?'+entries.map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&'):'';
}
async function boundedJSON(response){
  const reader=response.body?.getReader();if(!reader)throw new Web3ApiError('EMPTY','Binance Web3 API returned no body.',response.status);
  const chunks=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>MAX_BODY){await reader.cancel();throw new Web3ApiError('TOO_LARGE','Binance Web3 API response exceeds limit.',response.status);}chunks.push(r.value);}}
  finally{reader.releaseLock();}
  const text=Buffer.concat(chunks).toString();
  try{return JSON.parse(text);}catch{throw new Web3ApiError('NOT_JSON',`Binance Web3 API returned non-JSON (HTTP ${response.status}).`,response.status);}
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

/**
 * @param {{apiKey:string,secretKey:string,fetcher?:typeof fetch,now?:()=>Date,observe?:(e:object)=>void,retries?:number,minIntervalMs?:number}} config
 * `observe` receives one record per HTTP attempt (method, path, status, code, ms): used for
 * latency/error evidence, never for secrets.
 */
export function web3Client({apiKey,secretKey,fetcher=fetch,now=()=>new Date(),observe=()=>{},retries=2,minIntervalMs=220}){
  if(!apiKey||!secretKey)throw new Web3ApiError('NO_KEY','Binance Web3 API key is not configured.');
  const lastCall=new Map();   // documented default: 5 requests/second per endpoint
  async function call(method,path,{params,body}={}){
    if(!path.startsWith('/api/'))throw new Web3ApiError('BAD_PATH','Unsupported Binance Web3 API path.');
    const requestPath=BUILD_PREFIX+path+query(params),payload=body===undefined?'':JSON.stringify(body);
    for(let attempt=0;;attempt++){
      const wait=(lastCall.get(path)??0)+minIntervalMs-Date.now();if(wait>0)await sleep(wait);lastCall.set(path,Date.now());
      const timestamp=now().toISOString(),started=Date.now();
      let status=0,code='NETWORK',msg='';
      try{
        const response=await fetcher(WEB3_BASE+requestPath,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{
          'X-OC-APIKEY':apiKey,'X-OC-TIMESTAMP':timestamp,'X-OC-SIGN':signature(secretKey,timestamp,method,requestPath,payload),
          ...(payload?{'Content-Type':'application/json'}:{}),'User-Agent':'xtxc-sta/1'},...(payload?{body:payload}:{})});
        status=response.status;const json=await boundedJSON(response);
        code=String(json?.code??'UNKNOWN');msg=String(json?.msg??'');
        if(status===200&&code==='0')return json.data;
        throw new Web3ApiError(code,msg||`Binance Web3 API error (HTTP ${status}).`,status);
      }catch(e){
        const err=e instanceof Web3ApiError?e:new Web3ApiError('NETWORK',e?.name==='TimeoutError'?'Binance Web3 API timed out.':'Binance Web3 API is unreachable.',status);
        code=err.code;msg=err.message;
        if(!err.retryable||attempt>=retries)throw err;
        await sleep(500*2**attempt);
      }finally{observe({at:new Date(started).toISOString(),method,path,status,code,msg:code==='0'?'':msg.slice(0,300),ms:Date.now()-started});}
    }
  }
  return {get:(path,params)=>call('GET',path,{params}),post:(path,body)=>call('POST',path,{body})};
}

// ---- typed helpers (paths and fields from the Binance Web3 API reference) ----
export const rwa={
  platforms:c=>c.get('/api/v1/dex/market/rwa/platforms',{binanceChainId:BSC}),
  tokens:(c,platformId,extra={})=>c.get('/api/v1/dex/market/rwa/tokens',{binanceChainId:BSC,platformId,...extra}),
  price:(c,addresses)=>c.get('/api/v1/dex/market/rwa/price',{binanceChainId:BSC,tokenContractAddresses:addresses.join(',')}),
  underlyingMarket:(c,params)=>c.get('/api/v1/dex/market/rwa/underlying-market',{binanceChainId:BSC,...params}),
};
export const trading={
  quote:(c,{amount,fromTokenAddress,toTokenAddress,userWalletAddress})=>c.get('/api/v1/dex/aggregator/quote',{binanceChainId:BSC,amount,fromTokenAddress,toTokenAddress,userWalletAddress}),
  swap:(c,{amount,fromTokenAddress,toTokenAddress,userWalletAddress,quoteId,slippagePercent})=>c.get('/api/v1/dex/aggregator/swap',{binanceChainId:BSC,amount,fromTokenAddress,toTokenAddress,userWalletAddress,quoteId,slippagePercent}),
  approve:(c,{tokenContractAddress,approveAmount,vendor})=>c.get('/api/v1/dex/aggregator/approve-transaction',{binanceChainId:BSC,tokenContractAddress,approveAmount,vendor}),
  submitOrder:(c,{requestId,userSignature,vendor,quoteId})=>c.post('/api/v1/dex/aggregator/order/submit',{requestId,userSignature,vendor,quoteId}),
  order:(c,orderId)=>c.get(`/api/v1/dex/aggregator/order/${encodeURIComponent(orderId)}`),
};
export const transaction={
  simulate:(c,evmTx)=>c.post('/api/v1/dex/pre-transaction/simulate',{binanceChainId:BSC,evmTx}),
  detail:(c,txHash)=>c.get('/api/v1/dex/post-transaction/transaction-detail-by-txhash',{binanceChainId:BSC,txHash}),
};
export const wallet={
  balances:(c,address,extra={})=>c.get('/api/v1/dex/balance/all-token-balances-by-address',{binanceChainId:BSC,address,...extra}),
};
