import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkApproval,checkSwap,checkSimulation,checkSent,word,BSC_ROUTER} from '../lib/bsc-execution.mjs';
import {createGateway} from '../bnb-gateway/server.mjs';
import {BSC_USDT} from '../lib/binance-web3.mjs';

const user='0x1111111111111111111111111111111111111111',stock='0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
const amount=(25n*10n**18n).toString(),hex=v=>BigInt(v).toString(16).padStart(64,'0');
// Shapes copied from real responses on 2026-10-06 (quote/swap/approve/simulate, BSC).
const swapData='0xad43f73d'+word(BSC_USDT)+word(stock)+hex(amount)+'00'.repeat(32);
const built=(over={})=>({executionMode:'SWAP',routerResult:{},rfq:null,tx:{from:user,to:BSC_ROUTER,data:swapData,value:'0',gas:'450000',gasPrice:'61001241',minReceiveAmount:'102579451137036454',...over}});
const approval=amt=>({0:{data:'0x095ea7b3'+word(BSC_ROUTER)+hex(amt),dexContractAddress:BSC_ROUTER,gasLimit:'70000',gasPrice:'54432143'}});
const leg={user,fromToken:BSC_USDT,toToken:stock,amount,quotedOut:'103615607209127732',slippagePercent:'1'};

test('approvals must be exact-amount and name the router',()=>{
  assert.equal(checkApproval(approval(amount),{user,token:BSC_USDT,amount}).to,BSC_USDT);
  assert.throws(()=>checkApproval(approval((2n**256n-1n).toString()),{user,token:BSC_USDT,amount}),/exact amount/);
  assert.throws(()=>checkApproval({0:{...approval(amount)[0],dexContractAddress:'0x9999999999999999999999999999999999999999'}},{user,token:BSC_USDT,amount}),/spender/);
});

test('swaps must spend exactly the leg, at the router, with a sane minimum',()=>{
  assert.equal(checkSwap(built(),leg).minReceiveAmount,'102579451137036454');
  const bad=[[{from:'0x2222222222222222222222222222222222222222'},/not for your wallet/],[{to:'0x3333333333333333333333333333333333333333'},/unexpected contract/],
    [{value:'1'},/send BNB/],[{data:'0xdeadbeef'+swapData.slice(10)},/Unrecognised/],[{data:swapData.replace(word(stock),word(user))},/output token/],
    [{data:swapData.replace(hex(amount),hex(amount+'0'))},/amount/],[{minReceiveAmount:'1'},/minimum received/],[{minReceiveAmount:'0'},/minimum received/]];
  for(const [over,re] of bad)assert.throws(()=>checkSwap(built(over),leg),re,JSON.stringify(over));
  assert.throws(()=>checkSwap({...built(),executionMode:'RFQ'},leg),/on-chain swap/);
  assert.throws(()=>checkSwap(built(),{...leg,slippagePercent:'10'}),/at most 3/);
});

test('dry runs must succeed and the sent transaction must be the prepared one',()=>{
  assert.throws(()=>checkSimulation({status:'FAILED',failReason:'execution reverted: BEP20: transfer amount exceeds allowance'},{user,toToken:stock,minReceiveAmount:'1'}),/exceeds allowance/);
  assert.equal(checkSimulation({status:'SUCCESS',balanceChanges:[]},{user,toToken:stock,minReceiveAmount:'1'}).observedReceipt,false);
  const prepared={from:user,to:BSC_ROUTER,data:swapData,value:'0'};
  assert.ok(checkSent({from:user,to:BSC_ROUTER,input:swapData,value:'0x0'},prepared));
  assert.throws(()=>checkSent({from:user,to:BSC_ROUTER,input:swapData.slice(0,-2)+'ff',value:'0x0'},prepared),/differs/);
});

async function call(server,method,path,body,token='t0k'){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const {port}=server.address();
  try{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};}
  finally{server.close();}
}
function fakeClient({allowance=0n,status='TRADING',simulation={status:'SUCCESS',balanceChanges:[]},gas=10n**16n,funds=10n**21n}={}){
  const seen=[];
  const client={get:async(path)=>{seen.push(path);
      if(path.endsWith('/rwa/tokens'))return [{tokenContractAddress:stock,platformId:'bstock',tokenSymbol:'NVDAB',decimals:'18',underlyingTicker:'NVDA',tokenToShareRatio:'1',statusInfo:{reasonCode:status}}];
      if(path.endsWith('/aggregator/quote'))return [{quoteId:'q1',vendorName:'LiquidMesh',executionMode:'SWAP',toTokenAmount:'103615607209127732',isBest:true}];
      if(path.endsWith('/aggregator/swap'))return built();
      if(path.endsWith('/approve-transaction'))return approval(amount);
      throw new Error('unexpected '+path);},
    post:async(path)=>{seen.push(path);if(path.endsWith('/simulate'))return simulation;throw new Error('unexpected '+path);}};
  const rpc=async(method,params)=>{seen.push(method);
    if(method==='eth_getBalance')return '0x'+gas.toString(16);
    if(method==='eth_call')return '0x'+(params[0].data.startsWith('0x70a08231')?funds:allowance).toString(16).padStart(64,'0');return null;};
  return{client,rpc,seen};
}

test('gateway: approval first, then a checked and simulated swap; refuses closed markets, unknown tokens and bad tokens',async()=>{
  let f=fakeClient();
  let r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.status,200);assert.equal(r.body.data.step,'APPROVE');assert.equal(r.body.data.tx.to,BSC_USDT);
  f=fakeClient({allowance:BigInt(amount)});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.data.step,'SWAP');assert.equal(r.body.data.tx.to,BSC_ROUTER);assert.ok(f.seen.some(p=>p.endsWith('/simulate')));
  f=fakeClient({allowance:BigInt(amount),simulation:{status:'FAILED',failReason:'execution reverted'}});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.status,422);assert.equal(r.body.error.code,'SIMULATION');
  f=fakeClient({status:'MARKET_CLOSED'});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'MARKET');
  f=fakeClient();
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:'0x4444444444444444444444444444444444444444',amount});
  assert.equal(r.body.error.code,'TOKEN');
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount:(500n*10n**18n).toString()});
  assert.equal(r.body.error.code,'LIMIT');
  f=fakeClient({gas:0n});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'NO_GAS');assert.match(r.body.error.message,/BNB/);
  assert.equal(r.body.error.quote.fromSymbol,'USDT');assert.ok(BigInt(r.body.error.quote.toTokenAmount)>0n);assert.ok(r.body.error.quote.toSymbol);   // the live quote is still shown
  f=fakeClient({funds:10n**18n});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'NO_FUNDS');assert.match(r.body.error.message,/25\.00/);
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'GET','/v1/universe',null,'wrong');
  assert.equal(r.status,401);
});

test('gateway: Agentic Wallet runs fixed commands with --json and validated arguments only',async()=>{
  const f=fakeClient(),calls=[];
  const baw=async(args)=>{calls.push(args);return {orderId:'o-1'};};
  let r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25'});
  assert.equal(r.status,200);assert.deepEqual(calls[0],['market-order','swap','--binanceChainId','56','--fromToken',BSC_USDT,'--toToken',stock,'--fromTokenQty','25','--slippage','auto','--mev','true']);
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25; rm -rf /'});
  assert.equal(r.body.error.code,'INPUT');
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/verify',{qrCodeId:'--help'});
  assert.equal(r.body.error.code,'INPUT');   // an id can never look like a flag
  assert.equal(calls.length,1);
});
