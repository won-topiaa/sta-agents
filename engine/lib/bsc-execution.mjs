// BSC spot execution checks. The Binance Web3 API builds approvals and swaps; this
// module decides whether a built transaction is exactly the approved leg before any
// wallet is asked to sign it. A check failure means nothing is shown for signing.
export const BSC_CHAIN_ID=56;
export const BSC_ROUTER='0xB44446b0c8E56988c34f7Ff73Ae904982b5FdDA5';   // Binance Web3 aggregator router (approveTarget)
export const SWAP_SELECTORS=['0xad43f73d'];                                   // observed for LiquidMesh SWAP routes
export const APPROVE_SELECTOR='0x095ea7b3';
export const MAX_SLIPPAGE_PERCENT=3;
export class ExecutionCheckError extends Error {constructor(code,message){super(message);this.code=code;}}
const fail=(code,message)=>{throw new ExecutionCheckError(code,message);};
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
export const isAddress=v=>typeof v==='string'&&ADDRESS.test(v);
export const sameAddress=(a,b)=>isAddress(a)&&isAddress(b)&&a.toLowerCase()===b.toLowerCase();
export const word=hex=>hex.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const uint=(v,name)=>{if(typeof v!=='string'||!/^\d{1,78}$/.test(v))fail('BAD_AMOUNT',`${name} must be an integer string.`);return BigInt(v);};

export function checkSlippage(slippagePercent){
  const s=Number(slippagePercent);
  if(!Number.isFinite(s)||s<=0||s>MAX_SLIPPAGE_PERCENT)fail('SLIPPAGE',`Slippage must be above 0 and at most ${MAX_SLIPPAGE_PERCENT}%.`);
  return s;
}
// Exact-amount approval of the router, never unlimited.
export function checkApproval(built,{user,token,amount}){
  const a=Array.isArray(built)?built[0]:built?.['0']??built;
  if(!a||typeof a.data!=='string')fail('APPROVAL_SHAPE','Approval was not returned.');
  if(!sameAddress(a.dexContractAddress,BSC_ROUTER))fail('APPROVAL_SPENDER','Approval names an unexpected spender.');
  const expected=APPROVE_SELECTOR+word(BSC_ROUTER)+uint(amount,'amount').toString(16).padStart(64,'0');
  if(a.data.toLowerCase()!==expected)fail('APPROVAL_DATA','Approval is not for the exact amount and router.');
  return {from:user,to:token,data:a.data,value:'0',gas:String(a.gasLimit??'70000'),...(a.gasPrice?{gasPrice:String(a.gasPrice)}:{})};
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
  for(const [part,name] of [[word(fromToken),'input token'],[word(toToken),'output token'],[uint(amount,'amount').toString(16).padStart(64,'0'),'amount']])
    if(!data.includes(part))fail('CALLDATA',`The swap does not contain the approved ${name}.`);
  const minOut=uint(String(tx.minReceiveAmount),'minimum received'),out=uint(quotedOut,'quoted output');
  // Allow 0.5% on top of the requested slippage for route rounding; anything lower is rejected.
  const floor=out*BigInt(Math.round((100-s-0.5)*100))/10000n;
  if(minOut<=0n||minOut<floor||minOut>out)fail('MIN_OUT','The minimum received is outside the quoted range.');
  return {from:user,to:BSC_ROUTER,data:tx.data,value:'0',gas:String(tx.gas),...(tx.gasPrice?{gasPrice:String(tx.gasPrice)}:{}),minReceiveAmount:minOut.toString()};
}
// A dry run must succeed and show the wallet receiving at least the minimum.
export function checkSimulation(sim,{user,toToken,minReceiveAmount}){
  if(sim?.status!=='SUCCESS')fail('SIMULATION',`Dry run failed: ${String(sim?.failReason??'unknown').slice(0,160)}`);
  const changes=Array.isArray(sim.balanceChanges)?sim.balanceChanges:[];
  const got=changes.find(c=>sameAddress(c.address??c.owner??c.account,user)&&sameAddress(c.tokenAddress??c.tokenContractAddress??c.token,toToken));
  if(got){const delta=BigInt(String(got.rawDelta??got.delta??got.amount??'0').replace(/^\+/,''));if(delta<BigInt(minReceiveAmount))fail('SIMULATION_OUT','Dry run shows less than the minimum received.');}
  return {status:'SUCCESS',observedReceipt:Boolean(got)};
}
// The transaction the wallet actually sent must be the prepared one.
export function checkSent(onchain,prepared){
  if(!onchain)fail('NOT_FOUND','Transaction not visible yet.');
  if(!sameAddress(onchain.from,prepared.from)||!sameAddress(onchain.to,prepared.to)||String(onchain.input??onchain.data).toLowerCase()!==prepared.data.toLowerCase()||BigInt(onchain.value??0)!==BigInt(prepared.value))
    fail('MISMATCH','The sent transaction differs from the prepared one.');
  return true;
}
