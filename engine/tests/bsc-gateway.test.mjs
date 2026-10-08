import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkApproval,checkSwap,checkSimulation,checkSent,word,BSC_ROUTER} from '../lib/bsc-execution.mjs';
import {createGateway} from '../bnb-gateway/server.mjs';
import {BSC_USDT} from '../lib/binance-web3.mjs';

const user='0x1111111111111111111111111111111111111111',stock='0x02fca66c1d1afb4e2a7884261eb00f63598a7436';
const amount=(25n*10n**18n).toString(),hex=v=>BigInt(v).toString(16).padStart(64,'0');
// Shapes copied from real responses (quote/swap/approve on 2026-10-06; swap calldata words and simulate rows on
// 2026-10-07): [0] order id, [1] receiver (0 = sender), [2] executor, [3] input token, [4] amount, [5] output token,
// [6] minimum received, [7] pool, [8] expected out, [9] offset, then route data.
const minOut='102579451137036454';
const swapData='0xad43f73d'+hex('0x4ab3d4e76e0005bd')+hex(0)+word('0x3d90f66b534dd8482b181e24655a9e8265316be9')+word(BSC_USDT)+hex(amount)+word(stock)+hex(minOut)
  +word('0xd2a27f8fdbaaec431d59046a8bce4e5db665a271')+hex('103615607209127732')+hex(320)+hex(4)+'47ee97ff'.padEnd(64,'0');
const received=(over={})=>({status:'SUCCESS',failReason:'',allowanceChanges:[],balanceChanges:[
  {contractAddress:stock,tokenType:'Erc20',change:'103001200300400500',owner:user},{contractAddress:BSC_USDT,tokenType:'Erc20',change:'-'+amount,owner:user.toLowerCase()}],...over});
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
    [{data:swapData.replace(hex(amount),hex(amount+'0'))},/amount/],[{minReceiveAmount:'1'},/minimum received/],[{minReceiveAmount:'0'},/minimum received/],
    [{data:swapData.slice(0,74)+hex('0x9999999999999999999999999999999999999999')+swapData.slice(138)},/another address/],   // receiver word
    [{data:swapData.replace(hex(minOut),hex(1))},/minimum received/],                                                         // calldata minOut
    [{data:'0xad43f73d'+hex(0)+word(BSC_USDT)+word(stock)+hex(amount)},/malformed|input token/],                              // tokens elsewhere
    [{gas:'90000000'},/gas/],[{gasPrice:'999000000000000'},/gas price/]];
  for(const [over,re] of bad)assert.throws(()=>checkSwap(built(over),leg),re,JSON.stringify(over));
  assert.throws(()=>checkSwap({...built(),executionMode:'RFQ'},leg),/on-chain swap/);
  assert.throws(()=>checkSwap(built(),{...leg,slippagePercent:'10'}),/at most 3/);
});

test('dry runs must succeed and the sent transaction must be the prepared one',()=>{
  const sim={user,fromToken:BSC_USDT,toToken:stock,amount,minReceiveAmount:minOut};
  assert.throws(()=>checkSimulation({status:'FAILED',failReason:'execution reverted: BEP20: transfer amount exceeds allowance'},sim),/exceeds allowance/);
  assert.equal(checkSimulation(received(),sim).received,'103001200300400500');
  assert.throws(()=>checkSimulation(received({balanceChanges:[]}),sim),/arriving in your wallet/);                    // nothing shown: refused
  assert.throws(()=>checkSimulation(received({balanceChanges:[{...received().balanceChanges[0],owner:'0x9999999999999999999999999999999999999999'},
    received().balanceChanges[1]]}),sim),/arriving in your wallet/);                                                        // delivered elsewhere
  assert.throws(()=>checkSimulation(received({balanceChanges:[{...received().balanceChanges[0],change:'1'},received().balanceChanges[1]]}),sim),/less than/);
  assert.throws(()=>checkSimulation(received({balanceChanges:[received().balanceChanges[0],{...received().balanceChanges[1],change:'-'+amount+'0'}]}),sim),/different amount/);
  const prepared={from:user,to:BSC_ROUTER,data:swapData,value:'0'};
  assert.ok(checkSent({from:user,to:BSC_ROUTER,input:swapData,value:'0x0'},prepared));
  assert.ok(checkSent({from:user,to:BSC_ROUTER,input:swapData,value:'0x0',nonce:'0x7'},prepared,{minNonce:'7'}));
  assert.throws(()=>checkSent({from:user,to:BSC_ROUTER,input:swapData,value:'0x0',nonce:'0x6'},prepared,{minNonce:'7'}),/before the step/);
  assert.throws(()=>checkSent({from:user,to:BSC_ROUTER,input:swapData.slice(0,-2)+'ff',value:'0x0'},prepared),/differs/);
});

async function call(server,method,path,body,token='t0k'){
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const {port}=server.address();
  try{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return{status:r.status,body:await r.json()};}
  finally{server.close();}
}
function fakeClient({allowance=0n,status='TRADING',simulation=received(),gas=10n**16n,funds=10n**21n,price='241',ratio='1',impact='0.1',out='103615607209127732',estimate=100000n,routes=null,rfq=[]}={}){
  const seen=[];
  const client={get:async(path,params={})=>{seen.push(path);
      if(path.endsWith('/rwa/tokens'))return [{tokenContractAddress:stock,platformId:'bstock',tokenSymbol:'NVDAB',decimals:'18',underlyingTicker:'NVDA',tokenToShareRatio:ratio,tokenPrice:price,statusInfo:{reasonCode:status}}];
      if(path.endsWith('/aggregator/quote'))return routes??[{quoteId:'q1',vendorName:'LiquidMesh',executionMode:'SWAP',toTokenAmount:out,priceImpactPercent:impact,isBest:true}];
      // A route listed in rfq fills through the RFQ adapter: its address appears after the checked head of the calldata.
      if(path.endsWith('/aggregator/swap'))return rfq.includes(params.quoteId)?built({data:swapData+'0'.repeat(24)+'7977f3e8e063a4ee95b5f396d63485dbdea4515d'}):built();
      if(path.endsWith('/approve-transaction'))return approval(amount);
      throw new Error('unexpected '+path);},
    post:async(path)=>{seen.push(path);if(path.endsWith('/simulate'))return simulation;throw new Error('unexpected '+path);}};
  const rpc=async(method,params)=>{seen.push(method);
    if(method==='eth_getBalance')return '0x'+gas.toString(16);
    if(method==='eth_estimateGas'){if(estimate==null)throw new Error('RPC eth_estimateGas: execution reverted');return '0x'+estimate.toString(16);}
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
  assert.equal(r.body.data.tx.gas,'450000');                                   // the route's limit stays when it is enough
  // A market-maker (RFQ) route expires before a person can sign: the next route is used, and with none, nothing is signed.
  const two=[{quoteId:'q1',vendorName:'LiquidMesh',executionMode:'SWAP',toTokenAmount:'103615607209127732',priceImpactPercent:'0.1',isBest:true},
    {quoteId:'q2',vendorName:'OtherDex',executionMode:'SWAP',toTokenAmount:'103615607209127732',priceImpactPercent:'0.2'}];
  f=fakeClient({allowance:BigInt(amount),routes:two,rfq:['q1']});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.data.step,'SWAP');assert.equal(r.body.data.quote.vendor,'OtherDex');assert.ok(!r.body.data.tx.data.includes('7977f3e8'));
  f=fakeClient({allowance:BigInt(amount),routes:two,rfq:['q1','q2']});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'RFQ');assert.ok(r.body.error.quote);assert.ok(!f.seen.some(p=>p.endsWith('/simulate')));
  f=fakeClient({allowance:BigInt(amount),estimate:1208871n});                  // a stock-token swap needing ~1.2M gas
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.data.tx.gas,'1571532');                                  // the node's estimate plus 30%
  f=fakeClient({allowance:BigInt(amount),estimate:null});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'GAS');
  f=fakeClient({allowance:BigInt(amount),estimate:2500000n});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'GAS');
  f=fakeClient({allowance:2n**256n-1n});                                       // an unlimited allowance left by another app
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.data.step,'APPROVE');                                    // is set back to exactly this leg first
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',amount});
  assert.equal(r.body.error.code,'TOKEN');                                     // stablecoin to stablecoin is not a stock trade
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
  const baw=async(args)=>{calls.push(args);return args[1]==='address'?{addresses:[{binanceChainId:'56',address:user}]}:{orderId:'o-1'};};
  let r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25'});
  const swaps=()=>calls.filter(c=>c[0]==='market-order');
  assert.equal(r.status,200);assert.deepEqual(swaps()[0],['market-order','swap','--binanceChainId','56','--fromToken',BSC_USDT,'--toToken',stock,'--fromTokenQty','25','--slippage','1','--mev','true']);
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'500'});
  assert.equal(r.body.error.code,'LIMIT');                                     // the same purchase cap as a signed leg
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25',slippagePercent:'9'});
  assert.equal(r.body.error.code,'SLIPPAGE');
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25; rm -rf /'});
  assert.equal(r.body.error.code,'INPUT');
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/verify',{qrCodeId:'--help'});
  assert.equal(r.body.error.code,'INPUT');   // an id can never look like a flag
  assert.equal(swaps().length,1);
  const closed=fakeClient({status:'MARKET_CLOSED'});
  r=await call(createGateway({client:closed.client,rpc:closed.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25'});
  assert.equal(r.body.error.code,'MARKET');
  assert.throws(()=>createGateway({client:f.client,rpc:f.rpc,baw,token:''}),/token/);
});


test('gateway: an independent price bound for signed and Agentic legs; Agentic sales are sent in shares',async()=>{
  // 25 USDT for 0.1036 NVDAB is $241.3 a token: fine against a listed $241, refused against $200 (20% worse).
  let f=fakeClient({allowance:BigInt(amount),price:'200'});
  let r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'PRICE');assert.match(r.body.error.message,/worse than its listed price/);
  f=fakeClient({allowance:BigInt(amount),impact:'4.5'});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'PRICE');assert.match(r.body.error.message,/impact/);
  f=fakeClient({allowance:BigInt(amount),price:''});
  r=await call(createGateway({client:f.client,rpc:f.rpc,token:'t0k'}),'POST','/v1/prepare',{user,fromToken:BSC_USDT,toToken:stock,amount});
  assert.equal(r.body.error.code,'PRICE');                                     // no reference, no trade
  const calls=[],baw=async args=>{calls.push(args);return args[1]==='address'?{addresses:[{binanceChainId:'56',address:user}]}:{orderId:'o-2'};};
  f=fakeClient({price:'200'});
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25'});
  assert.equal(r.body.error.code,'PRICE');assert.equal(calls.filter(c=>c[0]==='market-order').length,0);   // no order
  // A sale of 2 tokens of a 5-shares-per-token stock: the CLI is told 10 (shares); 2 tokens for $2,410 is $1,205 each.
  f=fakeClient({ratio:'5',price:'1205',out:(2410n*10n**18n).toString()});
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:stock,toToken:BSC_USDT,fromTokenQty:'2'});
  assert.equal(r.status,200);assert.deepEqual(calls.at(-1).slice(0,9),['market-order','swap','--binanceChainId','56','--fromToken',stock,'--toToken',BSC_USDT,'--fromTokenQty']);
  assert.equal(calls.at(-1)[9],'10');
  // A share amount that does not divide evenly is rounded DOWN: the CLI refuses an amount whose tokens exceed the balance.
  f=fakeClient({ratio:'0.333333333333333333',price:'80',out:(80n*10n**18n).toString()});
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:stock,toToken:BSC_USDT,fromTokenQty:'1.000000000000000007'});
  assert.equal(r.status,200);assert.equal(calls.at(-1)[9],'0.333333333333333335');
});

test('gateway: an unclear wallet answer is AGENTIC_UNKNOWN; fills are reported in token atoms; an order id survives a refusal',async()=>{
  const f=fakeClient({ratio:'5'});
  let mode='timeout';
  const baw=async args=>{
    if(args[1]==='address')return {addresses:[{binanceChainId:'56',address:user}]};
    if(args[1]==='list')return [{orderId:'o-9',toToken:stock,toTokenActualQty:'10',status:'FINISHED'}];
    if(mode==='timeout')throw Object.assign(new Error('The Agentic Wallet did not answer clearly; an order may exist.'),{code:'AGENTIC_UNKNOWN'});
    throw Object.assign(new Error('Confirmation required on App'),{code:'AGENTIC',orderId:'o-7'});
  };
  const {ExecutionCheckError}=await import('../lib/bsc-execution.mjs');
  const wrap=async args=>{try{return await baw(args);}catch(e){throw Object.assign(new ExecutionCheckError(e.code,e.message),e.orderId?{orderId:e.orderId}:{});}};
  let r=await call(createGateway({client:f.client,rpc:f.rpc,baw:wrap,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25'});
  assert.equal(r.status,504);assert.equal(r.body.error.code,'AGENTIC_UNKNOWN');
  mode='refused';
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw:wrap,token:'t0k'}),'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25'});
  assert.equal(r.body.error.orderId,'o-7');
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw:wrap,token:'t0k'}),'GET','/v1/agentic/order?orderId=o-9');
  assert.equal(r.body.data[0].filledTokenAtoms,(2n*10n**18n).toString());   // 10 shares at 5 shares a token
  // The swap can return the id with its last digits off (the same double): the one record with that double answers,
  // under the asked id; ids from other doubles never do.
  let records=[{orderId:'26100800001950612010',status:'FINISHED',fromToken:BSC_USDT,toToken:stock,toTokenActualQty:'10'},{orderId:'26100800001950600000',status:'FINISHED'}];
  const booked=async args=>args[1]==='address'?{addresses:[{binanceChainId:'56',address:user}]}:args[1]==='swap'?{orderId:'26100800001950611986'}
    :args.includes('--orderId')?{total:0,list:[]}:{total:records.length,list:records};
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw:booked,token:'t0k'}),'GET','/v1/agentic/order?orderId=26100800001950611986');
  assert.equal(r.body.data.list.length,1);assert.equal(r.body.data.list[0].orderId,'26100800001950611986');
  assert.equal(r.body.data.list[0].bookedOrderId,'26100800001950612010');assert.equal(r.body.data.list[0].status,'FINISHED');
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw:booked,token:'t0k'}),'GET','/v1/agentic/order?orderId=26100800001950700000');
  assert.equal(r.body.data.list.length,0);                                     // no record with that double: still pending
  // Two records with the same double: ambiguous unless this gateway sent the swap and knows its tokens.
  records=[{orderId:'26100800001950611970',status:'FINISHED',fromToken:stock,toToken:BSC_USDT},...records];
  r=await call(createGateway({client:f.client,rpc:f.rpc,baw:booked,token:'t0k'}),'GET','/v1/agentic/order?orderId=26100800001950611986');
  assert.equal(r.body.data.list.length,0);
  const g=createGateway({client:f.client,rpc:f.rpc,baw:booked,token:'t0k'});
  r=await call(g,'POST','/v1/agentic/swap',{fromToken:BSC_USDT,toToken:stock,fromTokenQty:'25'});
  r=await call(g,'GET','/v1/agentic/order?orderId=26100800001950611986');
  assert.equal(r.body.data.list.length,1);assert.equal(r.body.data.list[0].bookedOrderId,'26100800001950612010');   // the USDT -> stock record
});
