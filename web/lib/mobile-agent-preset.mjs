import {AGENT_RULES} from './agent-rules.mjs';
import {presetBody} from './research-agent-profile.mjs';

// The agent a Research request runs with. The request's own words choose the investing style and preset (the nine
// presets in agent_rules.json); a request that names none keeps the trend follower. More specific asks come first:
// "저평가 성장주" is growth at a reasonable price, "우량 배당주" is dividend value.
const PRESETS=[
  ['value','dividend',/배당|\bdividends?\b|income stocks?/i],
  ['value','garp',/성장주|성장성|growth at a reasonable price|\bgarp\b|growth stocks?|growing (?:sales|revenue)/i],
  ['value','quality_value',/우량|퀄리티|\bquality\b|\broe\b|재무가? ?(?:튼튼|건전)|탄탄한/i],
  ['value','deep_value',/저평가|가치주|가치 ?투자|저per|저pbr|undervalued|value (?:stocks?|investing)|deep value|cheap stocks?|low p\/?e\b/i],
  ['technical','dip',/눌림|저점 ?매수|과매도|떨어진 (?:주식|종목)|\bdips?\b|oversold|pull ?backs?/i],
  ['technical','pattern',/차트 ?패턴|쌍바닥|박스권|chart patterns?|double bottoms?|\bsqueeze\b|range breakouts?|higher highs/i],
  ['technical','breakout',/돌파|신고가|breakouts?|new highs?|52.?week highs?/i],
  ['technical','rotation',/섹터 ?(?:순환|로테이션)|순환매|\brotation\b|strong(?:est)? sectors?/i],
];
export function chooseAgentPreset(text){
  const t=String(text??'');
  for(const [style,preset,re] of PRESETS)if(re.test(t))return {style,preset,matched:true};
  return {style:'technical',preset:'trend',matched:false};
}
// The preset's rules, then the rules the request itself asked for (each quoting it; from SUGGEST_RULES), within the
// catalog's rule limit. `fallback` is the preset alone, used when the server refuses the combination.
export function agentForRequest(text,suggestions=[]){
  const {style,preset,matched}=chooseAgentPreset(text);
  const label=AGENT_RULES.styles[style].presets[preset].label;
  const base={...presetBody(label,style,preset),approval:'AUTO_WITHIN_LIMITS'};
  const have=new Set(base.rules.map(r=>r.id)),added=[];
  for(const s of Array.isArray(suggestions)?suggestions:[]){
    if(base.rules.length+added.length>=AGENT_RULES.limits.rules)break;
    if(!s||typeof s.id!=='string'||have.has(s.id)||!AGENT_RULES.rules[s.id]?.styles?.includes(style))continue;
    added.push({id:s.id,params:{...(s.params??{})},evidence:String(s.evidence??'').slice(0,80)});have.add(s.id);
  }
  const profile=added.length?{...base,preset:'custom',rules:[...base.rules,...added.map(({id,params})=>({id,params}))]}:base;
  return {style,preset,matched,profile,fallback:base,added};
}
// One chat line: the style, the preset and every rule the agent keeps (the added ones with the words they came from).
export function describeAgent(agent,usedFallback=false){
  const style=AGENT_RULES.styles[agent.style],label=id=>AGENT_RULES.rules[id]?.label??id;
  const kept=agent.fallback.rules.map(r=>label(r.id)),extra=usedFallback?[]:agent.added.map(x=>`${label(x.id)} (“${x.evidence}”)`);
  return `Agent: ${style.label} · ${style.presets[agent.preset].label}. Rules: ${kept.join(', ')}${extra.length?`, and from your words: ${extra.join(', ')}`:''}.`;
}
