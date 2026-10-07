import 'server-only';
import { ResearchStoreError } from './research-store.mjs';

// The app never calls Binance directly: the BNB gateway (run in a permitted region) does, behind a token.
type UniverseToken = { contract: string; tokenPrice?: string | null; referencePrice?: string | null };
let prices: { at: number; observedAt: string; byContract: Map<string, UniverseToken> } | null = null;
let loadingPrices: Promise<void> | null = null;
// Token prices from Binance Web3 RWA Data (through the gateway's 5-minute universe cache). Used where no BNB pool is
// indexed by GeckoTerminal, which is most tokenized stocks. Null when the gateway is not configured or unreachable.
export async function binanceTokenPrice(contract: string) {
  if (!process.env.XTXC_BNB_GATEWAY_URL) return null;
  if (!prices || Date.now() - prices.at > 60000) {
    // one refresh shared by every request that arrives meanwhile (the market route needs no sign-in)
    loadingPrices ??= gateway<{ observedAt: string; tokens: UniverseToken[] }>('GET', '/v1/universe', undefined, 10000)
      .then(u => { prices = { at: Date.now(), observedAt: u.observedAt, byContract: new Map(u.tokens.map(t => [t.contract.toLowerCase(), t])) }; })
      .finally(() => { loadingPrices = null; });
    await loadingPrices;
  }
  if (!prices) return null;
  const t = prices.byContract.get(contract.toLowerCase()), price = Number(t?.tokenPrice), reference = Number(t?.referencePrice);
  return t && Number.isFinite(price) && price > 0 ? { priceUsd: price, referencePriceUsd: Number.isFinite(reference) && reference > 0 ? reference : null, observedAt: prices.observedAt, source: 'Binance Web3 RWA Data' as const } : null;
}

export async function gateway<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
  const base = process.env.XTXC_BNB_GATEWAY_URL, token = process.env.XTXC_BNB_GATEWAY_TOKEN;
  if (!base || !token) throw new ResearchStoreError('BNB Chain execution is not configured.', 503);
  let response: Response;
  try {
    response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch { throw new ResearchStoreError('BNB Chain execution is temporarily unreachable. Nothing was sent.', 503); }
  const json = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string; quote?: unknown } } | null;
  if (response.ok && json && 'data' in json) return json.data as T;
  // A refused step (e.g. no BNB for gas) still carries the live quote, so the owner sees what the trade would get.
  throw Object.assign(new ResearchStoreError(json?.error?.message ?? 'BNB Chain execution failed. Nothing was sent.', response.status === 422 ? 409 : 503),
    { code: json?.error?.code, quote: json?.error?.quote });
}
