import { NextRequest, NextResponse } from "next/server";
import { claimHandle, releaseHandle, reservationsFor, getReservation, HANDLES_BY_TIER } from "@/lib/reservedHandles";
import { getTier } from "@/lib/holderTier";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { isWalletAddress } from "@/lib/address";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

/**
 * GET /api/handles?wallet=0x…   → what that wallet is holding, and its allowance
 * GET /api/handles?handle=name  → whether one name is taken
 *
 * Public. Whether a name is spoken for is exactly the thing somebody needs to know before building
 * anything around it, and making them authenticate to ask would defeat the purpose.
 */
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`handles:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const handle = req.nextUrl.searchParams.get("handle")?.trim();
  if (handle) {
    const held = getReservation(handle);
    // The holder's wallet is public on chain anyway; what matters to a caller is simply "taken".
    return NextResponse.json({ handle: handle.toLowerCase(), reserved: held !== null, wallet: held?.wallet ?? null });
  }

  const wallet = req.nextUrl.searchParams.get("wallet")?.trim();
  if (!wallet) return apiError("VALIDATION_ERROR", "pass handle or wallet", 400);
  if (!isWalletAddress(wallet)) return apiError("VALIDATION_ERROR", "wallet must be a 0x address", 400);

  const { tier } = await getTier(wallet);
  return NextResponse.json({
    wallet: wallet.toLowerCase(),
    tier: tier.name,
    allowance: HANDLES_BY_TIER[tier.name] ?? 0,
    reservations: reservationsFor(wallet),
  });
}

/**
 * POST /api/handles   { handle }   → claim one
 *
 * Authenticated, and the wallet comes from the key rather than the body: a reservation is a claim
 * against everyone else, so it has to be made by somebody who proved which wallet is theirs.
 */
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`handles-write:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  let body: { handle?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  if (!handle) return apiError("VALIDATION_ERROR", "handle is required", 400);

  const result = await claimHandle(handle, auth.user.walletAddress);
  if (!result.ok) return apiError("CONFLICT", result.reason, 409);

  return NextResponse.json(result.reservation, { status: 201 });
}

/** DELETE /api/handles?handle=name → give one up. Only the wallet holding it can. */
export async function DELETE(req: NextRequest) {
  const rl = checkRateLimit(`handles-write:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const handle = req.nextUrl.searchParams.get("handle")?.trim();
  if (!handle) return apiError("VALIDATION_ERROR", "handle is required", 400);

  const released = releaseHandle(handle, auth.user.walletAddress);
  if (!released) return apiError("NOT_FOUND", "you are not holding that handle", 404);

  return NextResponse.json({ handle: handle.toLowerCase(), released: true });
}
