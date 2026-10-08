import http from 'node:http';

export function operatingRequest(owner,operation,input, socketPath='/run/xtxc-autonomy/control.sock') {
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({owner,operation,input});
    if(Buffer.byteLength(body)>2000000){reject(Error('OPERATING_FEED_TOO_LARGE'));return;}
    const req=http.request({socketPath,path:'/control',method:'POST',timeout:25000,
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      const chunks=[];let size=0;
      res.on('data',b=>{size+=b.length;if(size>256000)res.destroy();else chunks.push(b);});
      res.on('error',()=>reject(Error('OPERATING_GATE_UNAVAILABLE')));
      res.on('end',()=>{try{const v=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)throw Error(v.error?.code??'OPERATING_GATE_UNAVAILABLE');resolve(v.execution);}catch(e){reject(e);}});
    });
    req.on('timeout',()=>req.destroy());req.on('error',()=>reject(Error('OPERATING_GATE_UNAVAILABLE')));req.end(body);
  });
}
export async function flushOperatingResearch(store,send=operatingRequest,now=Date.now()) {
  for(const row of store.db.prepare('SELECT * FROM agent_operating_outbox WHERE next_at<=? ORDER BY next_at LIMIT 3').all(now)) {
    const doc=JSON.parse(row.document);
    try {
      await send(doc.owner,'ONGOING_FEED',{research:doc});
      store.db.prepare('DELETE FROM agent_operating_outbox WHERE run_id=?').run(row.run_id);
    } catch(e) {
      if(['STALE_RESEARCH','RESEARCH_EVENT_OUT_OF_ORDER','RESEARCH_SCOPE_CHANGED'].includes(e.message)) {
        store.db.prepare('DELETE FROM agent_operating_outbox WHERE run_id=?').run(row.run_id);
        store.event(store.owner(`solana:${doc.owner}`),doc.strategy.id,'OPERATING_REPORT_SUPERSEDED',{runId:doc.runId});
      } else store.db.prepare('UPDATE agent_operating_outbox SET attempts=attempts+1,next_at=? WHERE run_id=?').run(now+Math.min(300000,5000*2**Math.min(row.attempts,6)),row.run_id);
    }
  }
}
