import { getAddress, toHex } from 'viem';
import { ensureSolanaSession } from './stocklana-exchange-client';

// Research works with a Solana wallet or a BNB Smart Chain (EVM) wallet. The chain follows the
// connected address; the session principal is solana:<address> or eip155:56:<checksummed address>.
type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
export const isEvmWallet = (wallet: string) => /^0x[0-9a-fA-F]{40}$/.test(wallet);
export const researchPrincipalOf = (wallet: string) => isEvmWallet(wallet) ? `eip155:56:${getAddress(wallet)}` : `solana:${wallet}`;
export const evmProvider = () => (window as unknown as { ethereum?: Eip1193 }).ethereum;
export function ensureResearchSession(wallet: string): Promise<string> {
  return isEvmWallet(wallet) ? ensureEvmSession(wallet) : ensureSolanaSession(wallet);
}
export async function ensureEvmSession(wallet: string): Promise<string> {
  const principal = researchPrincipalOf(wallet), address = getAddress(wallet);
  const current = await fetch('/api/v1/requester-sessions', { cache: 'no-store', headers: { 'X-Skew-Expected-Requester': principal } });
  if (current.ok) { const body = await current.json() as { address?: string | null }; if (body.address === principal) return principal; }
  const provider = evmProvider();
  if (!provider) throw new Error('Open XTXC in your BNB Chain wallet or enable your wallet extension.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
  if (!Array.isArray(accounts) || !accounts.some(a => a.toLowerCase() === wallet.toLowerCase())) throw new Error('The connected wallet changed. Review the request again.');
  const issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  const message = ['Skew Stocklana', 'Sign in to trade on Skew.', '', `URI: ${window.location.origin}`, 'Version: 1', 'Chain: BNB Smart Chain (eip155:56)', `Address: ${address}`,
    `Nonce: ${nonce}`, `Issued At: ${issuedAt.toISOString()}`, `Expiration Time: ${expiresAt.toISOString()}`].join('\n');
  const signature = await provider.request({ method: 'personal_sign', params: [toHex(message), address] }) as string;
  const reply = await fetch('/api/v1/requester-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'EVM_SESSION', address, message, signature }) });
  const verified = await reply.json() as { address?: string; error?: { message?: string } };
  if (!reply.ok || verified.address !== principal) throw new Error(verified.error?.message ?? 'Wallet sign-in failed.');
  return principal;
}
