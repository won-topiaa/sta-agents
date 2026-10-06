import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {allocateBudget} from '../lib/research-agent-core.mjs';
import {allowOrder,canonical,hash,keyString} from '../lib/research-autonomy-policy.mjs';
import {AutonomyJournal} from '../lib/research-autonomy-journal.mjs';

// Exhaustively enumerate the small state space, rather than hand-pick a happy
// 2+1 demonstration. No provider, signer or transaction sender is imported.
const key=n=>keyString(Buffer.alloc(32,n));
const config=()=>({schema:'xtxc.autonomy-policy/v1',executionChain:'solana:mainnet',evidenceChain:'solana:devnet',program:key(191),owner:key(192),verifier:key(193),wallet:key(194),id:'ab'.repeat(32),approvalHash:'cd'.repeat(32),startsAt:'0',expiresAt:'0',buyBudgetAtoms:'300',perBuyAtoms:'200',maxOrders:'2',mints:[key(195)],maxSlippageBps:20,feeBudgetLamports:null});
const state=()=>({active:true,revoked:false,pending:false,count:'0',reservedAtoms:'0',slot:100,observedAt:Date.now()});

test('28800 state/request combinations agree with an independent arithmetic oracle',()=>{
  let checked=0;
  for(const budget of [1,2,3,7,31,100])for(const per of [1,Math.max(1,Math.floor(budget/2)),budget])
  for(const spent of [0,Math.max(0,budget-1),budget,budget+1])for(const amount of [0,1,per,per+1,budget+1])
  for(const count of [0,1,2,3,4])for(const active of [true,false])for(const pending of [true,false])for(const approvedMint of [true,false])for(const revoked of [true,false]){
    const c={...config(),buyBudgetAtoms:String(budget),perBuyAtoms:String(per),maxOrders:'3'};
    const s={...state(),reservedAtoms:String(spent),count:String(count),active,pending,revoked};
    const o={side:'BUY',mint:approvedMint?c.mints[0]:key(196),inputAtoms:String(amount)};
    const expected=active&&!revoked&&!pending&&count<3&&approvedMint&&amount>0&&amount<=per&&spent+amount<=budget;
    let accepted=false;try{accepted=allowOrder(c,s,o);}catch{}
    assert.equal(accepted,expected,JSON.stringify({budget,per,spent,amount,count,active,pending,approvedMint,revoked}));checked++;
  }
  assert.equal(checked,28800);
});

test('integer allocation conserves every atom across 10000 portfolios',()=>{
  for(let n=1;n<=10000;n++){
    const total=BigInt(n)*9007199254740993n;
    const a=n%10001,b=(10000-a)>>>1,c=10000-a-b;
    const result=allocateBudget(String(total),[{instrument:'A',weightBps:a},{instrument:'B',weightBps:b},{instrument:'C',weightBps:c}]);
    assert.equal(result.legs.reduce((sum,r)=>sum+BigInt(r.inputAtoms),BigInt(result.cashAtoms)),total);
    assert.ok(BigInt(result.cashAtoms)>=0n&&BigInt(result.cashAtoms)<3n);
  }
});

test('stopping a policy cannot bypass the cross-policy unresolved-wallet fence',()=>{
  const db=new DatabaseSync(':memory:');const journal=new AutonomyJournal(db);
  try{
    const c=config();journal.register(c,state());
    const prepared={owner:c.wallet,submitAllowed:true,transactionBase64:'fixture-only-not-a-transaction',preparedId:'p',quoteId:'q'};
    const facts={side:'BUY',mint:c.mints[0],inputAtoms:'1',messageHash:hash('fixture')};
    journal.stage(c.id,state(),prepared,facts);journal.stop(c.id,c.owner);
    const other={...c,id:'ef'.repeat(32)};journal.register(other,state());
    assert.throws(()=>journal.stage(other.id,state(),prepared,facts),/ORDER_UNRESOLVED/);
  }finally{db.close();}
});

test('approval digest is key-order independent but each economic term changes it',()=>{
  const c=config();const digest=hash(canonical(c));
  assert.equal(hash(canonical(Object.fromEntries(Object.entries(c).reverse()))),digest);
  for(const delta of [{buyBudgetAtoms:'301'},{perBuyAtoms:'199'},{maxOrders:'3'},{mints:[key(196)]},{wallet:key(197)},{approvalHash:'de'.repeat(32)},{expiresAt:'9000000000'}])
    assert.notEqual(hash(canonical({...c,...delta})),digest);
});
