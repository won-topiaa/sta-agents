import http from 'node:http';
import {readFileSync,writeFileSync,chmodSync,existsSync} from 'node:fs';
import {createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PrivyClient} from '@privy-io/node';
import {AutonomyJournal} from '../lib/research-autonomy-journal.mjs';
import {DevnetPolicyTransport} from '../lib/research-autonomy-devnet.mjs';
import {MainnetObservationRpc} from '../lib/research-autonomy-rpc.mjs';
import {PrivyDelegatedSigner,createIsolatedPrivyClient} from '../lib/research-autonomy-privy.mjs';
import {AutonomyControl} from '../lib/research-autonomy-control.mjs';
import {AutonomyStockMesh} from '../lib/research-autonomy-stockmesh.mjs';
import {keyString,requirePolicy as need} from '../lib/research-autonomy-policy.mjs';

const dir=process.env.CREDENTIALS_DIRECTORY;
need(dir?.startsWith('/run/credentials/'),'SYSTEMD_CREDENTIALS_REQUIRED');
const read=name=>JSON.parse(readFileSync(`${dir}/${name}`,'utf8'));
const client=createIsolatedPrivyClient(PrivyClient,read('app.json'));
const authorization={authorization_private_keys:[read('authorization.p256.json').privateKey]};
const key=Buffer.from(read('verifier.json'));
need(key.length===64,'DEVNET_VERIFIER_FORMAT');
const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),key.subarray(0,32)]),format:'der',type:'pkcs8'});
const verifier=keyString(createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32));
need(verifier==='CGCAEch5PuLc2TL5ecKW7AKJNT3fkxxNiBU8xZXJDv4','WRONG_DEVNET_VERIFIER');key.fill(0);
const db=new DatabaseSync('/var/lib/xtxc-autonomy/gate.sqlite');
const journal=new AutonomyJournal(db),devnet=new DevnetPolicyTransport(db,{address:verifier,signDevnet:async bytes=>sign(null,bytes,privateKey)});
function connection(owner){return new Promise((resolve,reject)=>{
 const body=JSON.stringify({owner,operation:'VERIFY'});
 const req=http.request({socketPath:'/run/xtxc-wallet-connect/control.sock',path:'/connection',method:'POST',timeout:22000,headers:{'Content-Type':'application/json'}},r=>{
  let bytes=0;const chunks=[];r.on('data',b=>{bytes+=b.length;if(bytes>32000)r.destroy();else chunks.push(b);});r.on('error',()=>reject(Error('WALLET_CONNECTION_UNAVAILABLE')));r.on('end',()=>{try{const v=JSON.parse(Buffer.concat(chunks).toString());need(r.statusCode===200&&v.binding,'DELEGATED_WALLET_NOT_CONNECTED');resolve(v.binding);}catch(e){reject(e);}});
 });req.on('timeout',()=>req.destroy());req.on('error',()=>reject(Error('WALLET_CONNECTION_UNAVAILABLE')));req.end(body);
});}
// systemd credentials may be 0444 inside a private mount. Keep the RPC reader's
// strict 0600 boundary by making a service-owned, ephemeral copy, never a web env.
const rpcFile='/run/xtxc-autonomy/mainnet.url';
writeFileSync(rpcFile,readFileSync(`${dir}/mainnet.url`),{mode:0o600,flag:'wx'});
const control=new AutonomyControl({journal,devnet,verifier,connection,mainnet:new MainnetObservationRpc(rpcFile),stockmesh:new AutonomyStockMesh(read('stockmesh.json')),signer:binding=>new PrivyDelegatedSigner(client,authorization,binding)});
const socket='/run/xtxc-autonomy/control.sock';need(!existsSync(socket),'SOCKET_ALREADY_EXISTS');let active=0,working=false;
const server=http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 if(req.method==='GET'&&req.url==='/health'){res.end(JSON.stringify({ok:true,authority:'OWNER_APPROVAL_AND_EXPLICIT_START',running:db.prepare("SELECT count(*) n FROM autonomy_bindings WHERE phase='RUNNING'").get().n}));return;}
 if(req.method!=='POST'||req.url!=='/control'||active>=3){res.statusCode=429;res.end('{"error":{"code":"SERVICE_BUSY"}}');return;}active++;
 try{
  const chunks=[];let size=0;for await(const b of req){size+=b.length;need(size<48000,'REQUEST_TOO_LARGE');chunks.push(b);}
  const b=JSON.parse(Buffer.concat(chunks).toString());need(b&&Object.keys(b).every(k=>['owner','operation','input'].includes(k)),'INVALID_REQUEST');const x=b.input??{};let out;
  if(b.operation==='DRAFT')out=await control.draft(b.owner,x);
  else if(b.operation==='PREPARE_APPROVAL')out=await control.prepareApproval(b.owner,x.id);
  else if(b.operation==='SUBMIT_APPROVAL')out=await control.submitApproval(b.owner,x.id,x.signedTransactionBase64);
  else if(b.operation==='START')out=await control.start(b.owner,x.id,x.approvalHash);
  else if(b.operation==='STOP')out=control.stop(b.owner,x.id);
  else if(b.operation==='STOP_ALL'){const rows=db.prepare("SELECT id FROM autonomy_bindings WHERE owner=? AND phase NOT IN ('STOPPED','COMPLETE')").all(b.owner);for(const row of rows)control.stop(b.owner,row.id);out={stopped:rows.length};}
  else if(b.operation==='STATUS')out=await control.status(b.owner,x.id,x.withHoldings===true);
  else throw Error('INVALID_OPERATION');
  res.end(JSON.stringify({execution:out}));
 }catch(e){const code=typeof e.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(e.code)?e.code:'EXECUTION_UNAVAILABLE';res.statusCode=409;res.end(JSON.stringify({error:{code}}));console.warn(JSON.stringify({event:'autonomy_control_rejected',code}));}finally{active--;}
});
server.requestTimeout=30000;server.headersTimeout=10000;
server.listen(socket,()=>{chmodSync(socket,0o660);console.log('Autonomy gate ready. No policy starts without owner approval and Start.');});
setInterval(async()=>{if(working)return;working=true;try{await control.tickNext();}catch{console.warn('Autonomy worker deferred; durable records retained.');}finally{working=false;}},2500);
process.on('SIGTERM',()=>{server.close();setTimeout(()=>process.exit(0),20000).unref();});
