import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseAgentPreset,agentForRequest,describeAgent} from '../lib/mobile-agent-preset.mjs';
import {AGENT_RULES} from '../lib/agent-rules.mjs';
const pick=t=>{const c=chooseAgentPreset(t);return `${c.style}/${c.preset}`;};
test('the request words choose the style and preset; no style words keep the trend follower',()=>{
  assert.equal(pick('저평가된 배당주 3개, 1년, 목표 5%'),'value/dividend');
  assert.equal(pick('저평가 성장주에 100달러'),'value/garp');
  assert.equal(pick('우량주로 안정적으로 1년'),'value/quality_value');
  assert.equal(pick('Undervalued stocks with $50 for a year, target 5%'),'value/deep_value');
  assert.equal(pick('Buy the dip in chip stocks, $30, one year'),'technical/dip');
  assert.equal(pick('쌍바닥 나온 종목 위주로'),'technical/pattern');
  assert.equal(pick('Breakout stocks near 52-week highs'),'technical/breakout');
  assert.equal(pick('섹터 순환 전략으로 $100'),'technical/rotation');
  const plain=chooseAgentPreset('Invest $30 for one year in the best 3 of NVDA, AMD, AVGO, TSM, MU, MSFT, GOOGL and META, targeting 5%, max loss 40%. No more than 3 stocks.');
  assert.deepEqual(plain,{style:'technical',preset:'trend',matched:false});
  assert.equal(pick('20% 하락하면 손절, AI 주식 1년'),'technical/trend');
  assert.equal(pick('target 5% yield in a year'),'technical/trend');
});
test('every preset the chooser can return exists in the rule catalog',()=>{
  for(const t of ['배당','성장주','우량','저평가','눌림','차트 패턴','돌파','섹터 순환','AI']){const c=chooseAgentPreset(t);assert.ok(AGENT_RULES.styles[c.style]?.presets[c.preset],t);}
});
test('requested rules are added after the preset, once, only from the same style and within the rule limit',()=>{
  const base=agentForRequest('저평가된 배당주');
  assert.equal(base.profile.style,'value');assert.equal(base.profile.preset,'dividend');assert.equal(base.profile.approval,'AUTO_WITHIN_LIMITS');assert.deepEqual(base.added,[]);
  const presetIds=base.profile.rules.map(r=>r.id);
  const valueRule=Object.entries(AGENT_RULES.rules).find(([id,r])=>r.styles.includes('value')&&!presetIds.includes(id))[0];
  const technicalOnly=Object.entries(AGENT_RULES.rules).find(([,r])=>r.styles.includes('technical')&&!r.styles.includes('value'))[0];
  const a=agentForRequest('저평가된 배당주',[{id:valueRule,params:{},evidence:'저평가'},{id:valueRule,params:{},evidence:'저평가'},{id:technicalOnly,params:{},evidence:'배당주'},{id:presetIds[0],params:{},evidence:'배당주'}]);
  assert.deepEqual(a.added.map(x=>x.id),[valueRule]);assert.equal(a.profile.preset,'custom');
  assert.deepEqual(a.profile.rules.map(r=>r.id),[...presetIds,valueRule]);assert.deepEqual(a.fallback.rules.map(r=>r.id),presetIds);
  const many=Object.entries(AGENT_RULES.rules).filter(([id,r])=>r.styles.includes('value')&&!presetIds.includes(id)).map(([id])=>({id,params:{},evidence:'배당주'}));
  assert.ok(agentForRequest('저평가된 배당주',many).profile.rules.length<=AGENT_RULES.limits.rules);
});
test('the chat line names the style, preset and every kept rule, with the words behind added ones',()=>{
  const a=agentForRequest('Buy the dip, $30, one year');
  const line=describeAgent(a);
  assert.match(line,/^Agent: Technical · Dip buyer\. Rules: /);
  for(const r of a.profile.rules)assert.ok(line.includes(AGENT_RULES.rules[r.id].label),r.id);
  const extraId=Object.entries(AGENT_RULES.rules).find(([id,r])=>r.styles.includes('technical')&&!a.profile.rules.some(x=>x.id===id))[0];
  const b=agentForRequest('Buy the dip, $30, one year',[{id:extraId,params:{},evidence:'Buy the dip'}]);
  assert.ok(describeAgent(b).includes(`${AGENT_RULES.rules[extraId].label} (“Buy the dip”)`));
  assert.ok(!describeAgent(b,true).includes('from your words'));
});
