import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {keyString} from '../lib/research-autonomy-policy.mjs';
import {PRIVY_APP_ID,stockMeshProviderPolicy,authorizationPublicKeyHash} from '../lib/research-autonomy-privy.mjs';
import {WalletConnectionService} from '../lib/research-wallet-connection.mjs';
const key=n=>keyString(Buffer.alloc(32,n));
function setup(db=new DatabaseSync(':memory:')){
 const owner=key(10),address=key(11),walletId='wallet123456',token='test-only-in-memory-jwt-never-persist';
 const publicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64');
 const settings={appId:PRIVY_APP_ID,signerId:'signer',policyId:'policy',policyOwnerId:'admin',authorizationKeyHash:authorizationPublicKeyHash(publicKey)};
 const user={id:'did:privy:user',is_guest:false,linked_accounts:[{type:'wallet',chain_type:'solana',address:owner,verified_at:1},{type:'wallet',chain_type:'solana',id:walletId,address,wallet_client_type:'privy',connector_type:'embedded',imported:false,delegated:true,user_can_sign:true}]};
 const wallet={id:walletId,address,chain_type:'solana',owner_id:'quorum',imported_at:null,exported_at:null,policy_ids:[],additional_signers:[{signer_id:'signer',override_policy_ids:['policy']}],entity:{type:'user',id:'user'}};
 let signCalls=0;
 const client={utils:()=>({auth:()=>({verifyAccessToken:async t=>{assert.equal(t,token);return{app_id:PRIVY_APP_ID,issuer:'privy.io',expiration:Math.floor(Date.now()/1000)+100,user_id:user.id};}})}),users:()=>({_get:async()=>user}),wallets:()=>({get:async()=>wallet,solana:()=>({signTransaction:()=>{signCalls++;throw Error('MUST_NOT_SIGN');}})}),policies:()=>({get:async()=>({...stockMeshProviderPolicy(),id:'policy',owner_id:'admin'})}),keyQuorums:()=>({get:async()=>({id:'signer',authorization_threshold:1,authorization_keys:[{public_key:publicKey}]})})};
 return{owner,address,walletId,token,user,wallet,client,settings,service:new WalletConnectionService({db,client,settings}),input:{address,walletId,accessToken:token},signed:()=>signCalls};
}
test('connect is durable, token-free, owner-bound and cannot activate or sign',async()=>{
 const f=setup();assert.equal(f.service.get(f.owner),null);const r=await f.service.connect(f.owner,f.input);
 assert.equal(r.phase,'CONNECTED');assert.equal(r.tradingEnabled,false);assert.equal(f.signed(),0);
 const dump=JSON.stringify(f.service.db.prepare('SELECT * FROM wallet_connections').all());assert.ok(!dump.includes(f.token));assert.ok(!dump.includes('appSecret'));
 assert.equal(f.service.get(key(12)),null);assert.deepEqual(Object.keys(f.service.publicSettings()).sort(),['appId','policyId','signerId']);
});
test('foreign owner, undelegated wallet, wrong policy and missing login never connect',async()=>{
 for(const tamper of [f=>f.user.linked_accounts.shift(),f=>f.user.linked_accounts[1].delegated=false,f=>f.wallet.additional_signers[0].override_policy_ids=[],f=>f.input.accessToken='']){
  const f=setup();tamper(f);await assert.rejects(f.service.connect(f.owner,f.input));assert.equal(f.service.get(f.owner),null);assert.equal(f.signed(),0);
 }
});
test('repeat connect is idempotent and disconnect stays off across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'xtxc-wallet-connection-')),path=join(dir,'test.sqlite');
 try {const f=setup(new DatabaseSync(path));await f.service.connect(f.owner,f.input);await f.service.connect(f.owner,f.input);assert.equal(f.service.db.prepare('SELECT COUNT(*) n FROM wallet_connections').get().n,1);
  f.service.disconnect(f.owner);f.service.db.close();const g=setup(new DatabaseSync(path));assert.equal(g.service.get(f.owner).phase,'DISCONNECTED');assert.equal(g.service.get(f.owner).tradingEnabled,false);g.service.db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('provider failure cannot overwrite the last verified connection',async()=>{
 const f=setup();await f.service.connect(f.owner,f.input);f.client.users=()=>({_get:async()=>{throw Error('OFFLINE');}});await assert.rejects(f.service.connect(f.owner,f.input));assert.equal(f.service.get(f.owner).phase,'CONNECTED');assert.equal(f.signed(),0);
});
