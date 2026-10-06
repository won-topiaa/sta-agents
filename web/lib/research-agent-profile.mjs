import {AGENT_RULES} from './agent-rules.mjs';

// A user's own agent: a named style whose rules the research engine adds to every
// strategy it designs. The same checks run in the engine (research/agent_profile.py);
// a profile grants no trading authority by itself.
export const PROFILE_SCHEMA='xtxc.agent-profile/v1';
export const APPROVALS=['PER_TRADE','AUTO_WITHIN_LIMITS'];
export const REBALANCES=['weekly','monthly'];
export class AgentProfileError extends Error {constructor(message,status=422){super(message);this.status=status;}}
const fail=message=>{throw new AgentProfileError(message);};
const CONTROL=/[\u0000-\u0008\u000b\u000c\u000e-\u001f‪-‮⁦-⁩]/u;
const UUID=/^[a-f0-9-]{36}$/;
const isNumber=v=>typeof v==='number'&&Number.isFinite(v);

function param(spec,value,name){
  if(!isNumber(value))fail(`${name} must be a number.`);
  if(spec.options){if(!spec.options.includes(value))fail(`${name} must be one of ${spec.options.join(', ')}.`);return value;}
  if(value<spec.min-1e-9||value>spec.max+1e-9)fail(`${name} must be from ${spec.min} to ${spec.max}.`);
  const k=Math.round((value-spec.min)/spec.step);
  if(Math.abs(spec.min+k*spec.step-value)>1e-6)fail(`${name} must move in steps of ${spec.step}.`);
  return Number((spec.min+k*spec.step).toFixed(6));
}
export function normalizeRule(rule,style){
  const spec=AGENT_RULES.rules[rule?.id];
  if(!rule||typeof rule!=='object'||Object.keys(rule).some(k=>!['id','params'].includes(k))||!spec||!Object.hasOwn(AGENT_RULES.rules,rule.id))fail('Unknown agent rule.');
  if(!spec.styles.includes(style))fail(`This rule does not belong to the ${style} style.`);
  const given=rule.params??{};
  if(typeof given!=='object'||Array.isArray(given)||Object.keys(given).some(k=>!Object.hasOwn(spec.params,k)))fail('Unknown rule setting.');
  const params=Object.fromEntries(Object.entries(spec.params).map(([k,p])=>[k,param(p,given[k]??p.default,`${rule.id}.${k}`)]));
  for(const [a,op,b] of spec.requires??[])if(op==='<'&&!(params[a]<params[b]))fail('The short average must be shorter than the long one.');
  return {id:rule.id,params};
}
const bps=(v,lo,hi,name)=>Number.isSafeInteger(v)&&v>=lo&&v<=hi?v:fail(`Check the ${name}.`);
export function normalizeProfile(p){
  if(!p||typeof p!=='object'||p.schema!==PROFILE_SCHEMA)fail('Not an agent profile.');
  const lim=AGENT_RULES.limits,style=AGENT_RULES.styles[p.style];
  if(typeof p.id!=='string'||!UUID.test(p.id))fail('Agent not found.');
  if(!Number.isSafeInteger(p.revision)||p.revision<1)fail('Invalid agent revision.');
  if(typeof p.name!=='string'||!p.name.trim()||p.name.trim().length>lim.name_chars||CONTROL.test(p.name))fail(`Give your agent a name of up to ${lim.name_chars} characters.`);
  if(!style||!Object.hasOwn(AGENT_RULES.styles,p.style)||!style.available)fail('This investing style is not available yet.');
  if(!Object.hasOwn(style.presets,p.preset))fail('Choose a starting style.');
  if(!Array.isArray(p.rules)||p.rules.length>lim.rules)fail(`An agent has at most ${lim.rules} rules.`);
  const rules=p.rules.map(r=>normalizeRule(r,p.style));
  if(new Set(rules.map(r=>r.id)).size!==rules.length)fail('Each rule can be used once.');
  if(rules.filter(r=>AGENT_RULES.rules[r.id].filter).length>lim.filters)fail(`At most ${lim.filters} stock filters.`);
  const philosophy=p.philosophy??'';
  if(typeof philosophy!=='string'||philosophy.length>lim.philosophy_chars||CONTROL.test(philosophy))fail(`Keep the philosophy under ${lim.philosophy_chars} characters.`);
  const r=p.risk;
  if(!r||typeof r!=='object'||Object.keys(r).sort().join()!=='maxDrawdownBps,maxWeightBps,minCashBps')fail('Set the agent risk limits.');
  const risk={maxWeightBps:bps(r.maxWeightBps,100,10000,'per-stock limit'),minCashBps:bps(r.minCashBps,0,9500,'cash reserve'),maxDrawdownBps:bps(r.maxDrawdownBps,100,8000,'loss limit')};
  if(!REBALANCES.includes(p.rebalance))fail('Choose weekly or monthly rebalancing.');
  if(!APPROVALS.includes(p.approval))fail('Choose how trades are approved.');
  return {schema:PROFILE_SCHEMA,id:p.id,revision:p.revision,name:p.name.trim(),style:p.style,preset:p.preset,
    rules:rules.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),philosophy:philosophy.trim(),risk,rebalance:p.rebalance,approval:p.approval};
}
// The editable part of a profile. The server assigns schema, id and revision.
export function profileBody(p){
  return {name:p.name,style:p.style,preset:p.preset,rules:p.rules,philosophy:p.philosophy??'',risk:p.risk,rebalance:p.rebalance,approval:p.approval};
}
export function presetBody(name,style='technical',preset='trend'){
  const s=AGENT_RULES.styles[style],p=s?.presets[preset];if(!p)fail('Unknown preset.');
  return {name,style,preset,rules:p.rules.map(r=>({id:r.id,params:{...r.params}})),philosophy:'',
    risk:{maxWeightBps:2500,minCashBps:1000,maxDrawdownBps:2500},rebalance:p.rebalance,approval:'PER_TRADE'};
}
// Research goals may be stricter than the agent, never looser.
export function clampGoal(goal,profile){
  const r=profile.risk;
  return {...goal,maxWeightBps:Math.min(goal.maxWeightBps,r.maxWeightBps),minCashBps:Math.max(goal.minCashBps,r.minCashBps),maxDrawdownBps:Math.min(goal.maxDrawdownBps,r.maxDrawdownBps)};
}
export const agentSnapshot=p=>({id:p.id,revision:p.revision,name:p.name,style:p.style,approval:p.approval});
