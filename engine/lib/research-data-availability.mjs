// Availability is a planning hint. The evaluator still verifies object hashes,
// dates and the common history before calculating or accepting any strategy.
export function readyResearchDraft(draft,release){
 if(draft.universeSource!=='STARTER_RESEARCH')return draft;
 if(release?.schema!=='xtxc.research.quant-release/v1'||!release.tickers)throw new Error('RESEARCH_MANIFEST_UNAVAILABLE');
 const minimum=Math.max(756,3*Math.max(5,Math.round(draft.goal.horizonDays*252/365))+379);
 const available=draft.brief.instruments.filter(t=>{
  const r=release.tickers[t];return r?.verification?.ok===true&&Number.isSafeInteger(r.rows)&&r.rows>=minimum&&/^[a-f0-9]{64}$/.test(r.object);
 });
 return{...draft,brief:{...draft.brief,instruments:available},missing:[...draft.missing.filter(k=>k!=='stocks'),...(available.length?[]:['stocks'])],researchData:{releaseId:release.release_id,scope:'starter-universe-availability',minimumSessions:minimum}};
}
