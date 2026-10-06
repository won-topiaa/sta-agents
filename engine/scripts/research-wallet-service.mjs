import http from 'node:http';
import {readFileSync,chmodSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {PrivyClient} from '@privy-io/node';
import {WalletConnectionService} from '../lib/research-wallet-connection.mjs';
import {createIsolatedPrivyClient} from '../lib/research-autonomy-privy.mjs';

const creds=process.env.CREDENTIALS_DIRECTORY;
if(!creds||!creds.startsWith('/run/credentials/'))throw Error('SYSTEMD_CREDENTIALS_REQUIRED');
const read=name=>JSON.parse(readFileSync(`${creds}/${name}`,'utf8'));
const settings=read('registration.json'),app=read('app.json');
const service=new WalletConnectionService({db:new DatabaseSync('/var/lib/xtxc-wallet-connect/connections.sqlite'),settings,client:createIsolatedPrivyClient(PrivyClient,app)});
const socket='/run/xtxc-wallet-connect/control.sock';
if(existsSync(socket))throw Error('SOCKET_ALREADY_EXISTS');
// No signing key, policy admin, devnet verifier or mainnet RPC is loaded.
// Only the authenticated web user can reach this group-restricted Unix socket.
let active=0;
http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 if(req.method==='GET'&&req.url==='/health'){res.end(JSON.stringify({ok:true,appId:settings.appId,tradingEnabled:false}));return;}
 if(req.method!=='POST'||req.url!=='/connection'||active>=4){res.statusCode=429;res.end('{"error":{"code":"SERVICE_BUSY"}}');return;}
 active++;
 try{
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>24000)throw Error('REQUEST_TOO_LARGE');chunks.push(chunk);}
  const b=JSON.parse(Buffer.concat(chunks).toString());
  if(!b||typeof b!=='object'||Object.keys(b).some(k=>!['owner','operation','input'].includes(k)))throw Error('INVALID_REQUEST');
  let connection;
  if(b.operation==='STATUS')connection=service.get(b.owner);
  else if(b.operation==='VERIFY'){res.end(JSON.stringify({binding:await service.verifiedBinding(b.owner)}));return;}
  else if(b.operation==='CONNECT')connection=await service.connect(b.owner,b.input);
  else if(b.operation==='DISCONNECT')connection=service.disconnect(b.owner);
  else throw Error('INVALID_OPERATION');
  res.end(JSON.stringify({connection,settings:service.publicSettings(),tradingEnabled:false}));
 }catch(e){res.statusCode=409;const code=typeof e?.code==='string'&&/^[A-Z_]{3,80}$/.test(e.code)?e.code:'WALLET_CONNECTION_UNAVAILABLE';
  // No raw error, request body, JWT, wallet metadata or SDK response in logs.
  console.warn(JSON.stringify({event:'wallet_connection_rejected',code}));
  res.end(JSON.stringify({error:{code}}));}
 finally{active--;}
}).listen(socket,()=>{chmodSync(socket,0o660);console.log('XTXC wallet connection service ready; signing disabled.');});
