import 'server-only';
import http from 'node:http';
export function autonomyRequest(owner:string,operation:string,input:Record<string,unknown>){
 return new Promise<Record<string,unknown>>((resolve,reject)=>{
  const body=JSON.stringify({owner,operation,input});
  const req=http.request({socketPath:'/run/xtxc-autonomy/control.sock',path:'/control',method:'POST',timeout:90000,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
   const chunks:Buffer[]=[];let size=0;res.on('data',(b:Buffer)=>{size+=b.length;if(size>128000)res.destroy();else chunks.push(b);});res.on('error',()=>reject(Error('EXECUTION_UNAVAILABLE')));res.on('end',()=>{try{const b=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)throw Error(b.error?.code??'EXECUTION_UNAVAILABLE');resolve(b);}catch(e){reject(e);}});
  });req.on('timeout',()=>req.destroy());req.on('error',()=>reject(Error('EXECUTION_UNAVAILABLE')));req.end(body);
 });
}
