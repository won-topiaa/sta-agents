import {createPrivateKey, createPublicKey} from 'node:crypto';
import {STOCKMESH, COMPUTE, ATA, canonical, hash, validatePolicy,
 requirePolicy as need, verifyExactSignature} from './research-autonomy-policy.mjs';

export const PRIVY_APP_ID = 'cmumy9j4t00ek0clbqz9be3u7';
export const PRIVY_SDK_VERSION = '0.35.0';

// Provider-side defense in depth, NOT a Solana cumulative-spend policy.
// Amount/mint/recipient/opcode checks belong to the isolated exact-wire gate.
// No signMessage, rawSign, export, transfer or signAndSend permission.
export function stockMeshProviderPolicy() {
 return {version:'1.0', name:'XTXC StockMesh isolated gate', chain_type:'solana', rules:[{
  name:'StockMesh and required setup only', method:'signTransaction', action:'ALLOW',
  conditions:[{field_source:'solana_program_instruction', field:'programId', operator:'in',
   value:[STOCKMESH, COMPUTE, ATA]}]
 }]};
}

function semanticPolicy(p) {
 need(p && Array.isArray(p.rules), 'PROVIDER_POLICY_INVALID');
 const rules=p.rules.map(rule=>{
  // Drop display/record metadata only. Unknown permission fields remain in the
  // comparison and fail closed instead of quietly widening the allowlist.
  const {id:_, name:__, ...permissions}=rule;
  return permissions;
 });
 return {version:p.version, chain_type:p.chain_type, rules};
}
export const providerPolicyHash = () => hash(canonical(semanticPolicy(stockMeshProviderPolicy())));
export function assertProviderPolicy(p, {policyId, policyOwnerId}) {
 need(p?.id===policyId && p.owner_id===policyOwnerId, 'PROVIDER_POLICY_OWNER_CHANGED');
 need(canonical(semanticPolicy(p))===canonical(semanticPolicy(stockMeshProviderPolicy())),
  'PROVIDER_POLICY_CHANGED');
}

export function authorizationPublicKeyHash(publicKey) {
 const der=Buffer.from(publicKey.replace(/\s/g,''),'base64');
 const key=createPublicKey({key:der,format:'der',type:'spki'});
 need(key.asymmetricKeyType==='ec' && key.asymmetricKeyDetails?.namedCurve==='prime256v1',
  'INVALID_AUTHORIZATION_KEY');
 return hash(key.export({format:'der',type:'spki'}));
}
function assertQuorum(q, settings) {
 need(q?.id===settings.signerId && q.authorization_threshold===1 &&
  q.authorization_keys?.length===1 && !(q.user_ids?.length) && !(q.key_quorum_ids?.length),
  'PROVIDER_SIGNER_QUORUM_CHANGED');
 need(authorizationPublicKeyHash(q.authorization_keys[0].public_key)===settings.authorizationKeyHash,
  'PROVIDER_SIGNER_KEY_CHANGED');
}
function assertUserWallet(user, wallet, expected) {
 need(user?.id===expected.userId && user.is_guest===false && Array.isArray(user.linked_accounts),
  'PROVIDER_USER_MISMATCH');
 const owner=user.linked_accounts.find(a=>a.type==='wallet' && a.chain_type==='solana' &&
  a.address===expected.owner && Number.isSafeInteger(a.verified_at) && a.verified_at>0);
 need(owner, 'OWNER_NOT_LINKED_TO_PRIVY_USER');
 const embedded=user.linked_accounts.find(a=>a.type==='wallet' && a.chain_type==='solana' &&
  a.id===expected.walletId && a.address===expected.address && a.wallet_client_type==='privy' &&
  a.connector_type==='embedded' && a.imported===false && a.delegated===true && a.user_can_sign!==false);
 need(embedded, 'USER_OWNED_DELEGATED_WALLET_REQUIRED');
 need(wallet?.id===expected.walletId && wallet.chain_type==='solana' && wallet.address===expected.address &&
  typeof wallet.owner_id==='string' && wallet.owner_id.length>0 && wallet.imported_at===null &&
  wallet.exported_at===null && wallet.archived_at==null && !wallet.custody && !wallet.automations?.length,
  'PROVIDER_WALLET_CHANGED');
 // Wallet REST entity IDs omit `did:privy:`, while verified JWTs and User.id
 // retain it. Match exactly either representation of that same verified user;
 // never accept a suffix/substring match or treat owner_id as a user ID.
 if(wallet.entity) {
  const rawUserId=/^did:privy:([a-z0-9]+)$/.exec(expected.userId)?.[1];
  need(wallet.entity.type==='user' && (wallet.entity.id===expected.userId ||
   (rawUserId!==undefined && wallet.entity.id===rawUserId)), 'PROVIDER_WALLET_ENTITY_MISMATCH');
 }
 // owner_id is a key-quorum identifier, NOT the Privy user DID.
 if(expected.walletOwnerId) need(wallet.owner_id===expected.walletOwnerId,'PROVIDER_WALLET_OWNER_CHANGED');
 need(Array.isArray(wallet.policy_ids) && wallet.policy_ids.length===0 &&
  wallet.additional_signers?.length===1 && wallet.additional_signers[0].signer_id===expected.signerId &&
  canonical(wallet.additional_signers[0].override_policy_ids)===canonical([expected.policyId]),
  'PROVIDER_SIGNER_NOT_AUTHORIZED');
}

async function providerSnapshot(client,binding) {
 const [user,wallet,policy,quorum]=await Promise.all([
  client.users()._get(binding.userId), client.wallets().get(binding.walletId),
  client.policies().get(binding.policyId), client.keyQuorums().get(binding.signerId)
 ]);
 assertUserWallet(user,wallet,binding);
 assertProviderPolicy(policy,binding);
 assertQuorum(quorum,binding);
 return {walletOwnerId:wallet.owner_id};
}

export async function verifyStoredPrivyConnection(client,binding) {
 need(binding?.schema==='xtxc.privy-connection/v1'&&binding.appId===PRIVY_APP_ID,'DELEGATED_WALLET_NOT_CONNECTED');
 await providerSnapshot(client,binding);
 return {...binding,enabled:false,verifiedAt:Date.now()};
}

// sessionOwner MUST come from the existing server-verified SIWS session, never
// request JSON. settings MUST come from the gate's protected provisioning file.
// The returned record is not ACTIVE and contains no JWT or signing secret.
export async function verifyPrivyEnrollment({client, settings, config, sessionOwner, accessToken, walletId}) {
 validatePolicy(config);
 need(settings?.appId===PRIVY_APP_ID && config.owner===sessionOwner && config.owner!==config.wallet,
  'OWNER_SESSION_MISMATCH');
 const connection=await verifyPrivyConnection({client,settings,sessionOwner,accessToken,walletId,address:config.wallet});
 return {...connection,schema:'xtxc.privy-binding/v1',configId:config.id,configHash:hash(canonical(config))};
}

// Connection proves ownership and explicit provider delegation, not authority
// to spend. No approval, reserve, signing or submit operation is reachable here.
export async function verifyPrivyConnection({client,settings,sessionOwner,accessToken,walletId,address}) {
 need(settings?.appId===PRIVY_APP_ID && typeof sessionOwner==='string' && sessionOwner!==address,
  'OWNER_SESSION_MISMATCH');
 need(typeof accessToken==='string' && accessToken.length>20 && accessToken.length<=16384,
  'PRIVY_LOGIN_REQUIRED');
 const claims=await client.utils().auth().verifyAccessToken(accessToken);
 need(claims.app_id===settings.appId && claims.issuer==='privy.io' &&
  Number.isSafeInteger(claims.expiration) && claims.expiration>Math.floor(Date.now()/1000) &&
  typeof claims.user_id==='string' && claims.user_id.startsWith('did:privy:'), 'PRIVY_TOKEN_INVALID');
 const binding={schema:'xtxc.privy-connection/v1', appId:settings.appId, userId:claims.user_id,
  owner:sessionOwner, address, walletId, signerId:settings.signerId,
  policyId:settings.policyId, policyOwnerId:settings.policyOwnerId,
  authorizationKeyHash:settings.authorizationKeyHash, providerPolicyHash:providerPolicyHash()};
 const snapshot=await providerSnapshot(client,binding);
 return {...binding, ...snapshot, enabled:false, verifiedAt:Date.now()};
}

// Instantiate ONLY inside the gate. No private customer wallet key is accepted.
// Zero SDK retries: an ambiguous signing response must remain SIGNING_UNKNOWN.
export function createIsolatedPrivyClient(PrivyClient, {appId, appSecret}) {
 need(appId===PRIVY_APP_ID && typeof appSecret==='string' && appSecret.length>20,
  'PRIVY_APP_NOT_CONFIGURED');
 return new PrivyClient({appId, appSecret, maxRetries:0, timeout:8000, logLevel:'off',
  requestExpiry:{defaultMs:15000}});
}

export class PrivyDelegatedSigner {
 #client; #authorizationContext; #binding; #validateConfig;
 constructor(client, authorizationContext, binding, validateConfig=validatePolicy) {
  this.#client=client;
  this.#authorizationContext=authorizationContext;
  this.#binding=structuredClone(binding);
  this.#validateConfig=validateConfig;
 }
 async assertBinding(config) {
  this.#validateConfig(config);
  const b=this.#binding;
  need(b?.schema==='xtxc.privy-binding/v1' && b.appId===PRIVY_APP_ID && b.enabled===true &&
   b.owner===config.owner && b.address===config.wallet && b.configId===config.id &&
   b.configHash===hash(canonical(config)) && b.providerPolicyHash===providerPolicyHash(),
   'DELEGATED_WALLET_NOT_CONNECTED');
  // Only the server's one P-256 authorization key. No owner JWT fallback.
  const a=this.#authorizationContext;
  need(a && Object.keys(a).length===1 && a.authorization_private_keys?.length===1,
   'INVALID_SIGNER_AUTHORIZATION_CONTEXT');
  const privateKey=createPrivateKey({key:Buffer.from(a.authorization_private_keys[0],'base64'),
   format:'der',type:'pkcs8'});
  const publicKey=createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64');
  need(authorizationPublicKeyHash(publicKey)===b.authorizationKeyHash,'LOCAL_SIGNER_KEY_MISMATCH');
  await providerSnapshot(this.#client,b);
 }
 async signTransaction(config, transactionBase64, orderId, lifetime) {
  need(typeof orderId==='string' && /^[a-f0-9]{64}$/.test(orderId),'ORDER_ID_REQUIRED');
  await this.assertBinding(config);
  if(lifetime)need(Date.parse(lifetime.expiresAt)>Date.now()+2000,'SIGNING_DEADLINE_EXPIRED');
  const result=await this.#client.wallets().solana().signTransaction(this.#binding.walletId,{
   transaction:transactionBase64, authorization_context:this.#authorizationContext,
   idempotency_key:`xtxc-${orderId}`, request_expiry:Date.now()+15000
  });
  // @privy-io/node 0.35.0 returns snake_case, not signedTransaction.
  need(result?.encoding==='base64' && typeof result.signed_transaction==='string','PROVIDER_RETURNED_NO_WIRE');
  verifyExactSignature(transactionBase64,result.signed_transaction,config.wallet);
  return result.signed_transaction;
 }
}
