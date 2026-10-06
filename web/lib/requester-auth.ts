import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";
import { getAddress, verifyMessage } from "viem";

import { productionPostgresUrl } from "./postgres-connection";
import { runtimeConfiguration } from "./runtime-capabilities";
import { AgentAccessError, authenticateAgentApiKey, requireAgentScope } from "./agent-access";
import { validSolanaAddress, verifySolanaSignedMessage } from "./solana-wallet-auth";
import { stockRequestOrigin } from './stock-request-origin';

const COOKIE_NAME = "__Host-skew_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const STOCKLANA_STATELESS_PREFIX = "st1";
const STOCKLANA_SIGN_IN_TITLE = "Skew Stocklana";
const STOCKLANA_SIGN_IN_PURPOSE = "Sign in to trade on Skew.";
const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS requester_auth_challenges(
  challenge_id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS requester_auth_sessions(
  token_digest TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS requester_auth_sessions_address_idx ON requester_auth_sessions(address,expires_at DESC);
CREATE TABLE IF NOT EXISTS requester_rate_limits(
  subject TEXT NOT NULL,
  operation TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count>0),
  PRIMARY KEY(subject,operation,window_start)
);
`;

type ChallengeRow = { address: string; message: string; expires_at: Date | string; consumed_at: Date | string | null };
type SessionRow = { address: string; expires_at: Date | string };
type StocklanaSessionPayload = { v: 1; address: string; expiresAt: string; scopeEpoch: string };

let pool: Pool | undefined;
let initialization: Promise<void> | undefined;
const stocklanaRateWindows = new Map<string, { windowStart: number; count: number }>();

export class RequesterAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 401) {
    super(message);
    this.name = "RequesterAuthError";
  }
}

export async function createRequesterChallenge(addressValue: unknown, request: Request, chainId = 8453) {
  requireSameOrigin(request);
  if (chainId !== 8453 && chainId !== 143) throw new RequesterAuthError("CHAIN_UNSUPPORTED", "Wallet network is not supported.", 422);
  const address = addressValueString(addressValue);
  await enforceRequesterRateLimit(`auth:${address}`, "AUTH_CHALLENGE", 6, 60);
  await ensureInitialized();
  const challengeId = `auth_${randomUUID()}`;
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_SECONDS * 1000);
  const origin = trustedRequestOrigin(request);
  const message = [
    chainId === 143 ? "XTXC Stock Exchange" : "Skew Compute Exchange",
    chainId === 143 ? "Sign in to manage your stock orders." : "Sign in to manage your jobs and GPUs.",
    "",
    `URI: ${origin}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
    `Expiration Time: ${expiresAt.toISOString()}`,
  ].join("\n");
  await database().query(
    "INSERT INTO requester_auth_challenges(challenge_id,address,message,expires_at,created_at) VALUES($1,$2,$3,$4,$5)",
    [challengeId, address, message, expiresAt.toISOString(), issuedAt.toISOString()],
  );
  return { challengeId, address, message, expiresAt: expiresAt.toISOString() };
}

export async function verifyRequesterChallenge(challengeIdValue: unknown, signatureValue: unknown, request: Request) {
  requireSameOrigin(request);
  const challengeId = identifier(challengeIdValue, "challengeId");
  if (typeof signatureValue !== "string" || !/^0x[a-fA-F0-9]{130}$/.test(signatureValue)) {
    throw new RequesterAuthError("SIGNATURE_INVALID", "Wallet signature is invalid.", 422);
  }
  await ensureInitialized();
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ChallengeRow>("SELECT address,message,expires_at,consumed_at FROM requester_auth_challenges WHERE challenge_id=$1 FOR UPDATE", [challengeId]);
    const challenge = result.rows[0];
    if (!challenge || challenge.consumed_at || Date.parse(String(challenge.expires_at)) <= Date.now()) {
      throw new RequesterAuthError("CHALLENGE_EXPIRED", "Start a new wallet sign-in.", 401);
    }
    const valid = await verifyMessage({ address: challenge.address as `0x${string}`, message: challenge.message, signature: signatureValue as `0x${string}` });
    if (!valid) throw new RequesterAuthError("SIGNATURE_INVALID", "Wallet signature did not match this sign-in.", 401);
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    await client.query("UPDATE requester_auth_challenges SET consumed_at=$2 WHERE challenge_id=$1", [challengeId, now.toISOString()]);
    await client.query("INSERT INTO requester_auth_sessions(token_digest,address,expires_at,last_seen_at,created_at) VALUES($1,$2,$3,$4,$4)", [tokenDigest(token), challenge.address, expiresAt.toISOString(), now.toISOString()]);
    await client.query("COMMIT");
    return { address: challenge.address, token, expiresAt: expiresAt.toISOString(), scopeEpoch: browserScopeEpoch(token) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Stocklana login deliberately has no database dependency. The wallet signs a
 * short-lived, origin-bound statement and the server returns an HttpOnly,
 * integrity-protected session cookie. The cookie is only an admission token:
 * a trade still needs a separate signature over its exact Solana transaction.
 */
export async function createStatelessSolanaRequesterSession(addressValue: unknown, messageValue: unknown, signatureValue: unknown, request: Request) {
  requireSameOrigin(request);
  const address = solanaAddress(valueString(addressValue));
  const message = valueString(messageValue);
  if (typeof signatureValue !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signatureValue)) {
    throw new RequesterAuthError("SIGNATURE_INVALID", "Wallet signature is invalid.", 422);
  }
  assertStocklanaSignInMessage(message, address, request);
  if (!verifySolanaSignedMessage(address, message, signatureValue)) {
    throw new RequesterAuthError("SIGNATURE_INVALID", "Wallet signature did not match this sign-in.", 401);
  }
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const scopeEpoch = randomBytes(32).toString("hex");
  const payload: StocklanaSessionPayload = { v: 1, address: `solana:${address}`, expiresAt, scopeEpoch };
  return { address: payload.address, token: signStocklanaSession(payload), expiresAt, scopeEpoch };
}

/**
 * The same stateless, origin-bound session for an EVM wallet on BNB Smart Chain (EIP-191 personal_sign).
 * The principal is `eip155:56:<checksummed address>`. It admits research and preparation only; every
 * BSC trade is still a separate wallet signature over the exact transaction.
 */
export async function createStatelessEvmRequesterSession(addressValue: unknown, messageValue: unknown, signatureValue: unknown, request: Request) {
  requireSameOrigin(request);
  let address: string;
  try { address = getAddress(valueString(addressValue)); } catch { throw new RequesterAuthError("ADDRESS_INVALID", "Enter a valid BNB Chain wallet address.", 422); }
  const message = valueString(messageValue);
  if (typeof signatureValue !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signatureValue)) {
    throw new RequesterAuthError("SIGNATURE_INVALID", "Wallet signature is invalid.", 422);
  }
  assertStocklanaSignInMessage(message, address, request, EVM_SIGN_IN_CHAIN);
  let valid = false;
  try { valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signatureValue as `0x${string}` }); } catch { valid = false; }
  if (!valid) throw new RequesterAuthError("SIGNATURE_INVALID", "Wallet signature did not match this sign-in.", 401);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  const scopeEpoch = randomBytes(32).toString("hex");
  const payload: StocklanaSessionPayload = { v: 1, address: `${EVM_PRINCIPAL_PREFIX}${address}`, expiresAt, scopeEpoch };
  return { address: payload.address, token: signStocklanaSession(payload), expiresAt, scopeEpoch };
}

export async function requireRequester(request: Request, requiredAgentScope?: string): Promise<string> {
  const session = await requireRequesterSession(request);
  if (requiredAgentScope && session.agentScopes) {
    try { requireAgentScope(session.agentScopes, requiredAgentScope); }
    catch (error) { throw requesterAuthFailure(error); }
  }
  return session.address;
}

/** Public local-custody namespace, not the cookie, token digest, or an authority.
 * A fresh authenticated login gets a different namespace even for one wallet. */
export async function requireRequesterSession(request: Request): Promise<{ address: string; scopeEpoch: string; expiresAt: string; agentKeyId?: string; agentScopes?: string[] }> {
  let agent: Awaited<ReturnType<typeof authenticateAgentApiKey>>;
  try { agent = await authenticateAgentApiKey(request); }
  catch (error) { throw requesterAuthFailure(error); }
  if (agent) {
    validateExpectedRequester(request, agent.address);
    return { address: agent.address, scopeEpoch: agent.scopeEpoch, expiresAt: agent.expiresAt, agentKeyId: agent.keyId, agentScopes: agent.scopes };
  }
  if (request.method !== "GET" && request.method !== "HEAD") requireSameOrigin(request);
  const token = sessionToken(request);
  if (!token) throw new RequesterAuthError("AUTH_REQUIRED", "Connect and sign with your wallet to continue.", 401);
  if (token.startsWith(`${STOCKLANA_STATELESS_PREFIX}.`)) {
    const session = verifyStocklanaSession(token);
    if (!session) throw new RequesterAuthError("SESSION_EXPIRED", "Sign in with your wallet again.", 401);
    validateExpectedRequester(request, session.address);
    return session;
  }
  await ensureInitialized();
  const result = await database().query<SessionRow>(
    "UPDATE requester_auth_sessions SET last_seen_at=now() WHERE token_digest=$1 AND expires_at>now() RETURNING address,expires_at",
    [tokenDigest(token)],
  );
  const session = result.rows[0];
  if (!session) throw new RequesterAuthError("SESSION_EXPIRED", "Sign in with your wallet again.", 401);
  validateExpectedRequester(request, session.address);
  return { address: session.address, scopeEpoch: browserScopeEpoch(token), expiresAt: new Date(session.expires_at).toISOString() };
}

/** Preserve isolated test/sandbox fixtures while making every live market request wallet-bound. */
export async function requireLiveRequester(request: Request): Promise<string | null> {
  return runtimeConfiguration().authority === "SANDBOX" ? null : requireRequester(request);
}

export async function optionalRequester(request: Request): Promise<string | null> {
  try { return await requireRequester(request); }
  catch (error) { if (error instanceof RequesterAuthError && error.status === 401) return null; throw error; }
}

export async function revokeRequesterSession(request: Request): Promise<void> {
  requireSameOrigin(request);
  const token = sessionToken(request);
  if (token && !token.startsWith(`${STOCKLANA_STATELESS_PREFIX}.`)) {
    await ensureInitialized();
    await database().query("DELETE FROM requester_auth_sessions WHERE token_digest=$1", [tokenDigest(token)]);
  }
}

export async function enforceRequesterRateLimit(subject: string, operation: string, limit: number, windowSeconds: number): Promise<void> {
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(subject) || !/^[A-Z0-9_]{1,80}$/.test(operation) || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new RequesterAuthError("RATE_POLICY_INVALID", "Request policy is unavailable.", 503);
  }
  await ensureInitialized();
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
  const result = await database().query<{ request_count: number }>(
    `INSERT INTO requester_rate_limits(subject,operation,window_start,request_count) VALUES($1,$2,$3,1)
     ON CONFLICT(subject,operation,window_start) DO UPDATE SET request_count=requester_rate_limits.request_count+1
     WHERE requester_rate_limits.request_count<$4 RETURNING request_count`,
    [subject, operation, windowStart, limit],
  );
  if (!result.rows[0]) throw new RequesterAuthError("RATE_LIMITED", "Wait a moment before trying again.", 429);
  if (Math.random() < 0.01) void database().query("DELETE FROM requester_rate_limits WHERE window_start<now()-interval '1 day'").catch(() => undefined);
}

/** Best-effort process-local flood control for wallet-signed Stocklana flows.
 * It intentionally has no persistence dependency: exact transaction signing
 * and settlement validation remain the security boundary. */
export function enforceStocklanaRequesterRateLimit(subject: string, operation: string, limit: number, windowSeconds: number): void {
  if (!/^[A-Za-z0-9:._-]{1,160}$/.test(subject) || !/^[A-Z0-9_]{1,80}$/.test(operation) || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new RequesterAuthError("RATE_POLICY_INVALID", "Request policy is unavailable.", 503);
  }
  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const key = `${subject}\n${operation}`;
  const current = stocklanaRateWindows.get(key);
  const count = current?.windowStart === windowStart ? current.count + 1 : 1;
  if (count > limit) throw new RequesterAuthError("RATE_LIMITED", "Wait a moment before trying again.", 429);
  stocklanaRateWindows.set(key, { windowStart, count });
  if (stocklanaRateWindows.size > 10_000) {
    for (const [candidate, value] of stocklanaRateWindows) if (value.windowStart < windowStart - 3_600_000) stocklanaRateWindows.delete(candidate);
  }
}

// `__Host-` cookies are only stored with Secure. Browsers accept Secure cookies from http://localhost
// (a secure context), so local development keeps the same cookie as production.
function secureCookieOrigin(request: Request): boolean {
  const origin = new URL(trustedRequestOrigin(request));
  return origin.protocol === "https:" || origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
}
export function requesterCookie(token: string, expiresAt: string, request: Request) {
  return { name: COOKIE_NAME, value: token, httpOnly: true, secure: secureCookieOrigin(request), sameSite: "lax" as const, path: "/", expires: new Date(expiresAt) };
}

export function expiredRequesterCookie(request: Request) {
  return { name: COOKIE_NAME, value: "", httpOnly: true, secure: secureCookieOrigin(request), sameSite: "lax" as const, path: "/", expires: new Date(0) };
}

function database(): Pool {
  if (!pool) { pool = new Pool({ connectionString: productionPostgresUrl(), max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 }); attachDatabasePool(pool); }
  return pool;
}

async function ensureInitialized(): Promise<void> {
  if (!initialization) initialization = initialize().catch((error) => { initialization = undefined; throw error; });
  await initialization;
}

async function initialize(): Promise<void> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_949_222_221]);
    await client.query(AUTH_SCHEMA);
    await client.query("DELETE FROM requester_auth_challenges WHERE expires_at<now()-interval '1 hour'");
    await client.query("DELETE FROM requester_auth_sessions WHERE expires_at<now()");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function sessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{43}$/.test(value) || new RegExp(`^${STOCKLANA_STATELESS_PREFIX}\\.[A-Za-z0-9_-]{20,1200}\\.[A-Za-z0-9_-]{43}$`).test(value) ? value : null;
    }
  }
  return null;
}

function tokenDigest(value: string): string { return createHash("sha256").update("skew-requester-session/v1\n").update(value).digest("hex"); }
function browserScopeEpoch(token: string): string { return createHash("sha256").update("skew-browser-local-custody-namespace/v1\n").update(token).digest("hex"); }
function identifier(value: unknown, label: string): string { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(value)) throw new RequesterAuthError("INVALID_REQUEST", `${label} is invalid.`, 422); return value; }
function addressValueString(value: unknown): string { if (typeof value !== "string") throw new RequesterAuthError("ADDRESS_INVALID", "Enter a valid Base wallet address.", 422); try { return getAddress(value).toLowerCase(); } catch { throw new RequesterAuthError("ADDRESS_INVALID", "Enter a valid Base wallet address.", 422); } }
function valueString(value: unknown): string { if (typeof value !== "string") throw new RequesterAuthError("ADDRESS_INVALID", "Enter a valid Solana wallet address.", 422); return value; }
function trustedRequestOrigin(request: Request): string { return stockRequestOrigin(request,process.env.SKEW_STOCKLANA_PUBLIC_ORIGIN); }
function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = trustedRequestOrigin(request);
  if (!origin || origin !== expected) throw new RequesterAuthError("ORIGIN_REJECTED", "Request origin is not authorized.", 403);
}

function validateExpectedRequester(request: Request, address: string): void {
  const expected = request.headers.get("X-Skew-Expected-Requester");
  if (expected !== null && expected !== address) {
    throw new RequesterAuthError("SESSION_CHANGED", "Your account changed. Review this request again.", 403);
  }
}

function solanaAddress(value: string): string {
  if (!validSolanaAddress(value)) throw new RequesterAuthError("ADDRESS_INVALID", "Enter a valid Solana wallet address.", 422);
  return value;
}

const EVM_SIGN_IN_CHAIN = "Chain: BNB Smart Chain (eip155:56)";
export const EVM_PRINCIPAL_PREFIX = "eip155:56:";
function evmPrincipalAddress(value: string): string | null {
  if (!value.startsWith(EVM_PRINCIPAL_PREFIX)) return null;
  const raw = value.slice(EVM_PRINCIPAL_PREFIX.length);
  try { return getAddress(raw) === raw ? raw : null; } catch { return null; }
}

function assertStocklanaSignInMessage(message: string, address: string, request: Request, chainLine = "Chain: Solana"): void {
  if (message.length > 2048) throw new RequesterAuthError("INVALID_REQUEST", "Wallet sign-in request is invalid.", 422);
  const lines = message.split("\n");
  if (lines.length !== 10 || lines[0] !== STOCKLANA_SIGN_IN_TITLE || lines[1] !== STOCKLANA_SIGN_IN_PURPOSE || lines[2] !== ""
    || lines[3] !== `URI: ${trustedRequestOrigin(request)}` || lines[4] !== "Version: 1" || lines[5] !== chainLine
    || lines[6] !== `Address: ${address}` || !/^Nonce: [a-f0-9]{32}$/.test(lines[7] ?? "")) {
    throw new RequesterAuthError("MESSAGE_INVALID", "Wallet sign-in request is invalid.", 422);
  }
  const issuedAt = lines[8]?.slice("Issued At: ".length);
  const expiresAt = lines[9]?.slice("Expiration Time: ".length);
  if (!lines[8]?.startsWith("Issued At: ") || !lines[9]?.startsWith("Expiration Time: ") || !issuedAt || !expiresAt
    || !isCanonicalIso(issuedAt) || !isCanonicalIso(expiresAt)) {
    throw new RequesterAuthError("MESSAGE_INVALID", "Wallet sign-in request is invalid.", 422);
  }
  const now = Date.now();
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (issued < now - CHALLENGE_TTL_SECONDS * 1000 || issued > now + 30_000 || expires <= now || expires - issued < 30_000 || expires - issued > CHALLENGE_TTL_SECONDS * 1000) {
    throw new RequesterAuthError("CHALLENGE_EXPIRED", "Start a new wallet sign-in.", 401);
  }
}

function signStocklanaSession(payload: StocklanaSessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", stocklanaSessionSecret()).update(`${STOCKLANA_STATELESS_PREFIX}.${body}`).digest("base64url");
  return `${STOCKLANA_STATELESS_PREFIX}.${body}.${signature}`;
}

function verifyStocklanaSession(token: string): { address: string; scopeEpoch: string; expiresAt: string } | null {
  const [prefix, body, signature, extra] = token.split(".");
  if (prefix !== STOCKLANA_STATELESS_PREFIX || !body || !signature || extra !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const expected = createHmac("sha256", stocklanaSessionSecret()).update(`${prefix}.${body}`).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<StocklanaSessionPayload>;
    if (payload.v !== 1 || typeof payload.address !== "string"
      || !((payload.address.startsWith("solana:") && validSolanaAddress(payload.address.slice(7))) || evmPrincipalAddress(payload.address))
      || typeof payload.scopeEpoch !== "string" || !/^[0-9a-f]{64}$/.test(payload.scopeEpoch) || typeof payload.expiresAt !== "string"
      || !isCanonicalIso(payload.expiresAt) || Date.parse(payload.expiresAt) <= Date.now()) return null;
    return { address: payload.address, scopeEpoch: payload.scopeEpoch, expiresAt: payload.expiresAt };
  } catch { return null; }
}

function stocklanaSessionSecret(): Buffer {
  const value = process.env.SKEW_STOCKLANA_SESSION_SECRET;
  if (!value || Buffer.byteLength(value, "utf8") < 32) throw new RequesterAuthError("AUTH_UNAVAILABLE", "Wallet sign-in is temporarily unavailable.", 503);
  return Buffer.from(value, "utf8");
}

function isCanonicalIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function requesterAuthFailure(error: unknown): RequesterAuthError {
  if (error instanceof RequesterAuthError) return error;
  if (error instanceof AgentAccessError) return new RequesterAuthError(error.code, error.message, error.status);
  return new RequesterAuthError("AUTH_UNAVAILABLE", "Account access is temporarily unavailable.", 503);
}
