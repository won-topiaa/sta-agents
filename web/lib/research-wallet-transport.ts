import 'server-only';
import http from 'node:http';

export function walletConnectionRequest(owner:string,operation:string,input:unknown={}){
 return new Promise<Record<string,unknown>>((resolve,reject)=>{
  const body=JSON.stringify({owner,operation,input});
  const req=http.request({socketPath:'/run/xtxc-wallet-connect/control.sock',path:'/connection',method:'POST',timeout:22000,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>32000){res.destroy();reject(new Error('WALLET_CONNECTION_RESPONSE'));}else chunks.push(chunk);});
   res.on('error',()=>reject(new Error('WALLET_CONNECTION_UNAVAILABLE')));
   res.on('end',()=>{try{const b=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)throw new Error(b.error?.code??'WALLET_CONNECTION_UNAVAILABLE');resolve(b);}catch(e){reject(e);}});
  });
  req.on('timeout',()=>req.destroy());req.on('error',()=>reject(new Error('WALLET_CONNECTION_UNAVAILABLE')));req.end(body);
 });
}
