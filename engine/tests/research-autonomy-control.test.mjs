import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,sign} from 'node:crypto';
import {getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import {AutonomyControl,approvedAllocation} from '../lib/research-autonomy-control.mjs';
import {AutonomyJournal} from '../lib/research-autonomy-journal.mjs';
import {DevnetPolicyTransport} from '../lib/research-autonomy-devnet.mjs';
import {hash as planHash} from '../lib/research-agent-core.mjs';
import {DEVNET,COMPUTE,keyString,keyBytes,policyAddress,policyInstruction,verifyExactSignature} from '../lib/research-autonomy-policy.mjs';
import {decodeMessage} from '../lib/research-autonomy-wire.mjs';

const k=n=>keyString(Buffer.alloc(32,n));
function fixture(t){
 const pair=generateKeyPairSync('ed25519'),owner=keyString(pair.publicKey.export({format:'der',type:'spki'}).subarray(-32)),wallet=k(22),mint=k(23),verifier=k(24),db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const doc={schema:'xtxc.research-plan/v1',owner:`solana:${owner}`,strategyId:'fixture-strategy',briefHash:'ab'.repeat(32),runId:'run-1',candidateId:'evidence',reportHash:'cd'.repeat(32),goal:{},budgetAtoms:'3000000',budgetAsset:'USDC',budgetScope:'NEW_CAPITAL',universe:['NVDA','AMD'],legs:[{side:'BUY',inputDecimals:6,instrument:'NVDA',inputAtoms:'2000000'},{side:'BUY',inputDecimals:6,instrument:'AMD',inputAtoms:'1000000'}],cashAtoms:'0',maxSlippageBps:20,createdAt:Date.now(),expiresAt:Date.now()+3600000,nonce:'fixture'};
 const plan={...doc,id:planHash(doc),status:'APPROVED'},binding={schema:'xtxc.privy-connection/v1',owner,address:wallet,walletId:'fixturewallet',enabled:false};let signs=0,submits=0,quotes=0;
 const journal=new AutonomyJournal(db),fetcher=async(url,init)=>{assert.equal(url,'https://api.devnet.solana.com');const {method}=JSON.parse(init.body);return Response.json({id:1,result:method==='getGenesisHash'?DEVNET:method==='getLatestBlockhash'?{value:{blockhash:k(28),lastValidBlockHeight:99}}:{value:[null]}});};
 const devnet=new DevnetPolicyTransport(db,{address:verifier,signDevnet:()=>{throw Error('unexpected signing');}},fetcher);
 const stockmesh={quote:async q=>{quotes++;return{schema:'skew.stockmesh.exposure-quote/v2',quoteId:'fixture',instrument:q.instrument,inputSymbol:'USDC',inAmountAtoms:q.instrument==='NVDA'?'2000000':'1000000',exposure:{estimatedQ32:'1000',minimumQ32:'999',products:[{mint:q.instrument==='NVDA'?mint:k(25),rawOutputAtoms:'100000'}]}};},portfolio:async owner=>({schema:'skew.stockmesh.portfolio/v1',network:'mainnet-beta',owner,stateSlot:1,observedAt:new Date().toISOString(),cash:[{symbol:'USDC',atoms:'3000000',decimals:6},{symbol:'SOL',atoms:'10000000',decimals:9}],holdings:[]}),submit:async()=>{submits++;}};
 const gate=new AutonomyControl({journal,devnet,verifier,stockmesh,mainnet:{},connection:async()=>binding,signer:()=>({signTransaction:async()=>{signs++;}})});
 return{db,gate,journal,devnet,pair,owner,wallet,mint,plan,stockmesh,counts:()=>({signs,submits,quotes})};
}
test('exact plan version, owner, amounts and universe are required',t=>{const x=fixture(t);assert.equal(approvedAllocation(x.owner,x.plan).id,x.plan.id);for(const change of [{owner:`solana:${k(55)}`},{budgetAtoms:'9000000'},{id:'f'.repeat(64)},{legs:[]}])assert.throws(()=>approvedAllocation(x.owner,{...x.plan,...change}));assert.throws(()=>approvedAllocation(k(55),x.plan));});
test('draft binds exact mints/budget; repeated requests return the same policy and do not sign',async t=>{const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan});assert.equal(p.config.buyBudgetAtoms,'3000000');assert.equal(p.config.perBuyAtoms,'2000000');assert.equal(p.config.maxOrders,'2');assert.equal(p.config.expiresAt,'0');assert.equal(p.phase,'DRAFT');assert.equal((await x.gate.draft(x.owner,{plan:x.plan})).id,p.id);assert.deepEqual(x.counts(),{signs:0,submits:0,quotes:2});await assert.rejects(x.gate.start(x.owner,p.id,p.approvalHash),/OWNER_APPROVAL_REQUIRED/);});
test('another owner cannot read/start/stop a policy',async t=>{const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan});assert.throws(()=>x.gate.row(k(90),p.id),/APPROVAL_NOT_FOUND/);assert.throws(()=>x.gate.stop(k(90),p.id));await assert.rejects(x.gate.start(k(90),p.id,p.approvalHash));});
test('discard unsigned draft is owner-scoped, idempotent and fences late wallet responses',async t=>{
 const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan}),ready=await x.gate.prepareApproval(x.owner,p.id);
 const tx=getTransactionDecoder().decode(Buffer.from(ready.preparedApproval.transactionBase64,'base64'));
 const signed=Buffer.from(getTransactionEncoder().encode({...tx,signatures:{[x.owner]:sign(null,Buffer.from(tx.messageBytes),x.pair.privateKey)}})).toString('base64');
 assert.throws(()=>x.gate.discardUnsignedDraft(k(90),p.id));
 const proof=x.gate.discardUnsignedDraft(x.owner,p.id);
 assert.equal(proof.reason,'UNSIGNED_DRAFT_SUPERSEDED');assert.equal(proof.planId,x.plan.id);
 assert.deepEqual(x.gate.discardUnsignedDraft(x.owner,p.id),proof);
 await assert.rejects(x.gate.submitApproval(x.owner,p.id,signed),/APPROVAL_NOT_PREPARED/);
 await assert.rejects(x.gate.prepareApproval(x.owner,p.id),/APPROVAL_ALREADY_SENT/);
 assert.equal(x.db.prepare('SELECT count(*) n FROM policy_transports').get().n,0);
 assert.equal(x.counts().signs,0);assert.equal(x.counts().submits,0);
});
test('discard never touches a signed approval even before transport sends',async t=>{
 const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan}),ready=await x.gate.prepareApproval(x.owner,p.id);
 const tx=getTransactionDecoder().decode(Buffer.from(ready.preparedApproval.transactionBase64,'base64'));
 const signed=Buffer.from(getTransactionEncoder().encode({...tx,signatures:{[x.owner]:sign(null,Buffer.from(tx.messageBytes),x.pair.privateKey)}})).toString('base64');
 await x.gate.submitApproval(x.owner,p.id,signed);
 assert.throws(()=>x.gate.discardUnsignedDraft(x.owner,p.id),/PREVIOUS_APPROVAL_HAS_AUTHORITY/);
 assert.equal(x.gate.row(x.owner,p.id).phase,'APPROVAL_PENDING');
 assert.equal(x.db.prepare('SELECT attempts FROM policy_transports').get().attempts,0);
});
for(const phase of ['READY','RUNNING','ATTENTION','COMPLETE','STOPPED'])test('discard cannot replace '+phase,async t=>{
 const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan});x.gate.save(x.gate.row(x.owner,p.id),phase);
 assert.throws(()=>x.gate.discardUnsignedDraft(x.owner,p.id),/PREVIOUS_APPROVAL_HAS_AUTHORITY/);
 assert.equal(x.gate.row(x.owner,p.id).phase,phase);
});
test('mints follow real quotes and mismatched/overslipped responses cannot create approval',async t=>{const x=fixture(t);x.stockmesh.quote=async()=>({schema:'skew.stockmesh.exposure-quote/v2',instrument:'NVDA',inputSymbol:'USDC',inAmountAtoms:'9000000',exposure:{products:[{mint:x.mint}]}});await assert.rejects(x.gate.draft(x.owner,{plan:x.plan}),/QUOTE_MISMATCH/);assert.equal(x.db.prepare('SELECT count(*) n FROM autonomy_bindings').get().n,0);});
test('signed owner approval is saved before transport and cannot be replaced',async t=>{const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan}),ready=await x.gate.prepareApproval(x.owner,p.id),tx=getTransactionDecoder().decode(Buffer.from(ready.preparedApproval.transactionBase64,'base64')),signed=Buffer.from(getTransactionEncoder().encode({...tx,signatures:{[x.owner]:sign(null,Buffer.from(tx.messageBytes),x.pair.privateKey)}})).toString('base64');const r=await x.gate.submitApproval(x.owner,p.id,signed);assert.equal(r.phase,'APPROVAL_PENDING');assert.equal(x.db.prepare('SELECT attempts FROM policy_transports').get().attempts,0);assert.equal((await x.gate.submitApproval(x.owner,p.id,signed)).id,p.id);await assert.rejects(x.gate.prepareApproval(x.owner,p.id),/APPROVAL_ALREADY_SENT/);assert.equal(x.counts().signs,0);});
test('unsigned or modified approvals are rejected without a transport entry',async t=>{const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan}),ready=await x.gate.prepareApproval(x.owner,p.id);await assert.rejects(x.gate.submitApproval(x.owner,p.id,ready.preparedApproval.transactionBase64));assert.equal(x.db.prepare('SELECT count(*) n FROM policy_transports').get().n,0);});
test('owner approval has explicit zero fees and bounded compute before wallet signing',async t=>{
 const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan}),ready=await x.gate.prepareApproval(x.owner,p.id);
 const wire=Buffer.from(ready.preparedApproval.transactionBase64,'base64'),tx=getTransactionDecoder().decode(wire);
 assert.equal(wire[0],1);assert.equal(tx.messageBytes[0],128);assert.ok(wire.length<=1232);
 const m=await decodeMessage(wire.toString('base64'),async()=>{throw Error('unexpected lookup');});
 assert.equal(m.instructions.length,3);assert.equal(m.wallet,x.owner);
 assert.equal(m.instructions[0].program,COMPUTE);assert.equal(m.instructions[0].data[0],2);
 assert.equal(m.instructions[0].data.readUInt32LE(1),200000);
 assert.equal(m.instructions[1].program,COMPUTE);assert.equal(m.instructions[1].data[0],3);
 assert.equal(m.instructions[1].data.readBigUInt64LE(1),0n);
 const config=x.gate.row(x.owner,p.id).config,original=await policyInstruction(config,'APPROVE');
 assert.equal(m.instructions[2].program,config.program);
 assert.deepEqual(m.instructions[2].accounts,original.accounts.map(a=>a.address));
 assert.deepEqual(m.instructions[2].data,Buffer.from(original.data));
 assert.equal(x.db.prepare('SELECT count(*) n FROM policy_transports').get().n,0);
 assert.equal(x.counts().signs,0);assert.equal(x.counts().submits,0);
});
test('owner approval fee and policy tampering still fail exact signature verification',async t=>{
 const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan}),ready=await x.gate.prepareApproval(x.owner,p.id);
 const expected=ready.preparedApproval.transactionBase64,tx=getTransactionDecoder().decode(Buffer.from(expected,'base64'));
 const make=messageBytes=>Buffer.from(getTransactionEncoder().encode({...tx,messageBytes,signatures:{[x.owner]:sign(null,Buffer.from(messageBytes),x.pair.privateKey)}})).toString('base64');
 assert.ok(verifyExactSignature(expected,make(tx.messageBytes),x.owner));
 const fee=Buffer.from([3,0,0,0,0,0,0,0,0]),offset=Buffer.from(tx.messageBytes).indexOf(fee);
 assert.ok(offset>=0);
 for(const position of [offset+1,tx.messageBytes.length-2]){
  const changed=Uint8Array.from(tx.messageBytes);changed[position]^=1;
  await assert.rejects(x.gate.submitApproval(x.owner,p.id,make(changed)),/SIGNER_CHANGED_TRANSACTION/);
 }
 assert.equal(x.db.prepare('SELECT count(*) n FROM policy_transports').get().n,0);
});
test('stopping while funding is being checked wins over Start',async t=>{const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan});x.gate.save(x.gate.row(x.owner,p.id),'READY');x.stockmesh.portfolio=async()=>{x.gate.stop(x.owner,p.id);throw Error('stop race');};await assert.rejects(x.gate.start(x.owner,p.id,p.approvalHash));assert.equal(x.gate.row(x.owner,p.id).phase,'STOPPED');assert.equal(x.counts().signs,0);});
test('agent funds are checked on the bound wallet, not personal holdings',async t=>{const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan});x.gate.save(x.gate.row(x.owner,p.id),'READY');x.stockmesh.portfolio=async owner=>({schema:'skew.stockmesh.portfolio/v1',network:'mainnet-beta',owner,stateSlot:1,observedAt:new Date().toISOString(),cash:[{symbol:'USDC',atoms:'0',decimals:6},{symbol:'SOL',atoms:'100',decimals:9}],holdings:[]});await assert.rejects(x.gate.start(x.owner,p.id,p.approvalHash),/AGENT_WALLET_NEEDS_USDC/);assert.equal(x.gate.row(x.owner,p.id).phase,'READY');});
test('proven no-fill stops a partial allocation and releases policy without a new trade',async t=>{
 const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan}),r=x.gate.row(x.owner,p.id);
 x.journal.register(r.config,{active:true,pending:false,count:'0',reservedAtoms:'0',slot:1});x.gate.save({...r,binding:{...r.binding,enabled:true},error:'STOCKLANA_SUBMISSION_CONFLICT'},'ATTENTION');
 const record={id:'expired',policy:p.id,wallet:x.wallet,counter:'0',phase:'EXPIRED_NO_FILL',facts:{instrument:'NVDA'},settlementSignature:'settled',engineReconciled:{phase:'NOT_ADMITTED'}};
 x.db.prepare('INSERT INTO autonomy_orders VALUES(?,?,?,?,?,?)').run(record.id,p.id,'0',x.wallet,record.phase,JSON.stringify(record));
 await x.gate.tick(p.id);assert.equal(x.gate.row(x.owner,p.id).phase,'STOPPED');assert.equal(x.gate.row(x.owner,p.id).binding.enabled,false);assert.equal(x.journal.policy(p.id).phase,'STOPPED');assert.equal(x.counts().signs,0);assert.equal(x.counts().submits,0);
 await x.gate.tick(p.id);assert.equal(x.counts().signs,0);assert.equal(x.db.prepare('SELECT count(*) n FROM autonomy_orders').get().n,1);
});
test('independent strategies start together; shared cash cannot be reserved twice',async t=>{
 const x=fixture(t),{id,status,...doc}=x.plan;const plans=[x.plan,...['second','third'].map(nonce=>{const d={...doc,nonce};return{...d,id:planHash(d),status};})];
 const bindings=[];for(const plan of plans){const p=await x.gate.draft(x.owner,{plan});bindings.push(p);x.gate.save(x.gate.row(x.owner,p.id),'READY');}
 const portfolio=x.stockmesh.portfolio;x.stockmesh.portfolio=async owner=>{const p=await portfolio(owner);p.cash[0].atoms='6000000';return p;};
 x.devnet.observe=async c=>{const {state,bump}=await policyAddress(c),d=Buffer.alloc(616);d.write('XTXCDMP2');for(const [p,key] of [[8,c.owner],[40,c.verifier],[72,c.wallet]])keyBytes(key).copy(d,p);Buffer.from(c.id,'hex').copy(d,104);Buffer.from(c.approvalHash,'hex').copy(d,136);for(const [p,v] of [[168,c.startsAt],[176,c.expiresAt],[184,c.buyBudgetAtoms],[208,c.maxOrders],[216,c.perBuyAtoms]])d.writeBigUInt64LE(BigInt(v),p);d[227]=bump;Buffer.from(c.tradeRoot,'hex').copy(d,344);return{genesisHash:DEVNET,commitment:'finalized',address:state,owner:c.program,slot:1,observedAt:Date.now(),dataBase64:d.toString('base64')};};
 await x.gate.start(x.owner,bindings[0].id,bindings[0].approvalHash);
 const outcomes=await Promise.allSettled(bindings.slice(1).map(p=>x.gate.start(x.owner,p.id,p.approvalHash)));
 assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.match(outcomes.find(o=>o.status==='rejected').reason.message,/BUDGET_RESERVED/);
 assert.equal(x.db.prepare("SELECT count(*) n FROM autonomy_bindings WHERE phase='RUNNING'").get().n,2);assert.equal(x.counts().signs,0);assert.equal(x.counts().submits,0);
});
test('an ongoing authority activated during legacy Start funding checks wins before reservation',async t=>{
 const x=fixture(t),p=await x.gate.draft(x.owner,{plan:x.plan});x.gate.save(x.gate.row(x.owner,p.id),'READY');
 x.db.exec('CREATE TABLE ongoing_mandates(id TEXT,wallet TEXT,phase TEXT); CREATE TABLE ongoing_execution_orders(id TEXT,wallet TEXT,phase TEXT);');
 x.devnet.observe=async c=>{
  x.db.prepare('INSERT INTO ongoing_mandates VALUES(?,?,?)').run('ongoing',x.wallet,'ACTIVE');
  const {state,bump}=await policyAddress(c),d=Buffer.alloc(616);d.write('XTXCDMP2');for(const [p,key] of [[8,c.owner],[40,c.verifier],[72,c.wallet]])keyBytes(key).copy(d,p);Buffer.from(c.id,'hex').copy(d,104);Buffer.from(c.approvalHash,'hex').copy(d,136);for(const [p,v] of [[168,c.startsAt],[176,c.expiresAt],[184,c.buyBudgetAtoms],[208,c.maxOrders],[216,c.perBuyAtoms]])d.writeBigUInt64LE(BigInt(v),p);d[227]=bump;Buffer.from(c.tradeRoot,'hex').copy(d,344);
  return {genesisHash:DEVNET,commitment:'finalized',address:state,owner:c.program,slot:1,observedAt:Date.now(),dataBase64:d.toString('base64')};
 };
 await assert.rejects(x.gate.start(x.owner,p.id,p.approvalHash),/WALLET_ALREADY_MANAGED/);
 assert.equal(x.gate.row(x.owner,p.id).phase,'READY');assert.equal(x.db.prepare('SELECT count(*) n FROM autonomy_policies').get().n,0);
});

test('rebalance binds agent-held sells and subsequent purchases without counting token atoms as USDC',async t=>{
 const x=fixture(t),{id,status,...doc}=x.plan;
 Object.assign(doc,{budgetScope:'SELECTED_HOLDINGS_PLUS_NEW_CASH',budgetAtoms:'0',cashFloorAtoms:'1000000',cashAtoms:'1000000',snapshot:{owner:x.wallet,holdings:[{instrument:'NVDA',mint:x.mint,rawDecimals:9,atoms:'1000000000'}]},legs:[{instrument:'NVDA',side:'SELL',inputAtoms:'1000000000',inputDecimals:9,productMint:x.mint,minimumCashAtoms:'2000000'},{instrument:'AMD',side:'BUY',inputAtoms:'1000000',inputDecimals:6}]});
 const plan={...doc,id:planHash(doc),status},buy=x.stockmesh.quote;
 x.stockmesh.quote=async q=>q.side==='BUY'?buy(q):{schema:'skew.stockmesh.liquidation-quote/v1',side:'SELL',instrument:q.instrument,quoteId:'sell',inputProduct:{mint:x.mint,inputAtoms:q.inputAtoms},output:{symbol:'USDC',decimals:6,estimatedAtoms:'2001000',minimumAtoms:'2000000'},expiresAt:new Date(Date.now()+30000).toISOString()};
 const p=await x.gate.draft(x.owner,{plan});assert.equal(p.config.schema,'xtxc.autonomy-policy/v2');assert.equal(p.config.buyBudgetAtoms,'1000000');assert.equal(p.config.trades[0].side,'SELL');assert.equal(p.config.trades[0].inputAtoms,'1000000000');assert.equal(x.counts().signs,0);
 const bad={...doc,snapshot:{...doc.snapshot,owner:x.owner}};
 await assert.rejects(x.gate.draft(x.owner,{plan:{...bad,id:planHash(bad),status}}),/REVIEW_AGENT_WALLET_HOLDINGS/);
 const tooMuch={...doc,legs:[{...doc.legs[0],inputAtoms:'1000000001'},doc.legs[1]]};
 assert.throws(()=>approvedAllocation(x.owner,{...tooMuch,id:planHash(tooMuch),status}),/SELL_EXCEEDS_APPROVED_HOLDINGS/);
});
