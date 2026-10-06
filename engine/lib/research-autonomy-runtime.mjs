import {MAINNET,integer,hash,requirePolicy as need,observePolicy,allowOrder,verifyExactSignature} from './research-autonomy-policy.mjs';
import {inspectStockMeshTrade} from './research-autonomy-wire.mjs';
import {checkedSellQuote,atomsDecimal} from './research-rebalance.mjs';

// The signer is NOT exposed as an HTTP endpoint accepting arbitrary wire bytes.
// API/model callers may request a policy/order; only this gate reaches signer.
export class AutonomyRuntime {
 constructor({journal,devnet,mainnet,stockmesh,signer,beforeSign=()=>{}}){Object.assign(this,{journal,devnet,mainnet,stockmesh,signer,beforeSign});}
 async observed(c){return observePolicy(c,await this.devnet.observe(c));}
 async prepare(policyId,{instrument,mint,inputAtoms,side='BUY',inputDecimals=6,minimumCashAtoms='0'}){
  const p=this.journal.policy(policyId),s=await this.observed(p.config),order={side,mint,inputAtoms,minimumCashAtoms};
  try{allowOrder(p.config,s,order);}catch(e){this.journal.rejection(policyId,{instrument,...order},e.code??'POLICY_REJECTED');throw e;}
  // A provider binding is provisioned only after checking the signed-in user,
  // exact wallet address, additional signer and restrictive provider policy.
  await this.signer.assertBinding(p.config);
  await this.mainnet.pin(MAINNET);
  const notional=atomsDecimal(inputAtoms,inputDecimals);
  const raw=await this.stockmesh.quote({instrument,side,notional,inputAtoms,productMint:side==='SELL'?mint:undefined,notionalAsset:'USDC',maxSlippageBps:p.config.maxSlippageBps});
  const quote=normalizeTradeQuote(raw,{instrument,mint,inputAtoms,side,minimumCashAtoms,maxSlippageBps:p.config.maxSlippageBps});
  const prepared=await this.stockmesh.prepare({owner:p.wallet,quoteId:quote.quoteId});
  const facts=await inspectStockMeshTrade(prepared.transactionBase64,p.wallet,{...order,minimumOutputAtoms:quote.minimumOutputAtoms},a=>this.mainnet.lookup(a));
  // Production quote lifetime is 30 seconds, not a fresh 30 seconds after
  // preparation. Leave a bounded devnet-finality window without making every
  // live quote impossible to admit. Recheck the deadline immediately at signing.
  need(Date.parse(prepared.expiresAt)>Date.now()+18000,'QUOTE_TOO_OLD');
  const simulated=await this.mainnet.simulate(prepared.transactionBase64,facts);
  need(simulated.genesisHash===MAINNET&&simulated.messageHash===facts.messageHash&&simulated.err===null,'SIMULATION_REJECTED');
  if(p.config.feeBudgetLamports!==null){const fees=this.journal.db.prepare("SELECT document FROM autonomy_orders WHERE policy=?").all(policyId).reduce((sum,r)=>sum+integer(JSON.parse(r.document).facts.networkFeeLamports),0n);need(fees+integer(facts.networkFeeLamports)<=integer(p.config.feeBudgetLamports),'FEE_BUDGET_EXHAUSTED');}
  const row=this.journal.stage(policyId,await this.observed(p.config),prepared,{...facts,instrument});
  // Persist RESERVING before devnet transport. If it times out, recover this
  // same reservation by its exact message hash; do not create another order.
  const signature=await this.devnet.reserve(p.config,row);
  return this.journal.permitted(row.id,await this.observed(p.config),signature);
 }
 async execute(orderId){
  let r=this.journal.order(orderId);const p=this.journal.policy(r.policy);
  await this.mainnet.pin(MAINNET);await this.signer.assertBinding(p.config);
  this.beforeSign();
  need(Date.parse(r.prepared.expiresAt)>Date.now()+4000&&await this.mainnet.blockhashValid(r.facts.blockhash),'PREPARED_TRANSACTION_EXPIRED');
  const observed=await this.observed(p.config);this.beforeSign();r=this.journal.beginSigning(orderId,observed);
  try{const signed=await this.signer.signTransaction(p.config,r.prepared.transactionBase64,r.id,{expiresAt:r.prepared.expiresAt});r=this.journal.signed(orderId,signed);}catch(e){this.journal.signingUnknown(orderId);throw e;}
  // Revocation after signing but before submission still prevents relay when
  // observed here. This is a trusted cross-chain gate, NOT atomic revocation.
  return this.relay(orderId);
 }
 async relay(orderId){const before=this.journal.order(orderId),p=this.journal.policy(before.policy);await this.mainnet.pin(MAINNET);need(await this.mainnet.blockhashValid(before.facts.blockhash),'SIGNED_TRANSACTION_EXPIRED');const observed=await this.observed(p.config);this.beforeSign();const r=this.journal.beginRelay(orderId,observed);const reply=await this.stockmesh.submit({owner:r.wallet,quoteId:r.prepared.quoteId,preparedId:r.prepared.preparedId,signedTransactionBase64:r.signedTransactionBase64});need(reply.signature===r.signature,'SUBMISSION_SIGNATURE_MISMATCH');return this.check(orderId);}
 async check(orderId){let r=this.journal.order(orderId);need(r.signature||r.phase==='EXPIRED_UNSIGNED','NO_SIGNED_TRANSACTION');await this.mainnet.pin(MAINNET);if(!r.receipt){const tx=await this.mainnet.transaction(r.signature);if(!tx)return r;r=this.journal.recordReceipt(orderId,verifyMainnetReceipt(r,tx));}if(!r.settlementSignature){const p=this.journal.policy(r.policy),signature=await this.devnet.settle(p.config,r);r=this.journal.put({...r,settlementSignature:signature},r.phase);}return r;}
}
export function normalizeBuyQuote(q,e){
 need(q.schema==='skew.stockmesh.exposure-quote/v2'&&q.instrument===e.instrument&&q.inputSymbol==='USDC'&&q.inAmountAtoms===e.inputAtoms&&q.exposure?.products?.length===1,'QUOTE_MISMATCH');
 const product=q.exposure.products[0],estimated=integer(q.exposure.estimatedQ32),minimum=integer(q.exposure.minimumQ32);
 need(product.mint===e.mint&&estimated>0n&&minimum>0n&&minimum<=estimated&&minimum>=estimated*BigInt(10000-e.maxSlippageBps)/10000n,'QUOTE_ASSET_OR_SLIPPAGE_MISMATCH');
 const rawMinimum=(integer(product.rawOutputAtoms)*minimum+estimated-1n)/estimated;
 need(rawMinimum>0n,'ORDER_TOO_SMALL');
 return{quoteId:q.quoteId,productMint:product.mint,inputAtoms:q.inAmountAtoms,minimumOutputAtoms:String(rawMinimum)};
}
export function normalizeTradeQuote(q,e){
 if((e.side??'BUY')==='BUY')return normalizeBuyQuote(q,e);
 need(e.side==='SELL','INVALID_TRADE_SIDE');
 const minimum=checkedSellQuote(q,{instrument:e.instrument,mint:e.mint},e.inputAtoms);
 need(minimum>=integer(e.minimumCashAtoms)&&minimum>=integer(q.output.estimatedAtoms)*BigInt(10000-e.maxSlippageBps)/10000n,'SELL_MINIMUM_NOT_APPROVED');
 return{quoteId:q.quoteId,productMint:e.mint,inputAtoms:e.inputAtoms,minimumOutputAtoms:String(minimum)};
}
export function verifyMainnetReceipt(row,observation){
 const {tx,status}=observation;
 need(observation.genesisHash===MAINNET&&status?.confirmationStatus==='finalized'&&tx&&Number.isSafeInteger(tx.slot)&&tx.slot===status.slot&&tx.transaction?.[1]==='base64'&&tx.transaction[0]===row.signedTransactionBase64&&tx.meta,'RECEIPT_NOT_FINALIZED_EXACT_WIRE');
 need(verifyExactSignature(row.prepared.transactionBase64,tx.transaction[0],row.wallet)===row.signature,'RECEIPT_SIGNATURE_MISMATCH');
 need(JSON.stringify(tx.meta.err)===JSON.stringify(status.err)&&Number.isSafeInteger(tx.meta.fee)&&tx.meta.fee>=0&&String(tx.meta.fee)===row.facts.networkFeeLamports,'RECEIPT_FEE_OR_STATUS_MISMATCH');
 const receipt={signature:row.signature,messageHash:row.facts.messageHash,genesisHash:MAINNET,slot:tx.slot,feeLamports:String(tx.meta.fee),phase:tx.meta.err?'FAILED_FINALIZED':'RECONCILED'};
 if(tx.meta.err)return{...receipt,errorHash:hash(JSON.stringify(tx.meta.err))};
 const amount=(rows,index,mint,optional=false)=>{const r=rows?.find(x=>x.accountIndex===index);if(!r&&optional)return 0n;need(r&&r.mint===mint&&r.owner===row.wallet,'MISSING_OWNER_TOKEN_RECEIPT');return integer(r.uiTokenAmount.amount);};
 const source=row.facts.keys.indexOf(row.facts.source),destination=row.facts.keys.indexOf(row.facts.destination);need(source>=0&&destination>=0,'RECEIPT_ACCOUNT_MISSING');
 const before=tx.meta.preTokenBalances,after=tx.meta.postTokenBalances;
 const usdc='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',sell=row.facts.side==='SELL';
 const sourceMint=sell?row.facts.mint:usdc,destinationMint=sell?usdc:row.facts.mint;
 const spent=amount(before,source,sourceMint)-amount(after,source,sourceMint);
 const received=amount(after,destination,destinationMint)-amount(before,destination,destinationMint,true);
 need(spent>0n&&spent<=integer(row.facts.inputAtoms)&&received>=integer(row.facts.minimumOutputAtoms),'TOKEN_DELIVERY_MISMATCH');
 return{...receipt,inputAtoms:String(spent),outputAtoms:String(received),mint:row.facts.mint,side:row.facts.side??'BUY',sourceMint,destinationMint};
}

export {PrivyDelegatedSigner} from './research-autonomy-privy.mjs';
