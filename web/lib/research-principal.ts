import { RequesterAuthError } from './requester-auth';
import { LISTED_STOCKS } from './stock-listing-scope';
import { BSC_RESEARCH_STOCKS } from './bsc-research-universe.mjs';

// Research accepts personal wallet sessions on Solana and on BNB Smart Chain. Each chain has its own
// stock universe: Solana StockMesh listings, or BSC Ondo/bStock tokens with verified price history.
export const isBscPrincipal = (address: string) => address.startsWith('eip155:56:');
export const bscWallet = (address: string) => address.slice('eip155:56:'.length);
export function researchPrincipal(session: { address: string; agentKeyId?: string }): string {
  if (session.agentKeyId || !(session.address.startsWith('solana:') || isBscPrincipal(session.address)))
    throw new RequesterAuthError('RESEARCH_SESSION_REQUIRED', 'Sign in with your wallet.', 403);
  return session.address;
}
export const allowedStocksFor = (address: string): readonly string[] => isBscPrincipal(address) ? BSC_RESEARCH_STOCKS : LISTED_STOCKS;
