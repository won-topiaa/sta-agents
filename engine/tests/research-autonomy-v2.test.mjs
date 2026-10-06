import test from 'node:test';
import assert from 'node:assert/strict';
import {keyString,validatePolicy,tradeTree,policyInstruction,policyTransaction,allowOrder,USDC} from '../lib/research-autonomy-policy.mjs';
import {normalizeTradeQuote} from '../lib/research-autonomy-runtime.mjs';
const key=n=>keyString(Buffer.alloc(32,n));
const trade=(n,side='BUY')=>({side,mint:key(n+1),inputAtoms:side==='SELL'?'1000000000':'1000000',minimumCashAtoms:side==='SELL'?'1000000':'0'});
function config(trades){const buys=trades.filter(t=>t.side==='BUY');return {schema:'xtxc.autonomy-policy/v2',executionChain:'solana:mainnet',evidenceChain:'solana:devnet',program:key(190),owner:key(191),verifier:key(192),wallet:key(193),id:'ab'.repeat(32),approvalHash:'cd'.repeat(32),startsAt:'0',expiresAt:'0',buyBudgetAtoms:String(buys.length*1000000),perBuyAtoms:buys.length?'1000000':'0',maxOrders:String(trades.length),trades,mints:[...new Set(trades.map(t=>t.mint))],tradeRoot:tradeTree(trades).root,maxSlippageBps:20,feeBudgetLamports:null};}
test('58 stocks fit one approval transaction and any step has a bounded proof',async()=>{
 const c=validatePolicy(config(Array.from({length:58},(_,n)=>trade(n))));
 const ix=await policyInstruction(c,'APPROVE');assert.equal(ix.data.length,201);assert.equal(ix.data[0],4);
 const tx=policyTransaction(c.owner,[ix],{blockhash:key(199),lastValidBlockHeight:'9000'});
 assert.ok(Buffer.from(tx.transactionBase64,'base64').length<=1232);
 for(let i=0;i<58;i++){const r=await policyInstruction(c,'RESERVE',{...c.trades[i],counter:String(i),messageHash:'ef'.repeat(32)});assert.equal(r.data[0],5);assert.equal(r.data.length,91+6*32);}
});
test('ordered side, mint, input and minimum are all approval-bound',()=>{
 const trades=[trade(0,'SELL'),trade(1)],c=config(trades),s={active:true,revoked:false,pending:false,count:'0',reservedAtoms:'0'};
 assert.equal(allowOrder(c,s,trades[0]),true);
 for(const bad of [{side:'BUY'},{mint:key(10)},{inputAtoms:'1000000001'},{minimumCashAtoms:'999999'}])assert.throws(()=>allowOrder(c,s,{...trades[0],...bad}));
 for(const bad of [{side:'BUY',minimumCashAtoms:'0'},{mint:key(10)},{inputAtoms:'1000000001'},{minimumCashAtoms:'999999'}])assert.notEqual(tradeTree([{...trades[0],...bad},trades[1]]).root,c.tradeRoot);
 assert.notEqual(tradeTree([...trades].reverse()).root,c.tradeRoot);
 assert.throws(()=>validatePolicy({...c,buyBudgetAtoms:'9999999'}));
});
test('sell-only policy reserves zero USDC budget rather than token atoms as dollars',()=>{
 const c=config([trade(0,'SELL')]);assert.equal(validatePolicy(c).buyBudgetAtoms,'0');
 assert.equal(allowOrder(c,{active:true,pending:false,count:'0',reservedAtoms:'0'},c.trades[0]),true);
 assert.throws(()=>allowOrder(c,{active:true,pending:false,count:'1',reservedAtoms:'0'},c.trades[0]),/ORDER_LIMIT/);
});
test('sell quote must match exact held mint and approved minimum cash',()=>{
 const e={instrument:'NVDA',mint:key(1),side:'SELL',inputAtoms:'1000000000',minimumCashAtoms:'1000000',maxSlippageBps:20};
 const q={schema:'skew.stockmesh.liquidation-quote/v1',side:'SELL',instrument:'NVDA',quoteId:'q',inputProduct:{mint:e.mint,inputAtoms:e.inputAtoms},output:{symbol:'USDC',decimals:6,estimatedAtoms:'1001000',minimumAtoms:'1000000'},expiresAt:new Date(Date.now()+30000).toISOString()};
 assert.equal(normalizeTradeQuote(q,e).minimumOutputAtoms,'1000000');
 assert.throws(()=>normalizeTradeQuote({...q,inputProduct:{...q.inputProduct,mint:USDC}},e));
 assert.throws(()=>normalizeTradeQuote(q,{...e,minimumCashAtoms:'1000001'}));
});
