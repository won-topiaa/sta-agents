import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveIntake,intakeContext,interpretResearch} from '../lib/research-intake.mjs';
const allowed=['NVDA','AMD','AVGO','TSM','MU','MRVL','GOOGL','META','AMZN','ORCL','PLTR','QQQ','SPY'];
const exact='I have 2 USDC. Find a defensive stock strategy targeting 5% over one year. Keep at least 50% in cash and maximum drawdown below 20%. Compare strategies after trading costs and show me the results before I approve any trades. 1years, ai stocks';
const slots={title:'Defensive AI research',themes:['ai'],include:[],exclude:[],budgetUSDC:'2',budgetEvidence:'2 USDC',targetPercent:'5',targetEvidence:'5%',horizonDays:365,horizonEvidence:'one year',maxLossPercent:'20',maxLossEvidence:'20%',minCashPercent:'50',minCashEvidence:'Keep at least 50% in cash',maxWeightPercent:null,maxWeightEvidence:null};
const blank={title:'Follow-up',themes:[],include:[],exclude:[],budgetUSDC:null,budgetEvidence:null,targetPercent:null,targetEvidence:null,horizonDays:null,horizonEvidence:null,maxLossPercent:null,maxLossEvidence:null};
test('reported complete request is ready, exact limits and AI catalog retained',()=>{
 const d=resolveIntake(slots,exact,allowed);
 assert.deepEqual(d.missing,[]);assert.equal(d.brief.budget,'2');
 assert.deepEqual(d.goal,{targetReturnBps:500,horizonDays:365,maxDrawdownBps:2000,minCashBps:5000,maxWeightBps:4000,costBps:50});
 assert.deepEqual(d.brief.instruments,allowed.slice(0,11));
 assert.ok(!d.defaults.includes('cash reserve'));assert.equal(d.authority,'RESEARCH_DRAFT_ONLY');
});
for(const duration of ['one year','a year','1years','1yr','1-year','365 days','일년','한 해','1년','annual']){
 test('duration wording: '+duration,()=>{
  const d=resolveIntake({...slots,horizonEvidence:duration,minCashPercent:null},exact.replace('one year',duration).replace('1years,',''),allowed);
  assert.equal(d.goal.horizonDays,365);assert.deepEqual(d.missing,[]);
 });
}
test('missing model duration and AI slot are recovered from explicit user wording',()=>{
 const d=resolveIntake({...slots,themes:[],horizonDays:null,horizonEvidence:null,minCashPercent:null},exact,allowed);
 assert.deepEqual(d.missing,[]);assert.equal(d.goal.minCashBps,5000);assert.equal(d.goal.horizonDays,365);assert.ok(d.brief.instruments.includes('AMD'));
});
test('model-normalized duration evidence does not reject equivalent original words',()=>{
 assert.equal(resolveIntake({...slots,horizonEvidence:'1 year'},exact,allowed).goal.horizonDays,365);
});
test('long generated title never masquerades as a missing-theme error',()=>{
 const d=resolveIntake({...slots,title:'A defensive AI stock strategy '.repeat(5)},exact,allowed);
 assert.equal(d.brief.name.length,80);assert.deepEqual(d.missing,[]);
});
test('half in cash is explicit rather than 10 percent default',()=>{
 for(const wording of ['Keep half in cash','현금 절반','반은 현금']){
  const d=resolveIntake({...slots,minCashEvidence:wording},exact.replace('Keep at least 50% in cash',wording),allowed);
  assert.equal(d.goal.minCashBps,5000);
 }
});
test('Korean English and no-space variants keep numeric slots',()=>{
 const p={...slots,budgetEvidence:'2달러',horizonEvidence:'1년',minCashEvidence:'현금 50%',maxLossEvidence:'20퍼',targetEvidence:'5퍼'};
 const d=resolveIntake(p,'2달러 AI주 1년 5퍼 목표. 현금 50% 남겨두고 최대손실 20퍼. 승인 전에 보여줘',allowed);
 assert.deepEqual(d.missing,[]);assert.equal(d.goal.minCashBps,5000);
});
test('follow-up changes theme only preserving budget period and risk',()=>{
 const previous=intakeContext(resolveIntake(slots,exact,allowed),allowed);
 const d=resolveIntake(blank,'아까 조건 그대로 AI주로',allowed,previous);
 assert.deepEqual(d.missing,[]);assert.equal(d.brief.budget,'2');assert.deepEqual(d.goal,previous.goal);
 assert.deepEqual(d.brief.instruments,allowed.slice(0,11));
});
test('only the actually missing condition is requested',()=>{
 const prior=resolveIntake({...blank,themes:['ai']},'AI주 알아봐',allowed);
 const next=resolveIntake({...blank,budgetUSDC:'2',budgetEvidence:'2달러',targetPercent:'5',targetEvidence:'5%'},'2달러 5%',allowed,intakeContext(prior,allowed));
 assert.deepEqual(next.missing,['horizon']);
 const final=resolveIntake(blank,'one year',allowed,intakeContext(next,allowed));
 assert.deepEqual(final.missing,[]);assert.equal(final.brief.budget,'2');assert.equal(final.goal.targetReturnBps,500);
});
test('different periods are not arbitrarily selected without model evidence',()=>{
 const d=resolveIntake(blank,'Research AI stocks for 30 days or one year',allowed);
 assert.ok(d.missing.includes('horizon'));
 assert.throws(()=>resolveIntake({...slots,horizonDays:30},exact,allowed),/duration/);
});
test('cash conflict ungrounded cash and out-of-range cash are rejected',()=>{
 assert.throws(()=>resolveIntake({...slots,minCashPercent:'10'},exact,allowed),/conflicts/);
 assert.throws(()=>resolveIntake({...slots,minCashEvidence:'50% cash'},exact.replace('Keep at least 50% in cash','Keep a reserve'),allowed));
 assert.throws(()=>resolveIntake({...slots,minCashPercent:'96',minCashEvidence:'Keep at least 96% in cash'},exact.replace('50%','96%'),allowed));
});
test('model optional allocation fields are verified and applied',()=>{
 const d=resolveIntake({...slots,maxWeightPercent:'30',maxWeightEvidence:'Maximum allocation per stock: 30%'},exact+' Maximum allocation per stock: 30%',allowed);
 assert.equal(d.goal.maxWeightBps,3000);assert.ok(!d.defaults.includes('concentration'));
});
test('evidence allows casing and whitespace not invented amounts',()=>{
 const d=resolveIntake({...slots,budgetEvidence:'2 usdc',minCashEvidence:'keep at least 50% in cash'},exact,allowed);
 assert.equal(d.brief.budget,'2');
 assert.throws(()=>resolveIntake({...slots,budgetUSDC:'200'},exact,allowed));
});
test('negative AI mention does not turn into requested theme',()=>{
 const previous=intakeContext(resolveIntake({...slots,themes:[],include:['QQQ'],minCashPercent:null},exact.replace('ai stocks','QQQ'),allowed),allowed);
 const d=resolveIntake({...blank,themes:['ai']},'No AI stocks; keep QQQ',allowed,previous);
 assert.deepEqual(d.brief.instruments,previous.brief.instruments);
});
test('unknown fields cannot smuggle approval or start into interpretation',()=>{
 assert.throws(()=>resolveIntake({...slots,autoTrade:true},exact,allowed));
 assert.throws(()=>resolveIntake({...slots,themes:['__proto__']},exact,allowed));
});
test('model contract has cash and informal duration schema; fixture is not live evidence',async()=>{
 let usage=0;
 const d=await interpretResearch(exact,allowed,null,{KILN_API_KEY:'fixture',KILN_BASE_URL:'https://api.bricksum.com/v1'},{
  reserveTokens:n=>({maximum:n}),tokenResult:(_,n)=>usage=n,
 },async(_,request)=>{
  const body=JSON.parse(request.body);
  assert.match(body.messages[0].content,/minCashPercent/);assert.match(body.messages[0].content,/one year/);
  return Response.json({usage:{prompt_tokens:900,completion_tokens:150},choices:[{message:{content:JSON.stringify(slots)}}]});
 });
 assert.equal(usage,1050);assert.deepEqual(d.missing,[]);
});
