import { NextResponse } from "next/server";

import {
  createRequesterChallenge,
  createStatelessSolanaRequesterSession,
  createStatelessEvmRequesterSession,
  expiredRequesterCookie,
  requireRequesterSession,
  requesterCookie,
  RequesterAuthError,
  revokeRequesterSession,
  verifyRequesterChallenge,
} from "@/lib/requester-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { return json(await requireRequesterSession(request)); }
  catch (error) {
    if (error instanceof RequesterAuthError && error.status === 401)
      return json({ address: null, scopeEpoch: null, expiresAt: null });
    return authError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await boundedJson(request, 8 * 1024);
    if (body.operation === "CHALLENGE" && (Object.keys(body).sort().join(",") === "address,operation"
      || Object.keys(body).sort().join(",") === "address,chainId,operation")) {
      return json(await createRequesterChallenge(body.address, request, body.chainId === undefined ? 8453 : body.chainId as number), 201);
    }
    if (body.operation === "VERIFY" && Object.keys(body).sort().join(",") === "challengeId,operation,signature") {
      const verified = await verifyRequesterChallenge(body.challengeId, body.signature, request);
      const response = json({ address: verified.address, expiresAt: verified.expiresAt, scopeEpoch: verified.scopeEpoch }, 201);
      response.cookies.set(requesterCookie(verified.token, verified.expiresAt, request));
      return response;
    }
    if (body.operation === "SOLANA_SESSION" && Object.keys(body).sort().join(",") === "address,message,operation,signature") {
      const verified = await createStatelessSolanaRequesterSession(body.address, body.message, body.signature, request);
      const response = json({ address: verified.address, expiresAt: verified.expiresAt, scopeEpoch: verified.scopeEpoch }, 201);
      response.cookies.set(requesterCookie(verified.token, verified.expiresAt, request));
      return response;
    }
    if (body.operation === "EVM_SESSION" && Object.keys(body).sort().join(",") === "address,message,operation,signature") {
      const verified = await createStatelessEvmRequesterSession(body.address, body.message, body.signature, request);
      const response = json({ address: verified.address, expiresAt: verified.expiresAt, scopeEpoch: verified.scopeEpoch }, 201);
      response.cookies.set(requesterCookie(verified.token, verified.expiresAt, request));
      return response;
    }
    throw new RequesterAuthError("INVALID_REQUEST", "Wallet sign-in request is invalid.", 422);
  } catch (error) { return authError(error); }
}

export async function DELETE(request: Request) {
  try {
    await revokeRequesterSession(request);
    const response = json({ signedOut: true });
    response.cookies.set(expiredRequesterCookie(request));
    return response;
  } catch (error) { return authError(error); }
}

async function boundedJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new RequesterAuthError("UNSUPPORTED_MEDIA_TYPE", "Wallet sign-in must use JSON.", 415);
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new RequesterAuthError("BODY_TOO_LARGE", "Wallet sign-in request is too large.", 413);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new RequesterAuthError("INVALID_JSON", "Wallet sign-in request must be valid JSON.", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RequesterAuthError("INVALID_REQUEST", "Wallet sign-in request is invalid.", 422);
  return value as Record<string, unknown>;
}

function json(value: unknown, status = 200) { return NextResponse.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
function authError(error: unknown) { const known = error instanceof RequesterAuthError ? error : new RequesterAuthError("AUTH_UNAVAILABLE", "Wallet sign-in is temporarily unavailable.", 503); return json({ error: { code: known.code, message: known.message } }, known.status); }
