import { NextResponse } from 'next/server';
import {createChartDirectory} from '@/lib/bnb-chart-directory.mjs';
import {binanceTokenPrice} from '@/lib/bnb-gateway';
export const runtime='nodejs';
const read=createChartDirectory();
export async function GET(request:Request){
  const query=new URL(request.url).searchParams;
  const contract=query.get('contract')??'',ticker=query.get('ticker')??'';
  if(!/^0x[a-f0-9]{40}$/.test(contract)||!ticker||ticker.length>24)return NextResponse.json({error:'INVALID_MARKET'},{status:400});
  try{
    const result=await read(contract,ticker);
    if(!result)return NextResponse.json({error:'UNKNOWN_CONTRACT'},{status:404});
    const binance=await binanceTokenPrice(contract).catch(()=>null);
    return NextResponse.json(binance?{...result,binance}:result,{headers:{'Cache-Control':'public, max-age=10','Retry-After':String(result.retryAfter)}});
  }catch{return NextResponse.json({error:'CHART_DIRECTORY_UNAVAILABLE'},{status:503});}
}
