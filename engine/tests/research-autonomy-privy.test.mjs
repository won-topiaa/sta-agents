import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {getTransactionDecoder,getTransactionEncoder} from '@solana/kit';
import {canonical,hash,keyString,policyTransaction,COMPUTE} from '../lib/research-autonomy-policy.mjs';
import {PRIVY_APP_ID,stockMeshProviderPolicy,providerPolicyHash,authorizationPublicKeyHash,
 assertProviderPolicy,verifyPrivyEnrollment,PrivyDelegatedSigner,createIsolatedPrivyClient}
 from '../lib/research-autonomy-privy.mjs';

const key=n=>keyString(Buffer.alloc(32,n));
function fixture(){
 const auth=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),payer=generateKeyPairSync('ed25519');
 const wallet=keyString(payer.publicKey.export({type:'spki',format:'der'}).subarray(-32));
 const publicKey=auth.publicKey.export({format:'der',type:'spki'}).toString('base64');
 const config={schema:'xtxc.autonomy-policy/v1',executionChain:'solana:mainnet',evidenceChain:'solana:devnet',
  program:key(191),owner:key(192),verifier:key(193),wallet,id:'ab'.repeat(32),approvalHash:'cd'.repeat(32),
  startsAt:'0',expiresAt:'0',buyBudgetAtoms:'3000000',perBuyAtoms:'2000000',maxOrders:'2',
  mints:[key(195)],maxSlippageBps:20,feeBudgetLamports:null};
 const settings={appId:PRIVY_APP_ID,signerId:'signer',policyId:'policy',policyOwnerId:null,
  authorizationKeyHash:authorizationPublicKeyHash(publicKey)};
 const claims={app_id:PRIVY_APP_ID,issuer:'privy.io',expiration:Math.floor(Date.now()/1000)+3600,user_id:'did:privy:test'};
 const user={id:claims.user_id,is_guest:false,linked_accounts:[
  {type:'wallet',chain_type:'solana',address:config.owner,verified_at:100},
  {id:'wallet',type:'wallet',chain_type:'solana',address:wallet,wallet_client_type:'privy',
   connector_type:'embedded',imported:false,delegated:true,user_can_sign:true}]};
 const state={claims,user,wallet:{id:'wallet',address:wallet,chain_type:'solana',owner_id:'owner-quorum',
  imported_at:null,exported_at:null,policy_ids:[],additional_signers:[{signer_id:'signer',override_policy_ids:['policy']}],
  entity:{type:'user',id:user.id}},policy:{...stockMeshProviderPolicy(),id:'policy',owner_id:null},
  quorum:{id:'signer',authorization_threshold:1,authorization_keys:[{public_key:publicKey}],user_ids:null},
  signed:0,reads:0,signInputs:[],response:null};
 const client={utils:()=>({auth:()=>({verifyAccessToken:async()=>structuredClone(state.claims)})}),
  users:()=>({_get:async()=>{state.reads++;return structuredClone(state.user);}}),
  policies:()=>({get:async()=>structuredClone(state.policy)}),keyQuorums:()=>({get:async()=>structuredClone(state.quorum)}),
  wallets:()=>({get:async()=>structuredClone(state.wallet),solana:()=>({signTransaction:async(id,input)=>{
   state.signed++;state.signInputs.push({id,...input});return state.response;
  }})})};
 const context={authorization_private_keys:[auth.privateKey.export({format:'der',type:'pkcs8'}).toString('base64')]};
 const enroll=()=>verifyPrivyEnrollment({client,settings,config,sessionOwner:config.owner,
  accessToken:'test-only-token-not-a-credential',walletId:'wallet'});
 const activate=async()=>({...await enroll(),enabled:true}); // fixture activation, never a live user authorization
 return {config,settings,state,client,context,enroll,activate,payer};
}
test('verified enrollment is pending, token-free and bound to the entire approved configuration',async()=>{
 const f=fixture(),b=await f.enroll();assert.equal(b.enabled,false);assert.equal(b.walletOwnerId,'owner-quorum');
 assert.equal(b.configHash,hash(canonical(f.config)));assert.equal(b.providerPolicyHash,providerPolicyHash());
 assert.doesNotMatch(JSON.stringify(b),/test-only-token|authorization_private_keys/);
 await assert.rejects(new PrivyDelegatedSigner(f.client,f.context,b).assertBinding(f.config),/NOT_CONNECTED/);
});
test('wrong app, issuer, expired token and foreign SIWS owner are denied',async()=>{
 for(const patch of [{app_id:'another-app'},{issuer:'other'},{expiration:1},{user_id:'not-a-did'}]){
  const f=fixture();Object.assign(f.state.claims,patch);await assert.rejects(f.enroll(),/TOKEN_INVALID/);
 }
 const f=fixture();await assert.rejects(verifyPrivyEnrollment({client:f.client,settings:f.settings,
  config:f.config,sessionOwner:key(5),accessToken:'token'}),/OWNER_SESSION_MISMATCH/);
});
test('ownership, imported wallet, disconnected consent and additional authorities are denied',async()=>{
 const changes=[s=>s.user.linked_accounts.shift(),s=>s.user.linked_accounts[1].delegated=false,
  s=>s.user.linked_accounts[1].imported=true,s=>s.user.linked_accounts[1].id='another-wallet',
  s=>s.user.linked_accounts[1].user_can_sign=false,s=>s.user.is_guest=true,
  s=>s.wallet.imported_at=100,s=>s.wallet.exported_at=100,s=>s.wallet.archived_at=100,
  s=>s.wallet.entity.id='did:privy:someone-else',s=>s.wallet.additional_signers=[],
  s=>s.wallet.additional_signers[0].override_policy_ids=[],
  s=>s.wallet.additional_signers.push({signer_id:'other'}),s=>s.wallet.automations=[{id:'other'}]];
 for(const change of changes){const f=fixture();change(f.state);await assert.rejects(f.enroll());assert.equal(f.state.signed,0);}
});
test('REST wallet entity uses a raw user ID; JWT/User DID stays exactly bound',async()=>{
 const f=fixture();f.state.wallet.entity.id='test';
 const b=await f.enroll();assert.equal(b.userId,'did:privy:test');assert.equal(b.enabled,false);
 const s=new PrivyDelegatedSigner(f.client,f.context,{...b,enabled:true});
 await s.assertBinding(f.config);assert.equal(f.state.signed,0);
 for(const id of ['other','test-extra','xtest','privy:test','did:privy:did:privy:test',' test','TEST','',null]){
  f.state.wallet.entity.id=id;
  await assert.rejects(f.enroll(),/ENTITY_MISMATCH/);
  await assert.rejects(s.assertBinding(f.config),/ENTITY_MISMATCH/);
 }
 f.state.wallet.entity={type:'organization',id:'test'};
 await assert.rejects(f.enroll(),/ENTITY_MISMATCH/);
});
test('provider rule widening and changed quorum fail before signing',async()=>{
 const changes=[s=>s.policy.rules[0].conditions=[],s=>s.policy.rules[0].method='signAndSendTransaction',
  s=>s.policy.rules[0].conditions[0].value.push('11111111111111111111111111111111'),
  s=>s.policy.rules.push({method:'signMessage',action:'ALLOW',conditions:[]}),
  s=>s.policy.owner_id='changed',s=>s.quorum.authorization_keys.push(s.quorum.authorization_keys[0]),
  s=>s.quorum.user_ids=['did:privy:other'],s=>s.quorum.key_quorum_ids=['nested'],
  s=>s.quorum.authorization_threshold=2];
 for(const change of changes){const f=fixture(),b=await f.activate();change(f.state);
  await assert.rejects(new PrivyDelegatedSigner(f.client,f.context,b).signTransaction(f.config,'wire','ef'.repeat(32)));
  assert.equal(f.state.signed,0);}
});
test('provider display metadata can change, permissions cannot',()=>{
 const p={...stockMeshProviderPolicy(),id:'policy',owner_id:null};p.rules[0].id='rule';p.rules[0].name='renamed';
 assertProviderPolicy(p,{policyId:'policy',policyOwnerId:null});p.rules[0].extraPermission=true;
 assert.throws(()=>assertProviderPolicy(p,{policyId:'policy',policyOwnerId:null}),/POLICY_CHANGED/);
});
test('changed local budget, wallet owner or local authorization key invalidates binding',async()=>{
 const f=fixture(),b=await f.activate(),s=new PrivyDelegatedSigner(f.client,f.context,b);
 await s.assertBinding(f.config);await assert.rejects(s.assertBinding({...f.config,maxOrders:'3'}),/NOT_CONNECTED/);
 f.state.wallet.owner_id='changed';await assert.rejects(s.assertBinding(f.config),/OWNER_CHANGED/);
 const g=fixture();await assert.rejects(new PrivyDelegatedSigner(g.client,f.context,await g.activate()).assertBinding(g.config),/KEY_MISMATCH/);
});
test('pinned SDK uses snake_case wire, verifies signature and does not submit',async()=>{
 const f=fixture(),b=await f.activate(),s=new PrivyDelegatedSigner(f.client,f.context,b);
 const unsigned=policyTransaction(f.config.wallet,[{programAddress:COMPUTE,accounts:[],data:Buffer.from([2,1,0,0,0])}],
  {blockhash:key(200),lastValidBlockHeight:'10000'}).transactionBase64;
 const tx=getTransactionDecoder().decode(Buffer.from(unsigned,'base64'));
 const signed=Buffer.from(getTransactionEncoder().encode({...tx,
  signatures:{[f.config.wallet]:sign(null,Buffer.from(tx.messageBytes),f.payer.privateKey)}})).toString('base64');
 f.state.response={encoding:'base64',signed_transaction:signed};
 assert.equal(await s.signTransaction(f.config,unsigned,'ef'.repeat(32)),signed);
 assert.equal(f.state.signInputs[0].idempotency_key,`xtxc-${'ef'.repeat(32)}`);
 assert.equal(f.state.signed,1);assert.ok(f.state.signInputs[0].request_expiry>Date.now());
 f.state.response={signedTransaction:signed};await assert.rejects(s.signTransaction(f.config,unsigned,'ee'.repeat(32)),/NO_WIRE/);
 f.state.response={encoding:'base64',signed_transaction:unsigned};await assert.rejects(s.signTransaction(f.config,unsigned,'ed'.repeat(32)));
});
test('provider failure never returns a cached binding and client disables automatic retries',async()=>{
 const f=fixture(),b=await f.activate(),s=new PrivyDelegatedSigner(f.client,f.context,b);
 await s.assertBinding(f.config);f.client.users=()=>({_get:async()=>{throw Error('provider-down');}});
 await assert.rejects(s.signTransaction(f.config,'wire','ef'.repeat(32)),/provider-down/);assert.equal(f.state.signed,0);
 let options;class StubClient {constructor(o){options=o;}}
 createIsolatedPrivyClient(StubClient,{appId:PRIVY_APP_ID,appSecret:'fixture-not-an-actual-secret'});
 assert.equal(options.maxRetries,0);assert.equal(options.timeout,8000);assert.equal(options.logLevel,'off');
});
