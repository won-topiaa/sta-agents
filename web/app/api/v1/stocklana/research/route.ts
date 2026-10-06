import { requireRequesterSession, RequesterAuthError } from '@/lib/requester-auth';
import { researchPrincipal, allowedStocksFor, isBscPrincipal } from '@/lib/research-principal';
import { ResearchStore, ResearchStoreError } from '@/lib/research-store.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const stores = new Map<string, ResearchStore>();
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie, X-Skew-Expected-Requester' };
function database(address: string) {
  // Explicit writable state outside immutable releases; never fall back to /tmp.
  const path = process.env.XTXC_RESEARCH_DB;
  if (!path?.startsWith('/var/lib/xtxc-research/') && !path?.startsWith('/srv/xtxc-operations/research-test/')) throw new ResearchStoreError('Research storage is temporarily unavailable.',503);
  const chain = isBscPrincipal(address) ? 'bsc' : 'solana';
  let store = stores.get(chain);
  if (!store) { store = new ResearchStore(path, allowedStocksFor(address)); stores.set(chain, store); }
  return store;
}
async function owner(request: Request) {
  return researchPrincipal(await requireRequesterSession(request));
}
function failure(error: unknown) {
  if (error instanceof RequesterAuthError || error instanceof ResearchStoreError) return Response.json({error:{message:error.message}},{status:error.status,headers});
  return Response.json({error:{message:'Research could not be saved. Your text is still here; retry shortly.'}},{status:503,headers});
}
export async function GET(request: Request) {
  try {
    const address = await owner(request), query = new URL(request.url).searchParams;
    return Response.json(database(address).read(address,query.get('id'),Number(query.get('after') ?? '0')),{headers});
  } catch (error) { return failure(error); }
}
async function limitedBody(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ResearchStoreError('Use JSON for a research request.',415);
  const reader = request.body?.getReader(); if (!reader) throw new ResearchStoreError('Add a research brief.');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 20000) { await reader.cancel(); throw new ResearchStoreError('Shorten this research note.',413); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ResearchStoreError('Invalid research request.'); }
}
export async function POST(request: Request) {
  try {
    const address = await owner(request), body = await limitedBody(request);
    const strategy = database(address).mutate(address,body);
    return Response.json(database(address).read(address,strategy.id),{headers});
  } catch (error) { return failure(error); }
}
