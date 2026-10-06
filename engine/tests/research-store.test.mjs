import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResearchStore, validateBrief } from '../lib/research-store.mjs';
const a='solana:'+'1'.repeat(32),b='solana:'+'2'.repeat(32);
const brief={name:'AI infrastructure',objective:'Compare after fees.',budget:'100',instruments:['NVDA','AMD'],weights:[],cashBps:null};
test('durable owner-bound workspace, idempotency, revision conflict and recovery',()=>{
 const dir=mkdtempSync(join(tmpdir(),'xtxc-research-'));let store=new ResearchStore(join(dir,'state.sqlite'),['NVDA','AMD']);
 try{
  const request={operation:'CREATE',requestId:randomUUID(),brief};
  const created=store.mutate(a,request);assert.equal(created.status,'DRAFT');assert.equal(created.revision,1);
  assert.equal(store.mutate(a,request).id,created.id);assert.equal(store.read(a).strategies.length,1);
  assert.throws(()=>store.mutate(a,{...request,brief:{...brief,name:'Different'}}),e=>e.status===409);
  assert.equal(store.read(b).strategies.length,0);assert.equal(store.read(b).events.length,0);
  assert.throws(()=>store.read(b,created.id),e=>e.status===404);
  assert.throws(()=>store.mutate(b,{operation:'UPDATE',id:created.id,revision:1,brief,requestId:randomUUID()}),e=>e.status===404);
  const note={operation:'NOTE',id:created.id,revision:1,text:'Source: SEC filing. Do not use future data.',requestId:randomUUID()};
  assert.equal(store.mutate(a,note).revision,2);assert.equal(store.mutate(a,note).messages.length,1);
  assert.throws(()=>store.mutate(a,{operation:'UPDATE',id:created.id,revision:1,brief,requestId:randomUUID()}),e=>e.status===409);
  const result=store.read(a,created.id);assert.equal(result.events.length,2);assert.equal(store.read(a,null,result.cursor).events.length,0);
  store.close();store=new ResearchStore(join(dir,'state.sqlite'),['NVDA','AMD']);
  assert.equal(store.read(a,created.id).strategy.messages[0].text,note.text);
  assert.equal(store.mutate(a,note).revision,2);
  assert.equal(store.mutate(a,{operation:'UPDATE',id:created.id,revision:2,brief:{...brief,name:'Updated'},requestId:randomUUID()}).name,'Updated');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('input bounds and integer portfolio allocation',()=>{
 for(const input of [{...brief,budget:'1e9'},{...brief,budget:'0'},{...brief,instruments:['FAKE']},{...brief,instruments:['NVDA','NVDA']},{...brief,name:'x'.repeat(81)},{...brief,objective:'\u0000'},{...brief,weights:[{instrument:'NVDA',weightBps:9000}],cashBps:1000}])assert.throws(()=>validateBrief(input,['NVDA','AMD']));
 const allocated={...brief,weights:[{instrument:'NVDA',weightBps:5500},{instrument:'AMD',weightBps:3500}],cashBps:1000};assert.deepEqual(validateBrief(allocated,['NVDA','AMD']),allocated);
});
