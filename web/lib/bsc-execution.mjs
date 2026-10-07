// BSC spot execution checks. The Binance Web3 API builds approvals and swaps; this
// module decides whether a built transaction is exactly the approved leg before any
// wallet is asked to sign it. A check failure means nothing is shown for signing.
export const BSC_CHAIN_ID=56;
export const BSC_ROUTER='0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5';   // Binance Web3 aggregator router (approveTarget)
export const SWAP_SELECTORS=['0xad43f73d'];                                   // observed for LiquidMesh SWAP routes
export const APPROVE_SELECTOR='0x095ea7b3';
export const MAX_SLIPPAGE_PERCENT=3;
// Fee fields come from the API; a wallet would sign whatever is there, so they are bounded here.
export const MAX_GAS=3_000_000n,MAX_GAS_PRICE_WEI=20_000_000_000n;   // 20 gwei; BSC normally runs well under 5
// Head of the 0xad43f73d swap call (32-byte words after the selector), read from real Binance router swaps (bStock and
// Ondo buys, a bStock sale): [1] receiver (zero = the sender), [3] input token, [4] input amount, [5] output token,
// [6] minimum received. Any other layout is refused.
const SWAP_WORDS={receiver:1,fromToken:3,amount:4,toToken:5,minOut:6};
export class ExecutionCheckError extends Error {constructor(code,message){super(message);this.code=code;}}
const fail=(code,message)=>{throw new ExecutionCheckError(code,message);};
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
export const isAddress=v=>typeof v==='string'&&ADDRESS.test(v);
export const sameAddress=(a,b)=>isAddress(a)&&isAddress(b)&&a.toLowerCase()===b.toLowerCase();
export const word=hex=>hex.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const uint=(v,name)=>{if(typeof v!=='string'||!/^\d{1,78}$/.test(v))fail('BAD_AMOUNT',`${name} must be an integer string.`);return BigInt(v);};

export function checkSlippage(slippagePercent){
  const text=typeof slippagePercent==='number'?String(slippagePercent):slippagePercent;
  const s=typeof text==='string'&&/^\d{1,2}(\.\d{1,4})?$/.test(text)?Number(text):NaN;
  if(!Number.isFinite(s)||s<=0||s>MAX_SLIPPAGE_PERCENT)fail('SLIPPAGE',`Slippage must be above 0 and at most ${MAX_SLIPPAGE_PERCENT}%.`);
  return s;
}
function fees(gas,gasPrice,fallbackGas){
  const g=gas==null?BigInt(fallbackGas):uint(String(gas),'gas');
  if(g<=0n||g>MAX_GAS)fail('GAS','The transaction asks for an unusual amount of gas.');
  if(gasPrice==null)return {gas:g.toString()};
  const p=uint(String(gasPrice),'gas price');
  if(p>MAX_GAS_PRICE_WEI)fail('GAS','The transaction asks for an unusual gas price.');
  return {gas:g.toString(),gasPrice:p.toString()};
}
// Exact-amount approval of the router, never unlimited.
export function checkApproval(built,{user,token,amount}){
  const a=Array.isArray(built)?built[0]:built?.['0']??built;
  if(!a||typeof a.data!=='string')fail('APPROVAL_SHAPE','Approval was not returned.');
  if(!sameAddress(a.dexContractAddress,BSC_ROUTER))fail('APPROVAL_SPENDER','Approval names an unexpected spender.');
  const expected=APPROVE_SELECTOR+word(BSC_ROUTER)+uint(amount,'amount').toString(16).padStart(64,'0');
  if(a.data.toLowerCase()!==expected)fail('APPROVAL_DATA','Approval is not for the exact amount and router.');
  return {from:user,to:token,data:a.data,value:'0',...fees(a.gasLimit,a.gasPrice||null,'70000')};
}
// The swap must spend exactly this leg and deliver at least the quoted amount less slippage.
export function checkSwap(built,{user,fromToken,toToken,amount,quotedOut,slippagePercent}){
  const tx=built?.tx;const s=checkSlippage(slippagePercent);
  if(built?.executionMode!=='SWAP'||!tx)fail('MODE','Only on-chain swap routes are supported.');
  if(!sameAddress(tx.from,user))fail('FROM','The swap is not for your wallet.');
  if(!sameAddress(tx.to,BSC_ROUTER))fail('TARGET','The swap targets an unexpected contract.');
  if(String(tx.value)!=='0')fail('VALUE','The swap would send BNB.');
  const data=String(tx.data??'').toLowerCase();
  if(!SWAP_SELECTORS.includes(data.slice(0,10)))fail('SELECTOR','Unrecognised swap instruction.');
  const words=/^[0-9a-f]*$/.test(data.slice(10))&&data.length%64===10?data.slice(10).match(/.{64}/g)??[]:[];
  if(words.length<=SWAP_WORDS.minOut)fail('CALLDATA','The swap instruction is malformed.');
  if(BigInt('0x'+words[SWAP_WORDS.receiver])!==0n)fail('RECEIVER','The swap would deliver to another address.');
  for(const [key,want,name] of [['fromToken',word(fromToken),'input token'],['toToken',word(toToken),'output token'],
    ['amount',uint(amount,'amount').toString(16).padStart(64,'0'),'amount']])
    if(words[SWAP_WORDS[key]]!==want)fail('CALLDATA',`The swap is not for the approved ${name}.`);
  const minOut=uint(String(tx.minReceiveAmount),'minimum received'),out=uint(quotedOut,'quoted output');
  if(BigInt('0x'+words[SWAP_WORDS.minOut])!==minOut)fail('MIN_OUT','The minimum received in the transaction differs from the one shown.');
  // Allow 0.5% on top of the requested slippage for route rounding; anything lower is rejected.
  const floor=out*BigInt(Math.round((100-s-0.5)*100))/10000n;
  if(minOut<=0n||minOut<floor||minOut>out)fail('MIN_OUT','The minimum received is outside the quoted range.');
  return {from:user,to:BSC_ROUTER,data:tx.data,value:'0',...fees(tx.gas,tx.gasPrice||null,'500000'),minReceiveAmount:minOut.toString()};
}
// A dry run must succeed and show this wallet receiving at least the minimum and spending exactly the leg.
// Binance reports balanceChanges as {owner, contractAddress, change (signed integer string), tokenType}.
export function checkSimulation(sim,{user,fromToken,toToken,amount,minReceiveAmount}){
  if(sim?.status!=='SUCCESS')fail('SIMULATION',`Dry run failed: ${String(sim?.failReason??'unknown').slice(0,160)}`);
  const changes=Array.isArray(sim.balanceChanges)?sim.balanceChanges:[];
  const net=token=>{
    const rows=changes.filter(c=>sameAddress(c?.owner,user)&&sameAddress(c?.contractAddress,token));
    if(!rows.length)return null;
    return rows.reduce((sum,c)=>{const v=String(c.change??'');if(!/^[+-]?\d{1,78}$/.test(v))fail('SIMULATION','The dry run reported an unreadable balance change.');return sum+BigInt(v.replace(/^\+/,''));},0n);
  };
  const got=net(toToken);
  if(got===null)fail('SIMULATION_OUT','The dry run does not show the tokens arriving in your wallet.');
  if(got<BigInt(minReceiveAmount))fail('SIMULATION_OUT','Dry run shows less than the minimum received.');
  if(fromToken!==undefined){
    const spent=net(fromToken);
    if(spent===null||-spent!==BigInt(amount))fail('SIMULATION_IN','The dry run spends a different amount than the approved leg.');
  }
  return {status:'SUCCESS',observedReceipt:true,received:got.toString()};
}
// The transaction the wallet actually sent must be the prepared one, and sent after it was prepared: its nonce is at
// least the wallet's pending nonce at preparation (an older identical transaction does not count).
export function checkSent(onchain,prepared,{minNonce}={}){
  if(!onchain)fail('NOT_FOUND','Transaction not visible yet.');
  if(minNonce!=null&&(onchain.nonce==null||BigInt(onchain.nonce)<BigInt(minNonce)))fail('STALE','This transaction was sent before the step was prepared.');
  if(!sameAddress(onchain.from,prepared.from)||!sameAddress(onchain.to,prepared.to)||String(onchain.input??onchain.data).toLowerCase()!==prepared.data.toLowerCase()||BigInt(onchain.value??0)!==BigInt(prepared.value))
    fail('MISMATCH','The sent transaction differs from the prepared one.');
  return true;
}
