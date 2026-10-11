import {AGENT_RULES} from './agent-rules.mjs';
import {presetBody} from './research-agent-profile.mjs';

// The agent a Research request runs with. The request's own words choose the investing style and preset (the nine
// presets in agent_rules.json); a request that names none keeps the trend follower. More specific asks come first:
// "저평가 성장주" is growth at a reasonable price, "우량 배당주" is dividend value. Growth alone is not GARP (it asks for
// no price check), and "5% 돌파하면 익절" is a take-profit, not a breakout strategy.
const GROWTH=String.raw`성장주|성장성|성장하는|\bgrowth\b`;
const FAIR_PRICE=String.raw`저평가|합리적|적정 ?가격|저렴|저per|\bpeg\b|reasonabl[ey]|cheap|undervalued|fair(?:ly)? price`;
const PRESETS=[
  ['value','dividend',/배당|\bdividends?\b|income stocks?/i],
  ['value','garp',new RegExp(String.raw`\bgarp\b|growth at a reasonable price|(?:${FAIR_PRICE})[^.!?\n]{0,30}(?:${GROWTH})|(?:${GROWTH})[^.!?\n]{0,30}(?:${FAIR_PRICE})`,'i')],
  ['value','quality_value',/우량|퀄리티|\bquality\b|\broe\b|재무가? ?(?:튼튼|건전)/i],
  ['value','deep_value',/저평가|가치주|가치 ?투자|저per|저pbr|undervalued|value (?:stocks?|investing)|deep value|cheap stocks?|low p\/?e\b/i],
  ['technical','dip',/눌림|저점 ?매수|과매도|떨어진 (?:주식|종목)|\bdips?\b|oversold|pull ?backs?/i],
  ['technical','pattern',/차트 ?패턴|쌍바닥|박스권|chart patterns?|double bottoms?|\bsqueeze\b|range breakouts?|higher highs/i],
  ['technical','breakout',/(?:신고가|전고점|고점|저항선?) ?돌파|돌파 ?(?:종목|주식|매매|전략)|신고가|\bbreak ?outs?\b|new highs?|52.?week highs?|all.?time highs?/i],
  ['technical','rotation',/섹터 ?(?:순환|로테이션)|순환매|\brotation\b|strong(?:est)? sectors?/i],
  ['technical','trend',/추세|모멘텀|상승세|momentum|uptrend|trend.?follow/i],
];
// A negated ask picks nothing: "avoid dividend stocks", "no breakouts", "배당 안 주는", "배당주 말고", "무배당".
// (안정/안전 are "stable/safe", not a negation.)
const NOT_BEFORE=/(?:\b(?:no|not|non|avoid(?:ing)?|without|except|excluding|exclude|skip|never|don'?t|instead of|rather than)\b[^.,!?\n%$\d]{0,14}|[무비])$/i;
const NOT_AFTER=/^[^\s,.]{0,3}\s*(?:안(?![정전심])|않|없|빼|말고|제외|싫|피하|피해|아닌|아니)/;
function asks(text,re){
  const t=String(text??'');
  for(const m of t.matchAll(new RegExp(re.source,`${re.flags}g`))){
    const end=m.index+m[0].length;
    if(!NOT_BEFORE.test(t.slice(Math.max(0,m.index-40),m.index))&&!NOT_AFTER.test(t.slice(end,end+12)))return true;
  }
  return false;
}
// texts: the newest words first (this message, then the request it completes), so a new ask beats an older one.
export function chooseAgentPreset(...texts){
  for(const t of texts)for(const [style,preset,re] of PRESETS)if(asks(t,re))return {style,preset,matched:true};
  return {style:'technical',preset:'trend',matched:false};
}
// Model rule suggestions cost tokens from the shared daily budget, so only a request that names a rule-like
// condition (a stop, an indicator, a ratio, a number of stocks) asks for them; any other runs with its preset's rules.
const RULE_WORDS=/손절|익절|트레일링|이동 ?평균|이평|골든 ?크로스|데드 ?크로스|\brsi\b|macd|볼린저|거래량|변동성|모멘텀|추세|상승세|하락|신고가|저점|고점|과매도|과매수|\bper\b|pbr|\bpeg\b|\broe\b|부채|마진|이익률|영업이익|매출|실적|현금 ?흐름|배당 ?(?:수익률|성향)|섹터|업종|시가 ?총액|시총|대형주|소형주|stop.?loss|trailing|take.?profit|moving average|\bsma\b|\bema\b|\d+.?day|golden cross|death cross|volume|volatil|momentum|trend|52.?week|oversold|overbought|p\/?[eb]\b|earnings|revenue|margin|debt|cash flow|yield|payout|sector|market cap|large.?cap|small.?cap|\bbeta\b|\d+ ?(?:개(?!월)|종목)|(?:top|best|at most|no more than|up to|max(?:imum)?)\s*\d+|\d+\s*(?:stocks?|names|holdings|companies|tickers)\b/i;
export function asksForRules(text){return RULE_WORDS.test(String(text??''));}
const isFilter=id=>Boolean(AGENT_RULES.rules[id]?.filter);
const sameParams=(a,b)=>Object.entries(b).every(([k,v])=>a?.[k]===v);
// The preset's rules, then the rules the request itself asked for (each quoting it; from SUGGEST_RULES), within the
// catalog's rule and filter limits. A rule the preset already has takes the request's own numbers ("RSI below 25").
// fundsOnly: every pick is a fund. Funds have no company financials for a value screen, so the trend follower runs.
// `fallback` is the preset alone, used when the server refuses the combination.
export function agentForRequest(texts,suggestions=[],{fundsOnly=false}={}){
  let {style,preset,matched}=chooseAgentPreset(...[texts].flat());
  const funds=Boolean(fundsOnly&&style==='value');
  if(funds)({style,preset,matched}={style:'technical',preset:'trend',matched:false});
  const lim=AGENT_RULES.limits,label=AGENT_RULES.styles[style].presets[preset].label;
  const base={...presetBody(label,style,preset),approval:'AUTO_WITHIN_LIMITS'};
  const rules=base.rules.map(r=>({id:r.id,params:{...r.params}})),added=[];
  for(const s of Array.isArray(suggestions)?suggestions:[]){
    if(!s||typeof s.id!=='string'||!AGENT_RULES.rules[s.id]?.styles?.includes(style)||added.some(x=>x.id===s.id))continue;
    const params=s.params&&typeof s.params==='object'?{...s.params}:{},evidence=String(s.evidence??'').slice(0,80);
    const have=rules.find(r=>r.id===s.id);
    if(have){if(sameParams(have.params,params))continue;have.params={...have.params,...params};}
    else if(rules.length>=lim.rules||(isFilter(s.id)&&rules.filter(r=>isFilter(r.id)).length>=lim.filters))continue;
    else rules.push({id:s.id,params});
    added.push({id:s.id,params,evidence});
  }
  const profile=added.length?{...base,preset:'custom',rules}:base;
  return {style,preset,matched,funds,profile,fallback:base,added};
}
// One chat line about the agent that runs the test (`saved`: the server's copy, which may be the preset alone or, at
// the 10-agent limit, a saved agent reused): its style, name and rules, with the words behind the requested ones.
export function describeAgent(agent,saved=agent.profile,{reused=false}={}){
  const style=AGENT_RULES.styles[saved.style]??AGENT_RULES.styles[agent.style],label=id=>AGENT_RULES.rules[id]?.label??id;
  const order=id=>{const i=agent.profile.rules.findIndex(r=>r.id===id);return i<0?99:i;};
  const words=new Map(agent.added.map(x=>[x.id,x]));
  const kept=[],extra=[];
  for(const r of [...(saved.rules??[])].sort((a,b)=>order(a.id)-order(b.id))){
    const w=words.get(r.id);
    if(w&&sameParams(r.params,w.params))extra.push(`${label(r.id)} (“${w.evidence}”)`);else kept.push(label(r.id));
  }
  const name=saved.name||style.presets[agent.preset]?.label||agent.preset;
  const note=reused?' You have 10 saved agents, so this test reuses this one.':agent.funds?' Funds have no company financials to screen, so it follows the trend.':'';
  const parts=[...(kept.length?[kept.join(', ')]:[]),...(extra.length?[`${kept.length?'and ':''}from your words: ${extra.join(', ')}`]:[])];
  return `Agent: ${style.label} · ${name}. Rules: ${parts.join(', ')}.${note}`;
}
