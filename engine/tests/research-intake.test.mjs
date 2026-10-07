import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveIntake,interpretResearch,intakeContext} from '../lib/research-intake.mjs';
const allowed=['NVDA','AMD','AVGO','ASML','TSM','MU','INTC','MRVL','QQQ'];
const text='반도체로 1년에 5% 목표로 돌려봐';
const slots={title:'반도체 연구',themes:['semiconductors'],include:[],exclude:[],budgetUSDC:null,budgetEvidence:null,targetPercent:'5',targetEvidence:'5%',horizonDays:365,horizonEvidence:'1년',maxLossPercent:null,maxLossEvidence:null};
test('theme request selects supported semiconductor stocks without clicks; asks only missing budget',()=>{const d=resolveIntake(slots,text,allowed);assert.deepEqual(d.brief.instruments,allowed.slice(0,8));assert.equal(d.goal.targetReturnBps,500);assert.equal(d.goal.horizonDays,365);assert.deepEqual(d.missing,['budget']);assert.equal(d.brief.budget,'');assert.equal(d.executionChain,'solana:mainnet');assert.equal(d.evidenceChain,'solana:devnet');assert.equal(d.authority,'RESEARCH_DRAFT_ONLY');});
test('change in plain language keeps prior goal, removes excluded stock and changes budget',()=>{const d=resolveIntake(slots,text,allowed);d.brief.budget='100';const p={...slots,themes:[],exclude:['AMD'],targetPercent:null,targetEvidence:null,horizonDays:null,horizonEvidence:null,budgetUSDC:'60',budgetEvidence:'60달러'};const b=resolveIntake(p,'예산 60달러로 줄이고 AMD는 빼줘',allowed,d);assert.equal(b.brief.budget,'60');assert.equal(b.goal.targetReturnBps,500);assert.ok(!b.brief.instruments.includes('AMD'));assert.equal(b.missing.length,0);});
test('does not invent budget, convert KRW, accept ungrounded values or grant a trading authority',()=>{assert.throws(()=>resolveIntake({...slots,budgetUSDC:'100',budgetEvidence:'100 USDC'},text,allowed));assert.throws(()=>resolveIntake({...slots,budgetUSDC:'100',budgetEvidence:'100만원'},text+' 100만원',allowed));assert.throws(()=>resolveIntake({...slots,autoTrade:true},text,allowed));assert.throws(()=>resolveIntake({...slots,horizonDays:30},text,allowed));});
test('unrealistic goal is retained for evaluator refusal, not promised or silently lowered',()=>{const d=resolveIntake({...slots,targetPercent:'1000',targetEvidence:'1000%'},text+' 1000%',allowed);assert.equal(d.goal.targetReturnBps,100000);});
test('catalog boundary and ambiguous request remain visible',()=>{const d=resolveIntake({...slots,themes:[],include:['NOTLISTED']},text+' NOTLISTED',allowed);assert.deepEqual(d.unavailable,['NOTLISTED']);assert.ok(d.missing.includes('stocks'));assert.equal(d.brief.instruments.length,0);});
test('model cannot append unmentioned stocks or themes; percentage substrings are not numeric evidence',()=>{const d=resolveIntake({...slots,themes:['semiconductors','broad_market'],include:['QQQ']},text,allowed);assert.equal(d.brief.instruments.length,8);assert.ok(!d.brief.instruments.includes('QQQ'));assert.throws(()=>resolveIntake({...slots,targetPercent:'5',targetEvidence:'15%'},'반도체 1년 15%',allowed));});
test('validated model call records usage without wallet balance or raw history',async()=>{let counted=0;const store={reserveTokens:n=>({maximum:n}),tokenResult:(_,u)=>counted=u};const draft=await interpretResearch(text,allowed,null,{KILN_API_KEY:'fixture-only',KILN_BASE_URL:'https://api.bricksum.com/v1'},store,async(url,req)=>{assert.equal(url,'https://api.bricksum.com/v1/chat/completions');const b=JSON.parse(req.body);assert.ok(!JSON.stringify(b).includes('privateKey'));return Response.json({usage:{prompt_tokens:700,completion_tokens:180},choices:[{message:{content:JSON.stringify(slots)}}]});});assert.equal(counted,880);assert.equal(draft.trace.model,'qwen3-32b');assert.deepEqual(draft.missing,['budget']);});
test('one missing budget can be supplied in a second chat turn without choosing stocks again',()=>{
 const prior=intakeContext(resolveIntake(slots,text,allowed),allowed);
 const next=resolveIntake({...slots,themes:[],targetPercent:null,targetEvidence:null,horizonDays:null,horizonEvidence:null,budgetUSDC:'100',budgetEvidence:'100 USDC'},'100 USDC',allowed,prior);
 assert.equal(next.brief.budget,'100');assert.equal(next.brief.instruments.length,8);assert.equal(next.goal.targetReturnBps,500);assert.equal(next.goal.horizonDays,365);assert.deepEqual(next.missing,[]);
});
test('explicit picker stocks combine with a language theme and exclusions still win',()=>{
 const mixed=resolveIntake({...slots,exclude:['AMD']},text+' AMD 빼줘',allowed,null,['QQQ','AMD']);
 assert.ok(mixed.brief.instruments.includes('QQQ'));assert.ok(!mixed.brief.instruments.includes('AMD'));assert.equal(mixed.brief.instruments.length,8);
 assert.throws(()=>resolveIntake(slots,text,allowed,null,['UNLISTED']));
});
test('incomplete follow-up does not silently invent missing target or horizon',()=>{
 const d=resolveIntake({...slots,targetPercent:null,targetEvidence:null,horizonDays:null,horizonEvidence:null},'반도체',allowed);
 const next=resolveIntake({...slots,themes:[],targetPercent:null,targetEvidence:null,horizonDays:null,horizonEvidence:null,budgetUSDC:'100',budgetEvidence:'100 USDC'},'100 USDC',allowed,intakeContext(d,allowed));
 assert.deepEqual(next.missing,['target','horizon']);assert.equal(next.authority,'RESEARCH_DRAFT_ONLY');
 assert.throws(()=>intakeContext({...d,missing:['authorization']},allowed));
});
test('budget and target alone work with a disclosed starter universe, no stock clicks',()=>{
 const d=resolveIntake({...slots,themes:[],budgetUSDC:'100',budgetEvidence:'100달러'},'100달러로 1년 5% 목표로 연구해줘',allowed);
 assert.deepEqual(d.brief.instruments,['QQQ','NVDA']);assert.equal(d.universeSource,'STARTER_RESEARCH');assert.deepEqual(d.missing,[]);assert.equal(d.authority,'RESEARCH_DRAFT_ONLY');
});
test('ungrounded model theme does not suppress the budget-only starter path',()=>{
 const d=resolveIntake({...slots,themes:['broad_market'],budgetUSDC:'100',budgetEvidence:'100달러'},'100달러로 1년 5% 목표로 연구해줘',allowed);
 assert.equal(d.universeSource,'STARTER_RESEARCH');assert.deepEqual(d.missing,[]);
});
test('BNB Chain drafts use data-built groups: value and dividend requests get companies, not funds',async()=>{
 const {CATALOGS}=await import('../lib/research-intake.mjs');const {BSC_RESEARCH_STOCKS,BSC_RESEARCH_FUNDS}=await import('../lib/bsc-research-universe.mjs');
 const text='Find undervalued dividend payers among large US companies. 30 USDT, one year, 6% target.';
 const p={...slots,title:'Dividend value',themes:['value','dividend'],budgetUSDC:'30',budgetEvidence:'30 USDT',targetPercent:'6',targetEvidence:'6%',horizonDays:365,horizonEvidence:'one year'};
 const d=resolveIntake(p,text,BSC_RESEARCH_STOCKS,null,[],CATALOGS.bsc);
 assert.equal(d.universeSource,'YOUR_REQUEST');assert.equal(d.executionChain,'eip155:56');
 assert.deepEqual(d.brief.instruments,[...new Set([...CATALOGS.bsc.themes.value,...CATALOGS.bsc.themes.dividend])]);
 assert.ok(d.brief.instruments.every(t=>!BSC_RESEARCH_FUNDS.includes(t)));
 const starter=resolveIntake({...p,themes:[]},'30 USDT, one year, 6%',BSC_RESEARCH_STOCKS,null,[],CATALOGS.bsc);
 assert.equal(starter.universeSource,'STARTER_RESEARCH');assert.deepEqual(starter.brief.instruments,[...CATALOGS.bsc.starter]);
 assert.ok(new Set(starter.brief.instruments.map(t=>t)).size>=10);
 assert.throws(()=>resolveIntake(p,text,allowed));                      // the Solana catalog has no dividend group
});
