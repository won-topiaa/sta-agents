#!/usr/bin/env node
// XTXC BNB gateway: the only process that talks to the Binance Web3 API and the Agentic Wallet CLI.
// It runs where Binance service is permitted (team machine in Korea now; a Seoul VPS later) and
// serves a narrow, token-authenticated JSON API to the app over loopback / an SSH tunnel.
// It never holds a user's private key: personal-wallet trades come back unsigned, and Agentic
// Wallet orders run under the limits the owner set in the Binance app.
import http from 'node:http';
import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {web3Client,rwa,trading,transaction,wallet,BSC_USDT,BSC_USDC} from '../lib/binance-web3.mjs';
import {checkApproval,checkSwap,checkSimulation,checkSlippage,isAddress,sameAddress,BSC_ROUTER,ExecutionCheckError} from '../lib/bsc-execution.mjs';

const env=k=>process.env[k];
function readEnvFile(path){return Object.fromEntries(readFileSync(path,'utf8').split('\n').filter(l=>/^[A-Z0-9_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));}
const RPC=env('BSC_RPC_URL')||'https://bsc-dataseed.bnbchain.org';
const STABLES=[BSC_USDT,BSC_USDC];

export function createGateway({client,rpc=rpcCall,baw=bawRun,token,now=Date.now,log=()=>{},maxStable=200n*10n**18n,minGasWei=300000000000000n}){
  let universe=null;
  async function tokens(){
    if(universe&&now()-universe.at<300000)return universe;
    const rows=[];
    for(const platformId of ['bstock','ondo'])for(const t of await rwa.tokens(client,platformId))rows.push({
      platform:platformId,contract:t.tokenContractAddress,symbol:t.tokenSymbol,name:t.tokenName,decimals:Number(t.decimals),
      underlying:String(t.underlyingTicker).toUpperCase(),ratio:String(t.tokenToShareRatio),assetType:t.assetType,
      status:{reason:t.statusInfo?.reasonCode??'UNKNOWN',market:t.statusInfo?.marketStatus??null,nextOpen:t.statusInfo?.nextOpenTime??null,nextClose:t.statusInfo?.nextCloseTime??null},
      tokenPrice:t.tokenPrice,referencePrice:t.referencePrice});
    universe={at:now(),observedAt:new Date(now()).toISOString(),tokens:rows};return universe;
  }
  const known=async addr=>STABLES.some(s=>sameAddress(s,addr))||(await tokens()).tokens.some(t=>sameAddress(t.contract,addr));
  async function allowance(owner,tokenAddr){
    const data='0xdd62ed3e'+owner.toLowerCase().slice(2).padStart(64,'0')+BSC_ROUTER.toLowerCase().slice(2).padStart(64,'0');
    return BigInt(await rpc('eth_call',[{to:tokenAddr,data},'latest']));
  }
  // One leg, two steps: an exact approval when needed, then a fresh quote -> swap -> dry run.
  async function prepare({user,fromToken,toToken,amount,slippagePercent='1'}){
    if(!isAddress(user)||!isAddress(fromToken)||!isAddress(toToken)||sameAddress(fromToken,toToken))throw new ExecutionCheckError('INPUT','Check the wallet and tokens.');
    if(!/^\d{1,40}$/.test(String(amount))||BigInt(amount)<=0n)throw new ExecutionCheckError('INPUT','Check the amount.');
    checkSlippage(slippagePercent);
    if(!await known(fromToken)||!await known(toToken)||!(STABLES.some(s=>sameAddress(s,fromToken))||STABLES.some(s=>sameAddress(s,toToken))))
      throw new ExecutionCheckError('TOKEN','Only stablecoin ↔ listed stock token swaps are allowed.');
    const buying=STABLES.some(s=>sameAddress(s,fromToken));
    if(buying&&BigInt(amount)>maxStable)throw new ExecutionCheckError('LIMIT','This gateway caps a single purchase leg.');
    const stock=(await tokens()).tokens.find(t=>sameAddress(t.contract,buying?toToken:fromToken));
    if(stock&&stock.status.reason!=='TRADING')throw new ExecutionCheckError('MARKET',`${stock.symbol} is not trading now (${stock.status.reason}).`);
    const routes=await trading.quote(client,{amount:String(amount),fromTokenAddress:fromToken,toTokenAddress:toToken,userWalletAddress:user});
    const route=(Array.isArray(routes)?routes:[]).find(r=>r.isBest)??routes?.[0];
    if(!route)throw new ExecutionCheckError('NO_ROUTE','No route for this trade now.');
    const quote={vendor:route.vendorName,toTokenAmount:String(route.toTokenAmount),priceImpactPercent:route.priceImpactPercent,quotedAt:new Date(now()).toISOString()};
    // Never ask a wallet to sign something that cannot succeed: gas first, then the input token.
    const bnb=BigInt(await rpc('eth_getBalance',[user,'latest']));
    if(bnb<minGasWei)throw new ExecutionCheckError('NO_GAS',`Add a little BNB to this wallet for network fees (at least ${Number(minGasWei)/1e18} BNB).`);
    const held=BigInt(await rpc('eth_call',[{to:fromToken,data:'0x70a08231'+user.toLowerCase().slice(2).padStart(64,'0')},'latest']));
    if(held<BigInt(amount))throw new ExecutionCheckError('NO_FUNDS',`This step needs ${(Number(BigInt(amount)/10n**12n)/1e6).toFixed(2)} of the input token; the wallet holds ${(Number(held/10n**12n)/1e6).toFixed(2)}.`);
    if(await allowance(user,fromToken)<BigInt(amount)){
      // The approval names the vendor of the route it is for (required for equity tokens).
      const built=await trading.approve(client,{tokenContractAddress:fromToken,approveAmount:String(amount),vendor:route.vendorName});
      return {step:'APPROVE',tx:checkApproval(built,{user,token:fromToken,amount:String(amount)}),quote};
    }
    const built=await trading.swap(client,{amount:String(amount),fromTokenAddress:fromToken,toTokenAddress:toToken,userWalletAddress:user,quoteId:route.quoteId,slippagePercent:String(slippagePercent)});
    const tx=checkSwap(built,{user,fromToken,toToken,amount:String(amount),quotedOut:String(route.toTokenAmount),slippagePercent});
    const sim=checkSimulation(await transaction.simulate(client,{from:tx.from,to:tx.to,value:tx.value,data:tx.data}),{user,toToken,minReceiveAmount:tx.minReceiveAmount});
    return {step:'SWAP',tx,quote,simulation:sim,preparedId:randomUUID()};
  }
  async function txStatus(hash){
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new ExecutionCheckError('INPUT','Check the transaction hash.');
    const [tx,receipt]=await Promise.all([rpc('eth_getTransactionByHash',[hash]),rpc('eth_getTransactionReceipt',[hash])]);
    let indexed=null;try{indexed=await transaction.detail(client,hash);}catch{/* indexing lags; the chain receipt is authoritative */}
    return {hash,tx:tx&&{from:tx.from,to:tx.to,input:tx.input,value:BigInt(tx.value).toString(),nonce:tx.nonce},
      receipt:receipt&&{status:receipt.status==='0x1'?'SUCCESS':'FAILED',blockNumber:parseInt(receipt.blockNumber,16),gasUsed:BigInt(receipt.gasUsed).toString()},
      indexed:indexed?{txStatus:indexed.txStatus??null}:null};
  }
  // Agentic Wallet: fixed commands only, always --json, arguments as an array (no shell).
  const agentic={
    status:()=>baw(['wallet','status']),address:()=>baw(['wallet','address']),settings:()=>baw(['wallet','settings']),quota:()=>baw(['wallet','left-quota']),
    signin:()=>baw(['auth','signin']),verify:qrCodeId=>{if(!/^[A-Za-z0-9][A-Za-z0-9-]{3,79}$/.test(qrCodeId))throw new ExecutionCheckError('INPUT','Invalid QR id.');return baw(['auth','verify','--qrCodeId',qrCodeId],330000);},
    async swap({fromToken,toToken,fromTokenQty}){
      if(!/^\d{1,12}(\.\d{1,18})?$/.test(String(fromTokenQty))||Number(fromTokenQty)<=0)throw new ExecutionCheckError('INPUT','Check the amount.');
      if(!await known(fromToken)||!await known(toToken)||!(STABLES.some(s=>sameAddress(s,fromToken))||STABLES.some(s=>sameAddress(s,toToken))))throw new ExecutionCheckError('TOKEN','Only stablecoin ↔ listed stock token swaps are allowed.');
      return baw(['market-order','swap','--binanceChainId','56','--fromToken',fromToken,'--toToken',toToken,'--fromTokenQty',String(fromTokenQty),'--slippage','auto','--mev','true'],120000);
    },
    order:orderId=>{if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(orderId))throw new ExecutionCheckError('INPUT','Invalid order id.');return baw(['market-order','list','--orderId',orderId]);},
  };
  const routes={
    'GET /v1/health':async()=>({ok:true,router:BSC_ROUTER}),
    'GET /v1/universe':async()=>tokens(),
    'POST /v1/prepare':body=>prepare(body),
    'GET /v1/tx':(_,q)=>txStatus(q.get('hash')??''),
    'GET /v1/nonce':async(_,q)=>{const a=q.get('address')??'';if(!isAddress(a))throw new ExecutionCheckError('INPUT','Check the address.');return {address:a,pending:BigInt(await rpc('eth_getTransactionCount',[a,'pending'])).toString()};},
    'GET /v1/balances':async(_,q)=>{const a=q.get('address')??'';if(!isAddress(a))throw new ExecutionCheckError('INPUT','Check the address.');return wallet.balances(client,a);},
    'GET /v1/agentic/status':()=>agentic.status(),'GET /v1/agentic/address':()=>agentic.address(),
    'GET /v1/agentic/settings':()=>agentic.settings(),'GET /v1/agentic/quota':()=>agentic.quota(),
    'POST /v1/agentic/signin':()=>agentic.signin(),'POST /v1/agentic/verify':body=>agentic.verify(String(body?.qrCodeId??'')),
    'POST /v1/agentic/swap':body=>agentic.swap(body??{}),'GET /v1/agentic/order':(_,q)=>agentic.order(q.get('orderId')??''),
  };
  return http.createServer(async(req,res)=>{
    const started=Date.now(),url=new URL(req.url,'http://gateway'),key=`${req.method} ${url.pathname}`;
    const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));log({at:new Date(started).toISOString(),route:key,status,ms:Date.now()-started,code:body?.error?.code});};
    const auth=Buffer.from(String(req.headers.authorization??'')),want=Buffer.from(`Bearer ${token}`);
    if(auth.length!==want.length||!timingSafeEqual(auth,want))return send(401,{error:{code:'UNAUTHORIZED',message:'Gateway token required.'}});
    const handler=routes[key];if(!handler)return send(404,{error:{code:'NOT_FOUND',message:'Unknown gateway route.'}});
    let body=null;
    if(req.method==='POST'){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>16000)return send(413,{error:{code:'TOO_LARGE',message:'Request too large.'}});chunks.push(c);}
      try{body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};}catch{return send(400,{error:{code:'BAD_JSON',message:'Invalid JSON.'}});}}
    try{send(200,{data:await handler(body,url.searchParams)});}
    catch(e){send(e instanceof ExecutionCheckError?422:502,{error:{code:e.code??'UPSTREAM',message:String(e.message??'Gateway error').slice(0,300),httpStatus:e.httpStatus}});}
  });
}

async function rpcCall(method,params){
  const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  const j=await r.json();if(j.error)throw new Error(`RPC ${method}: ${j.error.message}`);return j.result;
}
function bawRun(args,timeout=60000){
  return new Promise((resolve,reject)=>{
    execFile(env('BAW_NODE')||process.execPath,[env('BAW_BIN'),...args,'--json'],{timeout,maxBuffer:1_000_000,env:{PATH:process.env.PATH,HOME:env('BAW_HOME'),BAW_DIR:env('BAW_DIR')}},(err,stdout)=>{
      let parsed=null;try{parsed=JSON.parse(stdout);}catch{/* fall through */}
      if(parsed&&parsed.success!==false)return resolve(parsed.data??parsed);
      reject(new ExecutionCheckError('AGENTIC',String(parsed?.error?.message??parsed?.message??err?.message??'Agentic Wallet command failed.').slice(0,300)));
    });
  });
}

if(process.argv[1]?.endsWith('server.mjs')){
  const keys=readEnvFile(env('BINANCE_ENV_FILE')),gw=readEnvFile(env('GATEWAY_ENV_FILE'));
  const evidence=env('DX_CALLS_FILE');if(evidence)mkdirSync(evidence.replace(/\/[^/]+$/,''),{recursive:true});
  const client=web3Client({apiKey:keys.BINANCE_WEB3_API_KEY,secretKey:keys.BINANCE_WEB3_SECRET_KEY,observe:e=>evidence&&appendFileSync(evidence,JSON.stringify(e)+'\n')});
  const port=Number(env('GATEWAY_PORT')||4590);
  createGateway({client,token:gw.GATEWAY_TOKEN}).listen(port,'127.0.0.1',()=>console.log(`bnb gateway on 127.0.0.1:${port}`));
}
