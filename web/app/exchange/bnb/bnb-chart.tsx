'use client';
import { useEffect, useState, useRef } from 'react';
import StockTradingViewChart from '../stock-tradingview-chart';
import type {StockChartInterval,StockChartStyle} from '@/lib/stock-tradingview';
import { geckoEmbedUrl, type GeckoResponse, type GeckoMarket } from '@/lib/bnb-gecko.mjs';
import type { BnbProduct } from '@/lib/bnb-market-directory';
import { money } from './bnb-parts';

const shared=new Map<string,GeckoResponse>();
const flights=new Map<string,Promise<GeckoResponse>>();
function readMarket(product:BnbProduct):Promise<GeckoResponse>{
  if(flights.has(product.contract))return flights.get(product.contract)!;
  const task=fetch(`/api/bnb/market?${new URLSearchParams({ticker:product.ticker,contract:product.contract})}`,{signal:AbortSignal.timeout(12000)})
    .then(async r=>{if(!r.ok)throw Error('Market unavailable');const result=await r.json() as GeckoResponse;
      if(result.market&&(result.market.contract!==product.contract||result.market.chainId!==56))throw Error('Market identity changed');
      shared.delete(product.contract);shared.set(product.contract,result);while(shared.size>256)shared.delete(shared.keys().next().value!);return result;}).finally(()=>flights.delete(product.contract));
  flights.set(product.contract,task);return task;
}
export default function BnbChart({product,onObservation,onBinancePrice}:{product:BnbProduct;onObservation?:(market:GeckoMarket)=>void;onBinancePrice?:(contract:string,priceUsd:number)=>void}){
  const [data,setData]=useState<GeckoResponse|null>(shared.get(product.contract)??null),[retry,setRetry]=useState(0),[loading,setLoading]=useState(!data);
  const [resolution,setResolution]=useState('1h'),[frameReady,setFrameReady]=useState(false),[frameSlow,setFrameSlow]=useState(false);
  const [referenceFailed,setReferenceFailed]=useState(false),[stockStyle,setStockStyle]=useState<StockChartStyle>('line');
  const frame=useRef<HTMLIFrameElement>(null);
  const chartReady=useRef(false);
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
    const update=async()=>{
      if(document.hidden)return;
      try {const result=await readMarket(product);if(stopped)return;setData(result);setNow(Date.now());if(result.market)onObservation?.(result.market);if(result.binance)onBinancePrice?.(product.contract,result.binance.priceUsd);
        timer=setTimeout(update,Math.max(60000,result.retryAfter*1000));}
      catch{if(!stopped){setData(v=>v?{...v,status:'UNAVAILABLE'}:{status:'UNAVAILABLE',market:null,retryAfter:60});timer=setTimeout(update,60000);}}
      finally{if(!stopped)setLoading(false);}
    };
    void update();const visible=()=>{if(!document.hidden){if(timer)clearTimeout(timer);void update();}};
    document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[product.contract,product.ticker,retry,onObservation,onBinancePrice]);
  const observation=data?.market;
  const stale=!!observation&&(now-Date.parse(observation.observedAt)>90000||data?.status!=='AVAILABLE');
  const listing=!observation?data?.mapping?.underlyingChart?.symbol??null:null;
  // TradingView's embedded chart serves US listings only; HKEX, LSE, XETR and BME symbols render "This symbol is only
  // available on TradingView". Those open on TradingView instead.
  const underlying=listing&&/^(NASDAQ|NYSE|AMEX|BATS):/.test(listing)?listing:null;
  const offsite=listing&&!underlying?listing:null;
  const reference=!observation&&!underlying&&!!data?.mapping?.coinId;
  // Most tokenized stocks have no BNB pool indexed by GeckoTerminal; Binance Web3 RWA Data still prices the token.
  const binance=!observation?data?.binance:undefined;
  const binanceLine=binance&&<div className="price-line"><span className="stock-price">{money(binance.priceUsd)}</span><span className="price-change"><small>{product.tokenSymbol} · Binance Web3 RWA price · {new Date(binance.observedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</small></span></div>;
  const source=observation?geckoEmbedUrl(observation.pool,resolution):reference?`/api/bnb/chart-widget?${new URLSearchParams({contract:product.contract,ticker:product.ticker,retry:String(retry)})}`:null;
  useEffect(()=>{chartReady.current=false;setFrameReady(false);setFrameSlow(false);setReferenceFailed(false);if(!source)return;const timer=setTimeout(()=>{if(!chartReady.current){setFrameSlow(true);if(reference)setReferenceFailed(true);}},18000);return()=>clearTimeout(timer);},[source,reference]);
  useEffect(()=>{if(!reference)return;const receive=(event:MessageEvent)=>{if(event.source!==frame.current?.contentWindow||event.origin!=='null'||event.data?.type!=='xtxc.chart.status'||event.data?.coinId!==data?.mapping?.coinId)return;if(event.data.status==='ready'){chartReady.current=true;setFrameReady(true);setReferenceFailed(false);}else if(event.data.status==='unavailable'){setReferenceFailed(true);setFrameReady(true);}};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[reference,data?.mapping?.coinId]);
  if(underlying){const interval:StockChartInterval=resolution==='4h'?'4H':resolution==='1d'?'intraday':'1H';return <section className="bnb-chart" aria-label={`${product.ticker} underlying stock price history`}>{binanceLine}<StockTradingViewChart symbol={underlying} interval={interval} style={stockStyle}/><div className="bnb-chart-bottom"><div aria-label="Chart interval">{['1h','4h','1d'].map(period=><button key={period} aria-pressed={period===resolution} onClick={()=>setResolution(period)}>{period.toUpperCase()}</button>)}</div><div aria-label="Chart style"><button aria-pressed={stockStyle==='line'} onClick={()=>setStockStyle('line')}>Line</button><button aria-pressed={stockStyle==='candlesticks'} onClick={()=>setStockStyle('candlesticks')}>Candles</button></div></div></section>;}
  return <section className="bnb-chart" aria-label={`${product.ticker} token price history`}>
    {binanceLine??(!reference&&<div className="price-line"><span className="stock-price">{money(observation?.priceUsd)}</span>{observation?.change24h!=null&&<span className={`price-change ${observation.change24h>=0?'positive':'negative'}`}>{observation.change24h>=0?'+':''}{observation.change24h.toFixed(2)}% <small>24h</small></span>}</div>)}
    <div className="bnb-chart-source"><span>{product.tokenSymbol} · {reference?'Token reference · all markets':stale?'Last observed pool price':'BNB pool price'}</span><a href={reference?`https://www.coingecko.com/en/coins/${data?.mapping?.coinId}`:observation?`https://www.geckoterminal.com/bsc/pools/${observation.pool}`:`https://www.geckoterminal.com/bsc/tokens/${product.contract}`} target="_blank" rel="noreferrer">CoinGecko / GeckoTerminal ↗</a></div>
    {source?<><div className="bnb-gecko-frame" aria-busy={!frameReady&&!referenceFailed}>
      {referenceFailed&&<div className="bnb-chart-empty" role="status"><h3>Price history is not published yet</h3><p>{product.tokenSymbol}</p><a href={`https://www.coingecko.com/en/coins/${data?.mapping?.coinId}`} target="_blank" rel="noreferrer">View token ↗</a></div>}
      {!frameReady&&!referenceFailed&&<div className="bnb-chart-loading">Loading chart…</div>}
      <iframe ref={frame} style={referenceFailed?{display:'none'}:undefined} key={source} src={source} sandbox={reference?'allow-scripts':undefined} title={`${product.ticker} ${reference?'token reference':'BNB pool'} chart by CoinGecko`} loading="eager" allow="fullscreen" allowFullScreen referrerPolicy="no-referrer" onLoad={()=>{if(!reference){chartReady.current=true;setFrameReady(true);}}}/>
    </div>{frameSlow&&!frameReady&&<div className="bnb-chart-recovery"><span>The chart is taking longer than usual.</span><a href={reference?`https://www.coingecko.com/en/coins/${data?.mapping?.coinId}`:`https://www.geckoterminal.com/bsc/pools/${observation!.pool}`} target="_blank" rel="noreferrer">Open chart ↗</a></div>}</>
    :offsite&&!loading?<div className="bnb-chart-empty" role="status"><span className="bnb-chart-placeholder" aria-hidden="true">↗</span><h3>{offsite.split(':')[0]} charts open on TradingView</h3><p>{product.tokenSymbol} · {offsite} underlying stock</p><a href={`https://www.tradingview.com/symbols/${offsite.replace(':','-')}/`} target="_blank" rel="noreferrer">View {offsite} chart ↗</a></div>
    :<div className="bnb-chart-empty" role="status"><span className="bnb-chart-placeholder" aria-hidden="true">↗</span><h3>{loading?'Opening market data':data?.status==='NO_POOL'?'No indexed BNB chart yet':'Market data is reconnecting'}</h3><p>{product.tokenSymbol} · BNB Chain</p>{!loading&&data?.status!=='NO_POOL'&&<button onClick={()=>{setLoading(true);setRetry(n=>n+1);}}>Try again</button>}</div>}
    {!reference&&<div className="bnb-chart-bottom"><div aria-label="Chart interval">{(['1h','4h','1d'] as const).map(period=><button key={period} aria-pressed={period===resolution} onClick={()=>setResolution(period)}>{period.toUpperCase()}</button>)}</div><span>Line & candles · chart toolbar</span></div>}
    {observation&&<dl className="bnb-pool-stats"><div><dt>Pool liquidity</dt><dd>{money(observation.liquidityUsd)}</dd></div><div><dt>Pool volume · 24h</dt><dd>{money(observation.poolVolume24hUsd)}</dd></div><div><dt>Updated</dt><dd>{new Date(observation.observedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</dd></div></dl>}
  </section>;
}
