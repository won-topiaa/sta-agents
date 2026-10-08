"""Read-only price adapter + target evaluator. Reuses the pinned XTXC backtester.

No provider request, wallet, RPC, credential or generated-code execution lives here.
Today's universe and ex-post adjusted prices are disclosed as retrospective research,
not point-in-time coverage or forecasts. Raw data is not sent to Kiln.
"""
import csv, datetime as dt, gzip, hashlib, io, json, math, os, pathlib, sys
import numpy as np
import pandas as pd
from xtxc_agent.research.backtest import simulate, report_curve

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def load_prices(root, tickers, column='adjclose', common=True):
    """Verified daily values per ticker. ``common``: only sessions every ticker has (else the union, NaN-padded)."""
    root = pathlib.Path(root)
    path = root / 'prices' / 'quant_release.json'
    if not path.exists(): raise ValueError('WAITING_DATA: A verified price release has not been published.')
    # Bound the read before allocation; a length check after read_bytes is too late.
    with path.open('rb') as f:
        raw = f.read(2_000_001)
    if len(raw) > 2_000_000: raise ValueError('WAITING_DATA: Price manifest too large.')
    release = json.loads(raw)
    if release.get('schema') != 'xtxc.research.quant-release/v1' or release.get('source') != 'xtxc-quant-store/verified-v1':
        raise ValueError('WAITING_DATA: Unrecognized price release.')
    published = dt.datetime.fromisoformat(release['created_at'].replace('Z','+00:00'))
    if published.tzinfo is None:
        raise ValueError('WAITING_DATA: Price release timestamp needs a timezone.')
    age = dt.datetime.now(dt.timezone.utc).timestamp() - published.timestamp()
    if age < -60:
        raise ValueError('WAITING_DATA: Price release is from the future.')
    if age > 7*86400:
        raise ValueError('WAITING_DATA: Refresh the verified price release.')
    content, coverage = {}, {}
    for ticker in tickers:
        row = release['tickers'].get(ticker, {})
        obj = row.get('object','')
        if len(obj) != 64 or any(c not in '0123456789abcdef' for c in obj):
            raise ValueError('WAITING_DATA: Missing verified history for '+ticker)
        # Reference replacements are real observations; seeded/fallback history is not.
        provenance = row.get('provenance','')
        if not (row.get('verification',{}).get('ok') is True or provenance.startswith('reference:')):
            raise ValueError('WAITING_DATA: Unverified source for '+ticker)
        with gzip.open(root/'prices'/'objects'/(obj+'.csv.gz'),'rb') as f:
            data = f.read(8_000_001)
        if len(data)>8_000_000 or digest(data)!=obj: raise ValueError('WAITING_DATA: Price object hash mismatch.')
        records = list(csv.DictReader(io.StringIO(data.decode())))
        if len(records)>6000: raise ValueError('WAITING_DATA: Oversized price history.')
        values={}
        for r in records:
            d = dt.date.fromisoformat(r['date'])
            if d >= dt.datetime.now(dt.timezone.utc).date(): raise ValueError('WAITING_DATA: Incomplete or future session.')
            if r['date'] in values: raise ValueError('WAITING_DATA: Duplicate session.')
            try: x=float(r[column])
            except (TypeError, ValueError):
                raise ValueError('WAITING_DATA: Malformed adjusted price.')
            if not math.isfinite(x) or x<0 or (x==0 and column!='volume'): raise ValueError('WAITING_DATA: Invalid adjusted price.')
            values[r['date']]=x
        content[ticker]=pd.Series(values,dtype='float64')
        coverage[ticker]={'objectHash':obj,'rows':len(values),'provenance':provenance}
    prices=pd.DataFrame(content).sort_index()
    if common: prices=prices.dropna()
    prices.index=pd.to_datetime(prices.index)
    if prices.empty or (dt.datetime.now(dt.timezone.utc).date()-prices.index[-1].date()).days>7:
        raise ValueError('WAITING_DATA: Common price history is stale or empty.')
    return prices,{'id':digest(raw),'releaseId':release['release_id'],'asOf':str(prices.index[-1].date()),'coverage':coverage,
        'scope':'retrospective-adjusted-price-research','rights':'demo-research; no raw redistribution or model processing',
        'limitations':['Current listed universe; survivorship bias remains.','Adjusted history is not a point-in-time fundamentals dataset.','Historical costs are assumptions, not measured past token liquidity.']}

def assess(result, goal):
    """Non-overlapping held-out horizon windows, never a probability forecast."""
    horizon=max(5,round(goal['horizonDays']*252/365))
    eq=np.asarray([r[1] for r in result['equity']],dtype=float)
    # Reserve enough history for three disjoint outcomes at the requested horizon.
    holdout=min(len(eq)-253,max(252,horizon*3))
    if holdout<horizon*3: raise ValueError('WAITING_DATA: At least three held-out target horizons are required.')
    start=len(eq)-1-holdout
    windows=[float(eq[i+horizon]/eq[i]-1) for i in range(start,len(eq)-horizon,horizon)]
    segment=eq[start:]
    r=segment[1:]/segment[:-1]-1
    net=float(segment[-1]/segment[0]-1)
    dd=float(np.min(segment/np.maximum.accumulate(segment)-1))
    median=float(np.median(windows)); target=goal['targetReturnBps']/10000
    reasons=[]
    if median<target: reasons.append('TARGET_NOT_SUPPORTED')
    # The loss limit holds over the whole backtest too (e.g. 2022), not only over the held-out years.
    full=abs(float(result.get('metrics',{}).get('max_drawdown') or 0.0))
    if max(abs(dd),full)>goal['maxDrawdownBps']/10000: reasons.append('DRAWDOWN_LIMIT_EXCEEDED')
    if net<=0: reasons.append('NON_POSITIVE_HOLDOUT_RETURN')
    return {'verdict':'DECLINED' if reasons else 'ELIGIBLE','reasons':reasons,
        'horizonMedianBps':round(median*10000),'horizonWorstBps':round(min(windows)*10000),
        'horizonBestBps':round(max(windows)*10000),'holdoutReturnBps':round(net*10000),
        'holdoutDrawdownBps':round(abs(dd)*10000),'fullDrawdownBps':round(full*10000),'windowCount':len(windows),
        'holdoutStart':result['equity'][start][0],
        'sharpe':None if np.std(r,ddof=1)==0 else round(float(np.mean(r)/np.std(r,ddof=1)*math.sqrt(252)),3)}

def evaluate(request, root):
    if request.get('proposal',{}).get('designs') is not None:
        from design_bridge import evaluate_designs
        return evaluate_designs(request, root)
    strategy,goal,proposal=request['strategy'],request['goal'],request['proposal']
    tickers=strategy['instruments']
    if not 1<=len(tickers)<=64: raise ValueError('Invalid universe.')
    prices,snapshot=load_prices(root,sorted(set(tickers+['QQQ'])))
    h=max(5,round(goal['horizonDays']*252/365))
    required=max(756,3*h+379)
    if len(prices)<required: raise ValueError('WAITING_DATA: Common history needs '+str(required)+' sessions for this horizon; available '+str(len(prices))+'.')
    candidates=[]
    for template in ('equal_weight','low_vol','momentum'):
        params={'band':'0'}
        if template!='equal_weight': params['lookback']=proposal['lookback']
        if template=='momentum': params['positive_only']=True
        spec={'template':template,'params':params,'universe':tickers,'max_weight':str(goal['maxWeightBps']/10000),
            'min_cash':str(goal['minCashBps']/10000),'rebalance':proposal['rebalance'],'exclude_leveraged':True,
            'benchmark':'QQQ','period':{'years':5}}
        res=simulate(spec,prices,{'default_bps':goal['costBps']},snapshot_id=snapshot['id'])
        stress=simulate(spec,prices,{'default_bps':goal['costBps']*2},snapshot_id=snapshot['id'])
        assessment=assess(res,goal);stress_assessment=assess(stress,goal)
        if stress_assessment['verdict']!='ELIGIBLE' and assessment['verdict']=='ELIGIBLE':
            assessment['verdict']='DECLINED';assessment['reasons'].append('COST_STRESS_FAILED')
        weights=[{'instrument':t,'weightBps':int(math.floor(w*10000))} for t,w in sorted(res['latest_target']['weights'].items()) if math.floor(w*10000)>0]
        if not weights: assessment['verdict']='DECLINED';assessment['reasons'].append('NO_CURRENT_ALLOCATION')
        candidates.append({'id':template,'name':{'equal_weight':'Balanced basket','low_vol':'Lower volatility','momentum':'Trend following'}[template],
            **assessment,'weights':weights,'cashBps':10000-sum(w['weightBps'] for w in weights),
            'metrics':res['metrics'],'costsPaidPct':res['costs_paid'],'costBps':goal['costBps'],
            'stressHorizonMedianBps':stress_assessment['horizonMedianBps'],'curve':report_curve(res,220),
            'period':res['period'],'assumptions':res['assumptions'],'specHash':res['spec_hash']})
    eligible=[c for c in candidates if c['verdict']=='ELIGIBLE']
    return {'schema':'xtxc.research-evaluation/v1','dataset':snapshot,'candidates':candidates,
        'decision':'REVIEW' if eligible else 'DECLINED',
        'explanation':'Historical evidence supports reviewing '+str(len(eligible))+' strategies under these limits. This is not a forecast.' if eligible else
        'I would not trade this target. None of the tested strategies meets the requested return, loss limit and doubled-cost test. Lower the target, allow more time, or keep cash.',
        'method':'Three predeclared long/cash strategies; signal at t close, execution at t+1 close; disjoint held-out horizon comparisons.',
        'computedAt':dt.datetime.now(dt.timezone.utc).isoformat()}

if __name__=='__main__':
    try:
        body=sys.stdin.buffer.read(20001)
        if len(body)>20000: raise ValueError('Request too large.')
        request=json.loads(body)
        if '--inspect' in sys.argv:
            prices,snapshot=load_prices(os.environ['XTXC_RESEARCH_DATA_ROOT'], sorted(set(request['strategy']['instruments']+['QQQ'])))
            result={'dataset':snapshot,'rows':len(prices)}
            if os.environ.get('XTXC_RESEARCH_DESIGNS')=='1':
                from design_bridge import prompt
                result['designMessages']=prompt(request)
        else: result=evaluate(request,os.environ['XTXC_RESEARCH_DATA_ROOT'])
        print(json.dumps(result,allow_nan=False,separators=(',',':')))
    except Exception as e:
        # No traceback, path, key or raw data in the user response.
        message=str(e) if isinstance(e,ValueError) else ('WAITING_DATA: Price release could not be read.' if isinstance(e, (FileNotFoundError, PermissionError, gzip.BadGzipFile)) else 'Research computation failed ('+type(e).__name__+').')
        print(json.dumps({'error':message[:350]}));sys.exit(2)
