import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signature,query,web3Client,rwa,transaction,Web3ApiError} from '../lib/binance-web3.mjs';

const ts='2026-05-11T10:08:57.715Z';
const reply=(status,json)=>new Response(JSON.stringify(json),{status,headers:{'Content-Type':'application/json'}});

test('signature matches an independent HMAC-SHA256/Base64 computation (Python hmac)',()=>{
  const path='/build/api/v1/dex/market/rwa/price'+query({binanceChainId:'56',tokenContractAddresses:'0xabc,0xdef'});
  assert.equal(path,'/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xabc%2C0xdef');
  assert.equal(signature('test-secret',ts,'GET',path),'wQTy1tUeJHgD105brlYqHF0zx5PwZMhxVXVn52NswJQ=');
  const body=JSON.stringify({binanceChainId:'56',evmTx:{from:'0x1'}});
  assert.equal(signature('test-secret',ts,'POST','/build/api/v1/dex/pre-transaction/simulate',body),'H1EJIquPbRViY7MMfAjrG2Jko+ooh1sZ4dWFp+J+Nj0=');
});

test('requests carry the signed /build path, headers and body; observations never contain secrets',async()=>{
  const calls=[],seen=[];
  const c=web3Client({apiKey:'k-123',secretKey:'s-456',now:()=>new Date(ts),minIntervalMs:0,observe:e=>seen.push(e),
    fetcher:async(url,init)=>{calls.push({url,init});return reply(200,{code:0,msg:'',data:{ok:true},success:true});}});
  assert.deepEqual(await rwa.price(c,['0xabc','0xdef']),{ok:true});
  assert.deepEqual(await transaction.simulate(c,{from:'0x1'}),{ok:true});
  const [get,post]=calls;
  assert.equal(get.url,'https://web3.binance.com/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xabc%2C0xdef');
  assert.equal(get.init.headers['X-OC-SIGN'],signature('s-456',ts,'GET','/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xabc%2C0xdef'));
  assert.equal(post.init.headers['X-OC-SIGN'],signature('s-456',ts,'POST','/build/api/v1/dex/pre-transaction/simulate',post.init.body));
  assert.equal(get.init.headers['X-OC-APIKEY'],'k-123');assert.equal(get.init.headers['X-OC-TIMESTAMP'],ts);assert.equal(get.init.body,undefined);
  assert.equal(post.init.method,'POST');assert.equal(post.init.body,JSON.stringify({binanceChainId:'56',evmTx:{from:'0x1'}}));
  assert.equal(seen.length,2);assert.ok(!JSON.stringify(seen).includes('s-456')&&!JSON.stringify(seen).includes('k-123'));
});

test('rate limits and server errors are retried; API errors are surfaced with their code',async()=>{
  let n=0;
  const c=web3Client({apiKey:'k',secretKey:'s',minIntervalMs:0,retries:2,fetcher:async()=>{n++;return n<3?reply(429,{code:42900,msg:'Too many requests'}):reply(200,{code:0,data:[1]});}});
  assert.deepEqual(await rwa.platforms(c),[1]);assert.equal(n,3);
  const bad=web3Client({apiKey:'k',secretKey:'s',minIntervalMs:0,fetcher:async()=>reply(200,{code:40367,msg:'Market closed',success:false})});
  await assert.rejects(rwa.platforms(bad),e=>e instanceof Web3ApiError&&e.code==='40367'&&!e.retryable&&/Market closed/.test(e.message));
  const auth=web3Client({apiKey:'k',secretKey:'s',minIntervalMs:0,fetcher:async()=>reply(401,{code:40102,msg:'Invalid signature'})});
  await assert.rejects(rwa.platforms(auth),e=>e.code==='40102'&&e.httpStatus===401);
  const html=web3Client({apiKey:'k',secretKey:'s',minIntervalMs:0,retries:0,fetcher:async()=>new Response('<html>blocked</html>',{status:403})});
  await assert.rejects(rwa.platforms(html),e=>e.code==='NOT_JSON');
  assert.throws(()=>web3Client({apiKey:'',secretKey:'s'}),/not configured/);
});
