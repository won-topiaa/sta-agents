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
import {checkApproval,checkSwap,checkSimulation,checkSlippage,isAddress,sameAddress,BSC_ROUTER,MAX_GAS,ExecutionCheckError} from '../lib/bsc-execution.mjs';

const env=k=>process.env[k];
function readEnvFile(path){return Object.fromEntries(readFileSync(path,'utf8').split('\n').filter(l=>/^[A-Z0-9_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).trim()]));}
const RPC=env('BSC_RPC_URL')||'https://bsc-dataseed.bnbchain.org';
const STABLES=[BSC_USDT,BSC_USDC];

// Adapters that fill a swap from a market maker's signed, seconds-long order (address hex, lower case, no 0x).
const RFQ_ADAPTERS=['7977f3e8e063a4ee95b5f396d63485dbdea4515d'];
export function createGateway({client,rpc=rpcCall,baw=bawRun,token,now=Date.now,log=()=>{},maxStable=200n*10n**18n,minGasWei=300000000000000n}){
  if(typeof token!=='string'||!token)throw new Error('The gateway needs a token.');
  let universe=null,loading=null;
  async function tokens(){
    if(universe&&now()-universe.at<30000)return universe;   // trading status changes at the open and close
    if(loading)return loading;   // one refresh at a time, however many requests arrive
    loading=refreshTokens().finally(()=>{loading=null;});
    return loading;
  }
  async function refreshTokens(){
    const rows=[];
    for(const platformId of ['bstock','ondo'])for(const t of await rwa.tokens(client,platformId))rows.push({
      platform:platformId,contract:t.tokenContractAddress,symbol:t.tokenSymbol,name:t.tokenName,decimals:Number(t.decimals),
      underlying:String(t.underlyingTicker).toUpperCase(),ratio:String(t.tokenToShareRatio),assetType:t.assetType,
      status:{reason:t.statusInfo?.reasonCode??'UNKNOWN',market:t.statusInfo?.marketStatus??null,nextOpen:t.statusInfo?.nextOpenTime??null,nextClose:t.statusInfo?.nextCloseTime??null},
      tokenPrice:t.tokenPrice,referencePrice:t.referencePrice});
    universe={at:now(),observedAt:new Date(now()).toISOString(),tokens:rows};return universe;
  }
  const known=async addr=>STABLES.some(s=>sameAddress(s,addr))||(await tokens()).tokens.some(t=>sameAddress(t.contract,addr));
  // Exactly one side is a stablecoin and the other a listed stock token; returns true for a purchase.
  async function pair(fromToken,toToken){
    const fromStable=STABLES.some(s=>sameAddress(s,fromToken)),toStable=STABLES.some(s=>sameAddress(s,toToken));
    if(fromStable===toStable||!await known(fromToken)||!await known(toToken))
      throw new ExecutionCheckError('TOKEN','Only stablecoin ↔ listed stock token swaps are allowed.');
    return fromStable;
  }
  const atoms18=qty=>{const [i,f='']=String(qty).split('.');return BigInt(i)*10n**18n+BigInt((f+'0'.repeat(18)).slice(0,18));};
  const dec18=a=>{const w=a/10n**18n,f=(a%10n**18n).toString().padStart(18,'0').replace(/0+$/,'');return f?`${w}.${f}`:`${w}`;};
  // Stock tokens: one token is `ratio` shares (tokenToShareRatio). The Agentic Wallet CLI takes and reports stock-token
  // quantities in shares, so sales convert tokens -> shares (rounded down: the CLI refuses an amount whose tokens exceed
  // the balance) and fills convert shares -> tokens (rounded down).
  const ratioAtoms=stock=>{const r=atoms18(String(stock.ratio??'1'));if(r<=0n)throw new ExecutionCheckError('TOKEN','This token has no share ratio.');return r;};
  const tokensToShares=(tokenAtoms,stock)=>dec18((tokenAtoms*ratioAtoms(stock))/10n**18n);
  const sharesToTokenAtoms=(shares,stock)=>(atoms18(shares)*10n**18n)/ratioAtoms(stock);
  // An independent price check: the route's price may not be worse than the token's listed price (tokenPrice, which is
  // the underlying share price x ratio) by more than MAX_DEVIATION, and the route's own price impact stays small.
  const MAX_DEVIATION=0.03,MAX_IMPACT_PERCENT=2;
  function priceBound(stock,buying,payAtoms,getAtoms){
    const ref=Number(stock?.tokenPrice),dec=Number(stock?.decimals??18);
    if(!(ref>0))throw new ExecutionCheckError('PRICE','No reference price for this token right now.');
    const tokens=Number(buying?getAtoms:payAtoms)/10**dec,usd=Number(buying?payAtoms:getAtoms)/1e18;
    if(!(tokens>0&&usd>0))throw new ExecutionCheckError('PRICE','This quote has no usable price.');
    const implied=usd/tokens,off=buying?implied/ref-1:1-implied/ref;
    if(off>MAX_DEVIATION)throw new ExecutionCheckError('PRICE',`This route prices ${stock.symbol} ${(off*100).toFixed(1)}% worse than its listed price ($${ref.toFixed(2)}). Try again later.`);
    return {implied,reference:ref};
  }
  function impactBound(route){const v=Number(route?.priceImpactPercent);if(Number.isFinite(v)&&Math.abs(v)>MAX_IMPACT_PERCENT)throw new ExecutionCheckError('PRICE',`Price impact ${v}% is above ${MAX_IMPACT_PERCENT}%. Try a smaller amount.`);}
  async function allowance(owner,tokenAddr){
    const data='0xdd62ed3e'+owner.toLowerCase().slice(2).padStart(64,'0')+BSC_ROUTER.toLowerCase().slice(2).padStart(64,'0');
    return BigInt(await rpc('eth_call',[{to:tokenAddr,data},'latest']));
  }
  // One leg, two steps: an exact approval when needed, then a fresh quote -> swap -> dry run.
  async function prepare({user,fromToken,toToken,amount,slippagePercent='1'}){
    if(!isAddress(user)||!isAddress(fromToken)||!isAddress(toToken)||sameAddress(fromToken,toToken))throw new ExecutionCheckError('INPUT','Check the wallet and tokens.');
    if(!/^\d{1,40}$/.test(String(amount))||BigInt(amount)<=0n)throw new ExecutionCheckError('INPUT','Check the amount.');
    checkSlippage(slippagePercent);
    const buying=await pair(fromToken,toToken);
    if(buying&&BigInt(amount)>maxStable)throw new ExecutionCheckError('LIMIT','This gateway caps a single purchase leg.');
    const stock=(await tokens()).tokens.find(t=>sameAddress(t.contract,buying?toToken:fromToken));
    if(!stock||stock.status.reason!=='TRADING')throw new ExecutionCheckError('MARKET',`${stock?.symbol??'This token'} is not trading now (${stock?.status?.reason??'UNLISTED'}).`);
    const routes=await trading.quote(client,{amount:String(amount),fromTokenAddress:fromToken,toTokenAddress:toToken,userWalletAddress:user});
    const route=(Array.isArray(routes)?routes:[]).find(r=>r.isBest)??routes?.[0];
    if(!route)throw new ExecutionCheckError('NO_ROUTE','No route for this trade now.');
    if(route.executionMode&&route.executionMode!=='SWAP')throw new ExecutionCheckError('MODE','This route cannot be signed as a swap now. Try again later.');
    impactBound(route);const price=priceBound(stock,buying,BigInt(amount),BigInt(String(route.toTokenAmount)));
    const stable=sameAddress(buying?fromToken:toToken,BSC_USDT)?'USDT':'USDC';
    const quote={vendor:route.vendorName,fromAmount:String(amount),fromSymbol:buying?stable:stock?.symbol,toTokenAmount:String(route.toTokenAmount),
      toSymbol:buying?stock?.symbol:stable,toDecimals:buying?stock?.decimals:18,priceImpactPercent:route.priceImpactPercent,impliedPrice:price.implied,referencePrice:price.reference,quotedAt:new Date(now()).toISOString()};
    // Never ask a wallet to sign something that cannot succeed: gas first, then the input token. The live quote is
    // still returned, so an unfunded wallet sees the route and price it would get.
    const unfunded=(code,message)=>Object.assign(new ExecutionCheckError(code,message),{quote});
    const bnb=BigInt(await rpc('eth_getBalance',[user,'latest']));
    if(bnb<minGasWei)throw unfunded('NO_GAS',`Add a little BNB to this wallet for network fees (at least ${Number(minGasWei)/1e18} BNB).`);
    const held=BigInt(await rpc('eth_call',[{to:fromToken,data:'0x70a08231'+user.toLowerCase().slice(2).padStart(64,'0')},'latest']));
    if(held<BigInt(amount))throw unfunded('NO_FUNDS',`This step needs ${(Number(BigInt(amount)/10n**12n)/1e6).toFixed(2)} of the input token; the wallet holds ${(Number(held/10n**12n)/1e6).toFixed(2)}.`);
    if(await allowance(user,fromToken)!==BigInt(amount)){
      // Exactly this leg: a missing, smaller or larger allowance (e.g. an unlimited one left by another app) is set to
      // the exact amount first. The approval names the vendor of the route it is for (required for equity tokens).
      const built=await trading.approve(client,{tokenContractAddress:fromToken,approveAmount:String(amount),vendor:route.vendorName});
      return {step:'APPROVE',tx:checkApproval(built,{user,token:fromToken,amount:String(amount)}),quote};
    }
    // A market-maker (RFQ) leg carries a signed order that expires seconds after the quote, before a person can confirm
    // it in a wallet (2026-10-08: three hand-signed swaps through RFQ adapter 0x7977…515d reverted RFQ_OrderExpired;
    // the six without it filled). Such a route gives way to the next-best one; with none left, nothing is signed.
    const others=(Array.isArray(routes)?routes:[]).filter(r=>r!==route&&(!r.executionMode||r.executionMode==='SWAP'))
      .sort((a,b)=>BigInt(String(b.toTokenAmount))>BigInt(String(a.toTokenAmount))?1:-1);
    let tx=null,chosen=null;
    for(const [i,r] of [route,...others].slice(0,3).entries()){
      let t;
      try{
        if(i>0){impactBound(r);priceBound(stock,buying,BigInt(amount),BigInt(String(r.toTokenAmount)));}
        const built=await trading.swap(client,{amount:String(amount),fromTokenAddress:fromToken,toTokenAddress:toToken,userWalletAddress:user,quoteId:r.quoteId,slippagePercent:String(slippagePercent)});
        t=checkSwap(built,{user,fromToken,toToken,amount:String(amount),quotedOut:String(r.toTokenAmount),slippagePercent});
      }catch(e){if(i===0)throw e;continue;}   // the best route's refusal stands; a weaker alternative is just skipped
      if(RFQ_ADAPTERS.some(a=>t.data.toLowerCase().includes(a)))continue;
      tx=t;chosen=r;break;
    }
    if(!tx)throw unfunded('RFQ','Only a market-maker route is available right now, and its quote expires before a wallet can sign. Try again in a minute.');
    if(chosen!==route){
      const p=priceBound(stock,buying,BigInt(amount),BigInt(String(chosen.toTokenAmount)));
      Object.assign(quote,{vendor:chosen.vendorName,toTokenAmount:String(chosen.toTokenAmount),priceImpactPercent:chosen.priceImpactPercent,impliedPrice:p.implied});
    }
    const sim=checkSimulation(await transaction.simulate(client,{from:tx.from,to:tx.to,value:tx.value,data:tx.data}),
      {user,fromToken,toToken,amount:String(amount),minReceiveAmount:tx.minReceiveAmount});
    // The route's gas figure can be far too low for stock tokens (a 250k limit ran out on a swap that needs ~1.2M), so
    // the wallet gets the node's own estimate plus 30%, never less than the route asked for.
    let estimate;try{estimate=BigInt(await rpc('eth_estimateGas',[{from:tx.from,to:tx.to,value:'0x0',data:tx.data},'latest']));}
    catch{throw new ExecutionCheckError('GAS','The network could not estimate this swap. Get a new quote.');}
    const gas=estimate*13n/10n>BigInt(tx.gas)?estimate*13n/10n:BigInt(tx.gas);
    if(gas>MAX_GAS)throw new ExecutionCheckError('GAS','The transaction asks for an unusual amount of gas.');
    return {step:'SWAP',tx:{...tx,gas:gas.toString()},quote,simulation:sim,preparedId:randomUUID()};
  }
  // On-chain balances of listed stock tokens (balanceOf), for whole-holding sales. Only known tokens, at most 40.
  async function holdings(address,list){
    if(!isAddress(address))throw new ExecutionCheckError('INPUT','Check the address.');
    const tokens=[...new Set(String(list??'').split(',').map(t=>t.trim().toLowerCase()).filter(Boolean))];
    if(!tokens.length||tokens.length>40||tokens.some(t=>!isAddress(t)))throw new ExecutionCheckError('INPUT','Check the token list.');
    for(const t of tokens)if(!await known(t)||STABLES.some(s=>sameAddress(s,t)))throw new ExecutionCheckError('TOKEN','Only listed stock tokens can be read here.');
    const data='0x70a08231'+address.toLowerCase().slice(2).padStart(64,'0'),out=[];
    for(let i=0;i<tokens.length;i+=8)out.push(...await Promise.all(tokens.slice(i,i+8).map(async t=>({contract:t,raw:BigInt(await rpc('eth_call',[{to:t,data},'latest'])).toString()}))));
    return {address,observedAt:new Date(now()).toISOString(),holdings:out};
  }
  async function txStatus(hash){
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new ExecutionCheckError('INPUT','Check the transaction hash.');
    const [tx,receipt]=await Promise.all([rpc('eth_getTransactionByHash',[hash]),rpc('eth_getTransactionReceipt',[hash])]);
    let indexed=null;try{indexed=await transaction.detail(client,hash);}catch{/* indexing lags; the chain receipt is authoritative */}
    return {hash,tx:tx&&{from:tx.from,to:tx.to,input:tx.input,value:BigInt(tx.value).toString(),nonce:tx.nonce},
      receipt:receipt&&{status:receipt.status==='0x1'?'SUCCESS':'FAILED',blockNumber:parseInt(receipt.blockNumber,16),gasUsed:BigInt(receipt.gasUsed).toString()},
      indexed:indexed?{txStatus:indexed.txStatus??null}:null};
  }
  let selfCache=null;
  async function agenticBscAddress(){
    if(selfCache&&now()-selfCache.at<600000)return selfCache.address;
    const r=await baw(['wallet','address']),list=Array.isArray(r?.addresses)?r.addresses:[];
    const a=list.find(x=>String(x.binanceChainId)==='56')?.address??list.find(x=>isAddress(x.address))?.address;
    if(!isAddress(a))throw new ExecutionCheckError('AGENTIC_UNKNOWN','The Agentic Wallet address could not be read.');
    selfCache={at:now(),address:a};return a;
  }
  // Fills of stock-token purchases in token atoms (the CLI reports shares).
  async function withTokenFills(r){
    const list=Array.isArray(r)?r:r?.list??r?.orders??(r?[r]:[]),rows=(await tokens()).tokens;
    for(const o of list){const stock=rows.find(t=>sameAddress(t.contract,o?.toToken));
      if(stock&&/^\d+(\.\d+)?$/.test(String(o.toTokenActualQty??'')))o.filledTokenAtoms=sharesToTokenAtoms(String(o.toTokenActualQty),stock).toString();}
    return r;
  }
  // Agentic Wallet: fixed commands only, always --json, arguments as an array (no shell).
  const submitted=new Map();   // order id a swap returned -> its tokens (see order below)
  const agentic={
    status:()=>baw(['wallet','status']),address:()=>baw(['wallet','address']),settings:()=>baw(['wallet','settings']),quota:()=>baw(['wallet','left-quota']),
    // Signing out ends the CLI session, so a new QR sign-in can renew it (signin answers ALREADY_CONNECTED otherwise).
    signin:()=>baw(['auth','signin']),signout:()=>baw(['auth','signout']),verify:qrCodeId=>{if(!/^[A-Za-z0-9][A-Za-z0-9-]{3,79}$/.test(qrCodeId))throw new ExecutionCheckError('INPUT','Invalid QR id.');return baw(['auth','verify','--qrCodeId',qrCodeId],330000);},
    // The same limits as a hand-signed leg: listed pair, purchase cap, trading status, bounded slippage.
    async swap({fromToken,toToken,fromTokenQty,slippagePercent='1'}){
      if(!/^\d{1,12}(\.\d{1,18})?$/.test(String(fromTokenQty))||Number(fromTokenQty)<=0)throw new ExecutionCheckError('INPUT','Check the amount.');
      if(!isAddress(fromToken)||!isAddress(toToken))throw new ExecutionCheckError('INPUT','Check the tokens.');
      const buying=await pair(fromToken,toToken),slippage=checkSlippage(slippagePercent);
      if(buying&&atoms18(fromTokenQty)>maxStable)throw new ExecutionCheckError('LIMIT','This gateway caps a single purchase leg.');
      const stock=(await tokens()).tokens.find(t=>sameAddress(t.contract,buying?toToken:fromToken));
      if(!stock||stock.status.reason!=='TRADING')throw new ExecutionCheckError('MARKET',`${stock?.symbol??'This token'} is not trading now.`);
      if(!buying&&Number(stock.decimals)!==18)throw new ExecutionCheckError('TOKEN','Only 18-decimal tokens are sold from the Agentic Wallet.');
      // The same independent price check as a hand-signed leg, on a fresh quote for the Agentic Wallet's own address.
      const payAtoms=atoms18(fromTokenQty),self=await agenticBscAddress();
      const routes=await trading.quote(client,{amount:payAtoms.toString(),fromTokenAddress:fromToken,toTokenAddress:toToken,userWalletAddress:self});
      const route=(Array.isArray(routes)?routes:[]).find(r=>r.isBest)??routes?.[0];
      if(!route)throw new ExecutionCheckError('NO_ROUTE','No route for this trade now.');
      impactBound(route);priceBound(stock,buying,payAtoms,BigInt(String(route.toTokenAmount)));
      const qty=buying?String(fromTokenQty):tokensToShares(payAtoms,stock);   // the CLI reads a stock-token amount as shares
      const r=await baw(['market-order','swap','--binanceChainId','56','--fromToken',fromToken,'--toToken',toToken,'--fromTokenQty',qty,
        '--slippage',String(slippage),'--mev','true'],120000);
      if(r?.orderId!=null)submitted.set(String(r.orderId),{fromToken,toToken});
      return r;
    },
    // The swap can return a market order's id with its last digits off (2026-10-08: 26100800001950611986 for the record
    // booked as 26100800001950612010, 26100800001950643492 for 26100800001950643456): the same double, so precision is
    // lost before the id reaches us. An exact miss takes the one record whose id is the same double, narrowed by the
    // swap's tokens when this gateway sent it, and reports it under the submitted id. Two candidates left: still pending.
    order:async orderId=>{if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(orderId))throw new ExecutionCheckError('INPUT','Invalid order id.');
      const exact=await baw(['market-order','list','--orderId',orderId]),listOf=r=>Array.isArray(r)?r:r?.list??r?.orders??[];
      if(listOf(exact).length||!/^\d{16,40}$/.test(orderId))return withTokenFills(exact);
      const want=Number(orderId),mine=submitted.get(orderId);
      const near=listOf(await baw(['market-order','list'])).filter(o=>/^\d{16,40}$/.test(String(o?.orderId??''))&&Number(o.orderId)===want
        &&(!mine||sameAddress(o.fromToken,mine.fromToken)&&sameAddress(o.toToken,mine.toToken)));
      return withTokenFills(near.length===1?{total:1,list:[{...near[0],orderId,bookedOrderId:near[0].orderId}]}:exact);},
  };
  const routes={
    'GET /v1/health':async()=>({ok:true,router:BSC_ROUTER}),
    'GET /v1/universe':async()=>tokens(),
    'POST /v1/prepare':body=>prepare(body),
    'GET /v1/tx':(_,q)=>txStatus(q.get('hash')??''),
    'GET /v1/nonce':async(_,q)=>{const a=q.get('address')??'';if(!isAddress(a))throw new ExecutionCheckError('INPUT','Check the address.');return {address:a,pending:BigInt(await rpc('eth_getTransactionCount',[a,'pending'])).toString()};},
    'GET /v1/holdings':(_,q)=>holdings(q.get('address')??'',q.get('tokens')),
    'GET /v1/balances':async(_,q)=>{const a=q.get('address')??'';if(!isAddress(a))throw new ExecutionCheckError('INPUT','Check the address.');return wallet.balances(client,a);},
    'GET /v1/agentic/status':()=>agentic.status(),'GET /v1/agentic/address':()=>agentic.address(),
    'GET /v1/agentic/settings':()=>agentic.settings(),'GET /v1/agentic/quota':()=>agentic.quota(),
    'POST /v1/agentic/signin':()=>agentic.signin(),'POST /v1/agentic/signout':()=>agentic.signout(),'POST /v1/agentic/verify':body=>agentic.verify(String(body?.qrCodeId??'')),
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
    catch(e){send(e?.code==='AGENTIC_UNKNOWN'?504:e instanceof ExecutionCheckError?422:502,{error:{code:e.code??'UPSTREAM',message:String(e.message??'Gateway error').slice(0,300),httpStatus:e.httpStatus,...(e.quote?{quote:e.quote}:{}),...(e.orderId?{orderId:e.orderId}:{})}});}
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
      // A command succeeded only if it exited cleanly AND said so. The CLI's own message is passed on; the process error
      // (command line, stderr) is not, since it names local paths.
      if(!err&&parsed&&parsed.success!==false)return resolve(parsed.data??parsed);
      // Killed by the timeout, ended by a signal, or a clean exit we cannot read: an order may have been placed.
      if(err?.killed||err?.signal||(!err&&!parsed))return reject(new ExecutionCheckError('AGENTIC_UNKNOWN','The Agentic Wallet did not answer clearly; an order may exist.'));
      const message=typeof parsed?.error?.message==='string'?parsed.error.message:typeof parsed?.message==='string'?parsed.message:'Agentic Wallet command failed.';
      const orderId=parsed?.error?.data?.orderId??parsed?.data?.orderId;
      reject(Object.assign(new ExecutionCheckError('AGENTIC',message.slice(0,200)),orderId?{orderId:String(orderId).slice(0,80)}:{}));
    });
  });
}

if(process.argv[1]?.endsWith('server.mjs')){
  const keys=readEnvFile(env('BINANCE_ENV_FILE')),gw=readEnvFile(env('GATEWAY_ENV_FILE'));
  const evidence=env('DX_CALLS_FILE');if(evidence)mkdirSync(evidence.replace(/\/[^/]+$/,''),{recursive:true});
  const client=web3Client({apiKey:keys.BINANCE_WEB3_API_KEY,secretKey:keys.BINANCE_WEB3_SECRET_KEY,observe:e=>evidence&&appendFileSync(evidence,JSON.stringify(e)+'\n')});
  const port=Number(env('GATEWAY_PORT')||4590);
  if(typeof gw.GATEWAY_TOKEN!=='string'||gw.GATEWAY_TOKEN.length<32){console.error('GATEWAY_TOKEN (32+ characters) is missing from GATEWAY_ENV_FILE; not starting.');process.exit(1);}
  const requests=evidence?evidence.replace(/[^/]+$/,'gateway-requests.jsonl'):null;   // route, status, ms and error code only
  createGateway({client,token:gw.GATEWAY_TOKEN,log:e=>requests&&appendFileSync(requests,JSON.stringify(e)+'\n')}).listen(port,'127.0.0.1',()=>console.log(`bnb gateway on 127.0.0.1:${port}`));
}
