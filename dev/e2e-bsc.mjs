#!/usr/bin/env node
// End-to-end check of the BNB Chain research path against the dev stack, with a throwaway,
// unfunded EVM key generated per run: sign-in -> agent -> strategy -> research -> approval ->
// BSC preparation. Nothing is signed for chain and nothing is sent: the wallet has no funds.
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(new URL('../web/package.json',import.meta.url));
const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const BASE=process.env.E2E_BASE??'http://127.0.0.1:4391',ORIGIN=process.env.E2E_ORIGIN??'http://localhost:4391';
const account=privateKeyToAccount(generatePrivateKey()),principal=`eip155:56:${account.address}`;
let cookie='';
async function call(method,path,body){
  const r=await fetch(BASE+path,{method,headers:{'Content-Type':'application/json',Origin:ORIGIN,'X-Skew-Expected-Requester':principal,...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
  const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
  const j=await r.json().catch(()=>null);if(!r.ok)throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);return j;
}
const log=(...a)=>console.log(new Date().toISOString().slice(11,19),...a);
const issued=new Date(),expires=new Date(issued.getTime()+5*60_000);
const message=['XTXC','Sign in to XTXC research on BNB Chain.','',`URI: ${ORIGIN}`,'Version: 1','Chain: BNB Smart Chain (eip155:56)',`Address: ${account.address}`,
  `Nonce: ${randomUUID().replaceAll('-','')}`,`Issued At: ${issued.toISOString()}`,`Expiration Time: ${expires.toISOString()}`].join('\n');
const session=await call('POST','/api/v1/requester-sessions',{operation:'EVM_SESSION',address:account.address,message,signature:await account.signMessage({message})});
log('session',session.address===principal?'ok':'MISMATCH',principal);
if(process.env.E2E_INTERPRET){const {draft}=await call('POST','/api/v1/stocklana/research/interpret',{text:process.env.E2E_INTERPRET});
  log('interpret',draft.universeSource,draft.executionChain,draft.brief.instruments.join(','),'missing',draft.missing.join(',')||'-');}
const STYLE=process.env.E2E_STYLE??'technical',VALUE=STYLE==='value'||STYLE==='dividend';
const profile=STYLE==='rotation'?{name:'E2E rotation',style:'technical',preset:'rotation',rules:[{id:'strong_sector',params:{keep:0.4}},{id:'sector_inflow'},{id:'relative_strength',params:{days:126}},
    {id:'fewer_trades',params:{within:2}},{id:'trailing_stop',params:{drop:0.15}},{id:'stop_loss',params:{loss:0.1}}],
    philosophy:'',risk:{maxWeightBps:3000,minCashBps:1000,maxDrawdownBps:3500},rebalance:process.env.E2E_REBALANCE??'monthly',approval:'PER_TRADE'}
  :STYLE==='pattern'?{name:'E2E patterns',style:'technical',preset:'pattern',rules:[{id:'box_breakout',params:{days:55}},{id:'quiet_before_move',params:{max:0.8}},
    {id:'trailing_stop',params:{drop:0.15}}],philosophy:'I buy breakouts from quiet ranges and let a trailing stop take me out.',
    risk:{maxWeightBps:3000,minCashBps:1000,maxDrawdownBps:3500},rebalance:'weekly',approval:'PER_TRADE'}
  :STYLE==='dividend'?{name:'E2E dividend',style:'value',preset:'dividend',rules:[{id:'pays_dividend',params:{min:0.015}},{id:'cheaper_than_sector'},{id:'liquid_only',params:{min:7}}],
    philosophy:'I want dependable dividend payers that are cheaper than their peers.',risk:{maxWeightBps:4000,minCashBps:1000,maxDrawdownBps:4000},rebalance:'monthly',approval:'PER_TRADE'}
  :STYLE==='volume'?{name:'E2E volume',style:'technical',preset:'custom',rules:[{id:'liquid_only',params:{min:8}},{id:'volume_surge',params:{min:0.2}},{id:'uptrend_only',params:{days:50}}],
    philosophy:'',risk:{maxWeightBps:4000,minCashBps:1000,maxDrawdownBps:3500},rebalance:'weekly',approval:'PER_TRADE'}
  :VALUE?{name:'E2E deep value',style:'value',preset:'deep_value',rules:[{id:'cheap_earnings',params:{keep:0.5}},{id:'cash_generating'},{id:'low_debt',params:{max:2}}],
    philosophy:'I buy profitable companies when they are cheap relative to their earnings.',risk:{maxWeightBps:4000,minCashBps:1000,maxDrawdownBps:4000},rebalance:'monthly',approval:'PER_TRADE'}
  :{name:'E2E trend',style:'technical',preset:'trend',rules:[{id:'uptrend_only',params:{days:200}},{id:'strong_momentum',params:{keep:0.5}},{id:'market_guard',params:{exposure:0.5}}],
    philosophy:'',risk:{maxWeightBps:4000,minCashBps:1000,maxDrawdownBps:3500},rebalance:'monthly',approval:'PER_TRADE'};
const {agent}=await call('POST','/api/v1/stocklana/research/agents',{operation:'CREATE',requestId:randomUUID(),profile});
log('agent',agent.id,agent.revision,agent.rules.map(r=>r.id).join(','));
const created=await call('POST','/api/v1/stocklana/research',{operation:'CREATE',requestId:randomUUID(),brief:STYLE==='rotation'?{name:'E2E rotation on BSC',objective:'Rotate into the strongest sectors for one year with 30 USDT.',budget:'30',instruments:['MU','NVDA','AMD','INTC','AVGO','TSM','MRVL','AMAT','LRCX','ASML','TXN','QCOM','XOM','CVX','JPM','BAC','LLY','UNH','WMT','COST','CAT','GE'],weights:[],cashBps:null,agentId:agent.id}
  :STYLE==='pattern'?{name:'E2E chart patterns on BSC',objective:'Buy breakouts from quiet ranges for one year with 30 USDT.',budget:'30',instruments:['MU','NVDA','AMD','INTC','AVGO','TSM','MRVL','AMAT','LRCX','ASML','TXN','QCOM','XOM','CVX','JPM','BAC','LLY','UNH','WMT','COST','CAT','GE'],weights:[],cashBps:null,agentId:agent.id}
  :STYLE==='dividend'?{name:'E2E dividends on BSC',objective:'Find cheap, dependable dividend payers for one year with 30 USDT.',budget:'30',instruments:['KO','PEP','PG','WMT','HD','LOW','MCD','JPM','XOM','CVX','IBM','UNH','ABBV','SO','NEE','WM'],weights:[],cashBps:null,agentId:agent.id}
  :STYLE==='volume'?{name:'E2E volume on BSC',objective:'Research liquid stocks with rising volume for one year with 30 USDT.',budget:'30',instruments:['NVDA','AMD','AVGO','MU','AAPL','MSFT','AMZN','META','TSLA','PLTR','GOOGL','NFLX'],weights:[],cashBps:null,agentId:agent.id}
  :VALUE?{name:'E2E value on BSC',objective:'Find undervalued, cash-generating large companies for one year with 30 USDT.',budget:'30',instruments:['AAPL','MSFT','NVDA','AMD','INTC','MU','KO','PEP','PG','WMT','MCD','JPM','LLY','UNH','CVX','IBM','ORCL','F','GOOGL','META','AMZN'].filter(t=>true),weights:[],cashBps:null,agentId:agent.id}
  :{name:'E2E chips on BSC',objective:'Research AI chip stocks for one year with 30 USDT.',budget:'30',instruments:['NVDA','AMD','AVGO','MU','TSM'],weights:[],cashBps:null,agentId:agent.id}});
const strategy=created.strategy;log('strategy',strategy.id,strategy.agentId===agent.id?'bound to agent':'NOT BOUND');
const {runId}=await call('POST','/api/v1/stocklana/research/agent',{operation:'RUN',strategyId:strategy.id,requestId:randomUUID(),
  goal:{targetReturnBps:500,horizonDays:365,maxDrawdownBps:VALUE?4000:3500,maxWeightBps:4000,minCashBps:1000,costBps:50}});
log('run queued',runId);
let run;for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,5000));run=(await call('GET',`/api/v1/stocklana/research/agent?id=${strategy.id}`)).runs.find(r=>r.id===runId);if(!['QUEUED','RUNNING'].includes(run?.status))break;}
log('run',run?.status,run?.error??'');
if(!run?.result){process.exitCode=1;process.exit();}
const r=run.result;log('agent in report',JSON.stringify(r.agent));log('held instruments',JSON.stringify(r.heldInstruments));
for(const c of r.candidates){log('candidate',c.name,'|',c.verdict,c.reasons.join(',')||'-','| checks',(c.agentChecks??[]).map(x=>`${x.rule}:${x.status}`).join(' '),'| weights',c.weights.map(w=>`${w.instrument}:${w.weightBps}`).join(' '));
  if(c.design?.exit||c.design?.hold_buffer||c.design?.breadth_off)log('   design extras',JSON.stringify({exit:c.design.exit,hold_buffer:c.design.hold_buffer,breadth_off:c.design.breadth_off}),'| howItPicks',JSON.stringify({hold:c.howItPicks?.hold,exit:c.howItPicks?.exit}));}
const eligible=r.candidates.find(c=>c.verdict==='ELIGIBLE');
if(!eligible){log('no eligible candidate; stopping before approval');process.exit();}
const {plan}=await call('POST','/api/v1/stocklana/research/agent',{operation:'APPROVE',runId,candidateId:eligible.id,reportHash:r.reportHash});
log('plan',plan.id.slice(0,12),plan.chain,plan.budgetAsset,plan.legs.map(l=>`${l.instrument}:${l.inputAtoms}`).join(' '),'agent',JSON.stringify(plan.agent));
try{const p=await call('POST','/api/v1/stocklana/research/agent',{operation:'BSC_PREPARE',planId:plan.id,index:0});
  log('prepare leg 0 ->',p.prepared.kind,'to',p.prepared.tx.to,'data',p.prepared.tx.data.slice(0,10),'product',p.product.platform,p.product.symbol);}
catch(e){log('prepare leg 0 ->',e.message.slice(0,300));}
