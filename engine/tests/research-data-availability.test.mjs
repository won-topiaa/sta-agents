import test from 'node:test';
import assert from 'node:assert/strict';
import {readyResearchDraft} from '../lib/research-data-availability.mjs';
const draft={universeSource:'STARTER_RESEARCH',brief:{instruments:['SPY','NVDA','JNJ']},goal:{horizonDays:365},missing:[],authority:'RESEARCH_DRAFT_ONLY'};
const release={schema:'xtxc.research.quant-release/v1',release_id:'a'.repeat(64),tickers:{SPY:{rows:4200,verification:{ok:true},object:'b'.repeat(64)},NVDA:{rows:4200,verification:{ok:true},object:'c'.repeat(64)}}};
test('starter research only uses manifest-backed history for the required horizon',()=>{const d=readyResearchDraft(draft,release);assert.deepEqual(d.brief.instruments,['SPY','NVDA']);assert.equal(d.researchData.minimumSessions,1135);assert.equal(d.authority,'RESEARCH_DRAFT_ONLY');});
test('explicit user stock choices are not silently removed for data coverage',()=>{const d={...draft,universeSource:'YOUR_REQUEST'};assert.equal(readyResearchDraft(d,release),d);});
test('empty, short, rejected or malformed histories do not imply ready',()=>{for(const rows of [0,200,1134]){const r={...release,tickers:{SPY:{...release.tickers.SPY,rows}}};assert.deepEqual(readyResearchDraft(draft,r).missing,['stocks']);}assert.throws(()=>readyResearchDraft(draft,{}));});
