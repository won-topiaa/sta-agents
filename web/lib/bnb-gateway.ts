import 'server-only';
import { ResearchStoreError } from './research-store.mjs';

// The app never calls Binance directly: the BNB gateway (run in a permitted region) does, behind a token.
export async function gateway<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 30000): Promise<T> {
  const base = process.env.XTXC_BNB_GATEWAY_URL, token = process.env.XTXC_BNB_GATEWAY_TOKEN;
  if (!base || !token) throw new ResearchStoreError('BNB Chain execution is not configured.', 503);
  let response: Response;
  try {
    response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch { throw new ResearchStoreError('BNB Chain execution is temporarily unreachable. Nothing was sent.', 503); }
  const json = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
  if (response.ok && json && 'data' in json) return json.data as T;
  throw new ResearchStoreError(json?.error?.message ?? 'BNB Chain execution failed. Nothing was sent.', response.status === 422 ? 409 : 503);
}
