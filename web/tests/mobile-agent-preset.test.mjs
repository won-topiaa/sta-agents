import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseAgentPreset,agentForRequest,describeAgent,asksForRules} from '../lib/mobile-agent-preset.mjs';
import {AGENT_RULES} from '../lib/agent-rules.mjs';
const pick=(...t)=>{const c=chooseAgentPreset(...t);return `${c.style}/${c.preset}`;};
test('the request words choose the style and preset; no style words keep the trend follower',()=>{
  assert.equal(pick('저평가된 배당주 3개, 1년, 목표 5%'),'value/dividend');
  assert.equal(pick('저평가 성장주에 100달러'),'value/garp');
  assert.equal(pick('Growth stocks at a reasonable price'),'value/garp');
  assert.equal(pick('우량주로 안정적으로 1년'),'value/quality_value');
  assert.equal(pick('Undervalued stocks with $50 for a year, target 5%'),'value/deep_value');
  assert.equal(pick('Buy the dip in chip stocks, $30, one year'),'technical/dip');
  assert.equal(pick('쌍바닥 나온 종목 위주로'),'technical/pattern');
  assert.equal(pick('Breakout stocks near 52-week highs'),'technical/breakout');
  assert.equal(pick('신고가 돌파 종목으로 $50'),'technical/breakout');
  assert.equal(pick('섹터 순환 전략으로 $100'),'technical/rotation');
  assert.deepEqual(chooseAgentPreset('모멘텀 강한 주식 $40'),{style:'technical',preset:'trend',matched:true});
  const plain=chooseAgentPreset('Invest $30 for one year in the best 3 of NVDA, AMD, AVGO, TSM, MU, MSFT, GOOGL and META, targeting 5%, max loss 40%. No more than 3 stocks.');
  assert.deepEqual(plain,{style:'technical',preset:'trend',matched:false});
  assert.equal(pick('20% 하락하면 손절, AI 주식 1년'),'technical/trend');
  assert.equal(pick('target 5% yield in a year'),'technical/trend');
});
test('a negated ask, growth alone, a take-profit level or a vague word picks no preset',()=>{
  for(const t of ['Avoid dividend stocks, $50 for a year','no dividend payers please','배당 안 주는 성장 기업','배당주 말고 AI 주식','무배당 기술주','I don\'t want breakout stocks'])
    assert.equal(pick(t),'technical/trend',t);
  assert.equal(pick('배당 안정적인 회사'),'value/dividend');   // 안정 is "stable", not a negation
  assert.equal(pick('성장주 3개에 100달러'),'technical/trend');
  assert.equal(pick('AI growth stocks, $100, one year'),'technical/trend');
  assert.equal(pick('탄탄한 상승세 종목'),'technical/trend');
  assert.equal(pick('5% 돌파하면 익절, 1년 $30'),'technical/trend');
  assert.equal(pick('배당주 말고 저평가 성장주'),'value/garp');
});
test('the newest message wins over the request it completes',()=>{
  assert.equal(pick('이번엔 눌림목 매수로','저평가된 배당주 3개'),'technical/dip');
  assert.equal(pick('$100, 1년','저평가된 배당주 3개'),'value/dividend');
});
test('every preset the chooser can return exists in the rule catalog',()=>{
  for(const t of ['배당','저평가 성장주','우량','저평가','눌림','차트 패턴','신고가','섹터 순환','모멘텀','AI']){const c=chooseAgentPreset(t);assert.ok(AGENT_RULES.styles[c.style]?.presets[c.preset],t);}
});
test('only a request naming a rule-like condition asks the model for rules',()=>{
  for(const t of ['RSI 30 이하에서 사줘','10% 손절','trailing stop at 15%','PER 낮은 배당주','sector leaders','50-day moving average','저평가된 배당주 3개','No more than 3 stocks','the best 3 of NVDA, AMD and MSFT'])assert.ok(asksForRules(t),t);
  for(const t of ['Invest $30 for one year in NVDA, AMD and MSFT','AI 주식 100달러 1년 5%','6개월 동안 저평가된 배당주에 50달러'])assert.ok(!asksForRules(t),t);
});
test('requested rules are added after the preset, once, only from the same style and within the rule and filter limits',()=>{
  const base=agentForRequest('저평가된 배당주');
  assert.equal(base.profile.style,'value');assert.equal(base.profile.preset,'dividend');assert.equal(base.profile.approval,'AUTO_WITHIN_LIMITS');assert.deepEqual(base.added,[]);
  const presetIds=base.profile.rules.map(r=>r.id);
  const valueRule=Object.entries(AGENT_RULES.rules).find(([id,r])=>r.styles.includes('value')&&!presetIds.includes(id))[0];
  const technicalOnly=Object.entries(AGENT_RULES.rules).find(([,r])=>r.styles.includes('technical')&&!r.styles.includes('value'))[0];
  const a=agentForRequest('저평가된 배당주',[{id:valueRule,params:{},evidence:'저평가'},{id:valueRule,params:{},evidence:'저평가'},{id:technicalOnly,params:{},evidence:'배당주'},{id:presetIds[0],params:{},evidence:'배당주'}]);
  assert.deepEqual(a.added.map(x=>x.id),[valueRule]);assert.equal(a.profile.preset,'custom');
  assert.deepEqual(a.profile.rules.map(r=>r.id),[...presetIds,valueRule]);assert.deepEqual(a.fallback.rules.map(r=>r.id),presetIds);
  const many=Object.entries(AGENT_RULES.rules).filter(([id,r])=>r.styles.includes('value')&&!presetIds.includes(id)).map(([id])=>({id,params:{},evidence:'배당주'}));
  const full=agentForRequest('저평가된 배당주',many).profile.rules;
  assert.ok(full.length<=AGENT_RULES.limits.rules);
  assert.ok(full.filter(r=>AGENT_RULES.rules[r.id].filter).length<=AGENT_RULES.limits.filters);
});
test('a requested rule the preset already has keeps the request numbers',()=>{
  const a=agentForRequest('Buy the dip when RSI is below 25',[{id:'oversold_only',params:{rsi_max:25},evidence:'RSI is below 25'}]);
  assert.equal(a.profile.preset,'custom');assert.deepEqual(a.profile.rules.find(r=>r.id==='oversold_only').params,{rsi_max:25});
  assert.equal(a.profile.rules.length,a.fallback.rules.length);assert.deepEqual(a.fallback.rules.find(r=>r.id==='oversold_only').params,{rsi_max:40});
  assert.deepEqual(agentForRequest('Buy the dip',[{id:'oversold_only',params:{rsi_max:40},evidence:'Buy the dip'}]).added,[]);
});
test('a request for funds only gets the trend follower: funds have no company financials to screen',()=>{
  const a=agentForRequest('저평가된 ETF 3개',[],{fundsOnly:true});
  assert.equal(a.style,'technical');assert.equal(a.preset,'trend');assert.equal(a.funds,true);
  assert.match(describeAgent(a),/Funds have no company financials/);
  const b=agentForRequest('Buy the dip in ETFs',[],{fundsOnly:true});
  assert.equal(b.preset,'dip');assert.equal(b.funds,false);
});
test('the chat line names the agent that runs: style, name and rules, with the words behind requested ones',()=>{
  const a=agentForRequest('Buy the dip, $30, one year');
  const line=describeAgent(a);
  assert.match(line,/^Agent: Technical · Dip buyer\. Rules: /);
  for(const r of a.profile.rules)assert.ok(line.includes(AGENT_RULES.rules[r.id].label),r.id);
  const extraId=Object.entries(AGENT_RULES.rules).find(([id,r])=>r.styles.includes('technical')&&!a.profile.rules.some(x=>x.id===id))[0];
  const b=agentForRequest('Buy the dip, $30, one year',[{id:extraId,params:{},evidence:'Buy the dip'}]);
  // The server returns the rules sorted by id; the line keeps the preset's order.
  const saved={...b.profile,rules:[...b.profile.rules].sort((x,y)=>x.id<y.id?-1:1)};
  assert.equal(describeAgent(b,saved),describeAgent(b));
  assert.ok(describeAgent(b).includes(`${AGENT_RULES.rules[extraId].label} (“Buy the dip”)`));
  assert.ok(!describeAgent(b,b.fallback).includes('from your words'));
  const reused={name:'Momentum',style:'technical',rules:[{id:'uptrend_only',params:{days:200}}]};
  assert.equal(describeAgent(b,reused,{reused:true}),'Agent: Technical · Momentum. Rules: Uptrend only. You have 10 saved agents, so this test reuses this one.'.replace('Uptrend only',AGENT_RULES.rules.uptrend_only.label));
});
