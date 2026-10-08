import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '../lib/research-agent-core.mjs';

const owner='solana:'+'1'.repeat(32),other='solana:'+'2'.repeat(32);
const brief={name:'Expiry regression',objective:'Research only.',budget:'2',instruments:['NVDA'],weights:[],cashBps:null};
const goal={targetReturnBps:500,horizonDays:365,maxDrawdownBps:2000,maxWeightBps:5000,minCashBps:5000,costBps:50};
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'sta-expiry-test-'));
  const path=join(dir,'state.sqlite'),s=new AgentStore(path,brief.instruments);
  t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true});});
  return {s,path,strategy:s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief})};
}
function review(s,strategy){
  const id=s.enqueue(owner,strategy.id,goal,randomUUID()),run=s.claim();
  assert.equal(run.id,id);
  s.finish(run,'REVIEW',{candidates:[{id:'defensive',verdict:'ELIGIBLE',weights:[{instrument:'NVDA',weightBps:5000}]}]});
  return s.view(owner,strategy.id).runs[0];
}
function approved(s,strategy){const r=review(s,strategy);return s.approve(owner,r.id,'defensive',r.result.reportHash);}
function deadline(s,p,value=Date.now()-1000){
  // Fixture clock only; production expiry never rewrites the hashed document.
  s.db.prepare('UPDATE agent_plans SET document=? WHERE id=?').run(JSON.stringify({...p,expiresAt:value}),p.id);
  return s.db.prepare('SELECT document FROM agent_plans WHERE id=?').get(p.id).document;
}
function expiryEvents(s,id){return s.db.prepare("SELECT * FROM agent_events WHERE kind='APPROVAL_EXPIRED' AND json_extract(document,'$.planId')=?").all(id);}

test('view expires only unused approval and retains exact document plus one durable event',t=>{
  const {s,strategy,path}=setup(t),p=approved(s,strategy),document=deadline(s,p);
  assert.equal(s.view(owner,strategy.id).plans[0].status,'EXPIRED');
  assert.equal(s.db.prepare('SELECT document FROM agent_plans WHERE id=?').get(p.id).document,document);
  assert.deepEqual(s.expireUnusedPlans(owner),[]);
  assert.equal(expiryEvents(s,p.id).length,1);
  const reopened=new AgentStore(path,brief.instruments);
  try{assert.equal(reopened.plan(owner,p.id).status,'EXPIRED');assert.equal(expiryEvents(reopened,p.id).length,1);}
  finally{reopened.close();}
  assert.throws(()=>s.reserveStep(owner,p.id,0),/no longer current/);
  assert.throws(()=>s.claimAutonomy(owner,p.id,'a'.repeat(64)),/unused allocation/);
});

test('new approval clears expired blocker from a different strategy without a prior view',t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy);
  const next=s.mutate(owner,{operation:'CREATE',requestId:randomUUID(),brief:{...brief,name:'Next strategy'}});
  const r=review(s,next);deadline(s,p);
  const q=s.approve(owner,r.id,'defensive',r.result.reportHash);
  assert.notEqual(q.id,p.id);assert.equal(s.plan(owner,p.id).status,'EXPIRED');
  assert.equal(s.plan(owner,q.id).status,'APPROVED');assert.equal(expiryEvents(s,p.id).length,1);
});

test('failed retry cannot roll back expiry or silently re-approve an expired run',t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy);deadline(s,p);
  assert.throws(()=>s.approve(owner,p.runId,p.candidateId,p.reportHash),/expired without a trade/);
  assert.equal(s.plan(owner,p.id).status,'EXPIRED');
  assert.equal(s.db.prepare('SELECT count(*) n FROM agent_plans').get().n,1);
  assert.equal(expiryEvents(s,p.id).length,1);
});

test('future approvals coexist; explicit deadline equality is expired',t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy),r=review(s,strategy);
  assert.deepEqual(s.expireUnusedPlans(owner,p.expiresAt-1),[]);
  assert.ok(s.approve(owner,r.id,'defensive',r.result.reportHash).id);
  assert.deepEqual(s.expireUnusedPlans(owner,p.expiresAt),[p.id]);
});

for(const phase of ['PREPARING','PREPARED','UNKNOWN','SUBMITTED','FINALIZED','RECONCILED','FAILED','EXPIRED_UNSENT']){
  test('expiry never discards a plan with any execution record: '+phase,t=>{
    const {s,strategy}=setup(t),p=approved(s,strategy);
    s.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?)').run(p.id,0,phase,JSON.stringify({leg:p.legs[0]}));
    deadline(s,p);
    assert.deepEqual(s.expireUnusedPlans(owner),[]);
    assert.equal(s.plan(owner,p.id).status,'APPROVED');assert.equal(expiryEvents(s,p.id).length,0);
    const r=review(s,strategy);
    assert.ok(s.approve(owner,r.id,'defensive',r.result.reportHash).id);
    assert.equal(s.db.prepare('SELECT phase FROM agent_steps WHERE plan_id=?').get(p.id).phase,phase);
  });
}

test('an agent-wallet claim fences expiry even with no locally observed orders',t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy);
  s.claimAutonomy(owner,p.id,'a'.repeat(64));deadline(s,p);
  assert.deepEqual(s.expireUnusedPlans(owner),[]);
  assert.equal(s.view(owner,strategy.id).plans[0].status,'APPROVED');
  assert.equal(expiryEvents(s,p.id).length,0);
  const r=review(s,strategy);
  assert.ok(s.approve(owner,r.id,'defensive',r.result.reportHash).id);
});

test('expiry is owner-scoped and cannot change another wallet approval',t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy);deadline(s,p);
  assert.deepEqual(s.expireUnusedPlans(other),[]);
  assert.throws(()=>s.view(other,strategy.id),/not found/);
  assert.equal(s.plan(owner,p.id).status,'APPROVED');
  assert.deepEqual(s.expireUnusedPlans(owner),[p.id]);
});

for(const invalid of [null,0,-1,'1',1.5]){
  test('malformed legacy deadline remains blocked: '+JSON.stringify(invalid),t=>{
    const {s,strategy}=setup(t),p=approved(s,strategy);deadline(s,p,invalid);
    assert.deepEqual(s.expireUnusedPlans(owner),[]);
    assert.equal(s.plan(owner,p.id).status,'APPROVED');
  });
}

test('a second database connection observes reservation and new-approval fences',t=>{
  const {s,strategy,path}=setup(t),p=approved(s,strategy);
  const peer=new AgentStore(path,brief.instruments);
  try{
    peer.reserveStep(owner,p.id,0);deadline(s,p);
    assert.deepEqual(s.expireUnusedPlans(owner),[]);
    peer.releaseUnsignedPreparation(owner,p.id,0);
    assert.deepEqual(s.expireUnusedPlans(owner),[p.id]);
    const r=review(s,strategy),q=peer.approve(owner,r.id,'defensive',r.result.reportHash);
    const next=review(s,strategy);
    assert.ok(s.approve(owner,next.id,'defensive',next.result.reportHash).id);
    assert.equal(s.plan(owner,q.id).status,'APPROVED');
    assert.equal(expiryEvents(s,p.id).length,1);
  }finally{peer.close();}
});

test('new explicit approval preserves another strategy and is idempotent',async t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy),r=review(s,strategy);
  const before=s.db.prepare('SELECT document FROM agent_plans WHERE id=?').get(p.id).document;
  const q=await s.approveReplacingUnused(owner,r.id,'defensive',r.result.reportHash,null,()=>{throw Error('no claim');});
  assert.equal(s.plan(owner,p.id).status,'APPROVED');assert.equal(s.plan(owner,q.id).status,'APPROVED');
  assert.equal(s.db.prepare('SELECT document FROM agent_plans WHERE id=?').get(p.id).document,before);
  assert.equal(s.approve(owner,p.runId,p.candidateId,p.reportHash).id,p.id);
  assert.equal((await s.approveReplacingUnused(owner,r.id,'defensive',r.result.reportHash,null,()=>{throw Error('retry');})).id,q.id);
});

test('another claimed draft is not stopped by a new strategy approval',async t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy),policy='a'.repeat(64);s.claimAutonomy(owner,p.id,policy);
  const r=review(s,strategy);let calls=0;
  const q=await s.approveReplacingUnused(owner,r.id,'defensive',r.result.reportHash,null,async(raw,id)=>{calls++;assert.equal(raw,owner.slice(7));assert.equal(id,policy);return{id,planId:p.id,phase:'STOPPED',reason:'UNSIGNED_DRAFT_SUPERSEDED'};});
  assert.equal(calls,0);assert.equal(s.plan(owner,p.id).status,'APPROVED');
  s.syncAutonomy(owner,p.id,{id:policy,planId:p.id,phase:'DRAFT',orders:[]});
  assert.equal(s.plan(owner,p.id).status,'APPROVED');assert.equal(s.plan(owner,q.id).status,'APPROVED');
  s.claimAutonomy(owner,p.id,policy);
});

test('active or unknown execution cannot obstruct new research approval',async t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy);s.claimAutonomy(owner,p.id,'b'.repeat(64));const r=review(s,strategy);
  for(const proof of [null,{id:'b'.repeat(64),planId:p.id,phase:'READY'},{id:'c'.repeat(64),planId:p.id,phase:'STOPPED',reason:'UNSIGNED_DRAFT_SUPERSEDED'}]){
    assert.ok((await s.approveReplacingUnused(owner,r.id,'defensive',r.result.reportHash,null,async()=>proof)).id);
    assert.equal(s.plan(owner,p.id).status,'APPROVED');
  }
  assert.ok((await s.approveReplacingUnused(owner,r.id,'defensive',r.result.reportHash,null,async()=>{throw Error('must not inspect signer');})).id);
  assert.equal(s.db.prepare('SELECT count(*) n FROM agent_plans').get().n,2);
});

test('approval never invokes destructive replacement or its authority callback',async t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy),policy='d'.repeat(64);s.claimAutonomy(owner,p.id,policy);const r=review(s,strategy);
  assert.ok((await s.approveReplacingUnused(owner,r.id,'defensive',r.result.reportHash,null,async()=>{
    s.db.prepare('INSERT INTO agent_steps VALUES(?,?,?,?)').run(p.id,0,'UNKNOWN','{}');
    return{id:policy,planId:p.id,phase:'STOPPED',reason:'UNSIGNED_DRAFT_SUPERSEDED'};
  })).id);
  assert.equal(s.plan(owner,p.id).status,'APPROVED');
});

test('invalid new allocation rolls back replacement and preserves prior approval',async t=>{
  const {s,strategy}=setup(t),p=approved(s,strategy),r=review(s,strategy);
  await assert.rejects(s.approveReplacingUnused(owner,r.id,'defensive',r.result.reportHash,'missing-draft',()=>{throw Error('no claim');}),/matching holdings/);
  assert.equal(s.plan(owner,p.id).status,'APPROVED');
  assert.equal(s.db.prepare("SELECT count(*) n FROM agent_events WHERE kind='APPROVAL_SUPERSEDED'").get().n,0);
});
