// Deterministic JS -> SBF interoperability vectors. No network or signing keys.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {keyString,tradeTree,policyInstruction} from '../lib/research-autonomy-policy.mjs';
if(process.platform!=='linux'||!process.env.STA_SVM_ROOT)throw Error('isolated Linux STA_SVM_ROOT required');
const key=n=>keyString(Buffer.alloc(32,n));
const trades=Array.from({length:58},(_,i)=>({side:i<29?'SELL':'BUY',mint:key(i+1),inputAtoms:String(i<29?12345:1000000),minimumCashAtoms:i<29?'1000000':'0'}));
const config={schema:'xtxc.autonomy-policy/v2',executionChain:'solana:mainnet',evidenceChain:'solana:devnet',program:key(191),owner:key(192),verifier:key(193),wallet:key(194),id:'ab'.repeat(32),approvalHash:'cd'.repeat(32),startsAt:'0',expiresAt:'0',buyBudgetAtoms:'29000000',perBuyAtoms:'1000000',maxOrders:'58',mints:trades.map(t=>t.mint),trades,tradeRoot:tradeTree(trades).root,maxSlippageBps:20,feeBudgetLamports:null};
const bytes=ix=>Array.from(ix.data);
const reserve=[];
for(const [i,t] of trades.entries())reserve.push(bytes(await policyInstruction(config,'RESERVE',{...t,counter:String(i),messageHash:(i+1).toString(16).padStart(2,'0').repeat(32)})));
writeFileSync(join(process.env.STA_SVM_ROOT,'evidence/v2-wire.json'),JSON.stringify({approval:bytes(await policyInstruction(config,'APPROVE')),reserve}));
