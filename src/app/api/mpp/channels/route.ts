// POST /api/mpp/channels — open a new pre-paid channel
// GET  /api/mpp/channels?owner=<address> — list channels for an owner
//
// Opening a channel:
//   1. Send USDC to the payment receiver wallet on-chain
//   2. POST body: { ownerAddress, depositUsdc, depositSignature }
//   3. Server verifies the on-chain transfer before creating the channel
//   Returns: { channel, channelKey } — store channelKey securely; it is shown ONCE.

import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { isValidSolanaAddress } from "@/lib/solana";
import { createChannel, deleteChannel, getChannelById, getChannelsByOwner, verifyMppDeposit, recordDeposit, parseMppUsdcAmount } from "@/lib/mpp";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";

export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`mpp-open:${ip}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const body = await req.json().catch(() => null) as {
    ownerAddress?: string;
    depositUsdc?: number | string;
    depositSignature?: string;
  } | null;
  if (!body || typeof body !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  if (!body.ownerAddress || !isValidSolanaAddress(body.ownerAddress)) {
    return apiError("VALIDATION_ERROR", "ownerAddress must be a valid Solana address", 400);
  }
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  // 5 channel opens per wallet per minute (IP limit already applied above)
  const walletRl = checkRateLimit(`mpp-open:${auth.user.walletAddress}`, 5, 60_000);
  if (!walletRl.allowed) return tooManyRequests(walletRl);

  if (auth.user.walletAddress !== body.ownerAddress) {
    return apiError("FORBIDDEN", "ownerAddress must match the authenticated API key owner", 403);
  }

  const deposit = parseMppUsdcAmount(body.depositUsdc);
  if (!deposit) {
    return apiError("VALIDATION_ERROR", "depositUsdc must be a positive USDC amount with at most 6 decimals", 400);
  }
  if (!body.depositSignature) {
    return apiError(
      "PAYMENT_REQUIRED",
      "depositSignature is required — complete the MPP deposit payment first, then provide the tx signature",
      400
    );
  }

  // Verify on-chain before touching the DB
  let verification: { verified: boolean; error?: string };
  try {
    verification = await verifyMppDeposit(body.depositSignature, deposit, body.ownerAddress);
  } catch {
    return apiError("PAYMENT_UNAVAILABLE", "Payment processing unavailable", 503);
  }

  if (!verification.verified) {
    return apiError("PAYMENT_FAILED", verification.error ?? "Deposit could not be verified on-chain", 402);
  }

  // Create channel (0 balance), then atomically credit the verified deposit
  const { channel, channelKey } = createChannel(body.ownerAddress);
  try {
    recordDeposit(channel.channelId, deposit, body.depositSignature);
  } catch (err) {
    deleteChannel(channel.channelId);
    const msg = err instanceof Error ? err.message : "Deposit could not be recorded";
    const conflict = /already used|not open|not found/i.test(msg);
    return apiError(conflict ? "CONFLICT" : "INTERNAL_ERROR", msg, conflict ? 409 : 500);
  }

  // Re-fetch to return the credited balance
  const funded = getChannelById(channel.channelId)!;
  recordAuditEvent({
    req,
    actor: auth.user,
    action: "mpp_channel.opened",
    resourceType: "mpp_channel",
    resourceId: funded.channelId,
    ownerWallet: funded.ownerAddress,
    metadata: {
      depositUsdc: funded.balanceUsdc,
      status: funded.status,
    },
  });

  return NextResponse.json(
    {
      channel: funded,
      channelKey,
      warning: "Save channelKey now — it will not be shown again.",
    },
    { status: 201, headers: rateLimitHeaders(walletRl, 5) }
  );
}

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner || !isValidSolanaAddress(owner)) {
    return apiError("VALIDATION_ERROR", "owner query param must be a valid Solana address", 400);
  }
  const listAuth = requireApiKey(req);
  if (!listAuth.ok) return listAuth.response;
  if (listAuth.user.walletAddress !== owner) {
    return apiError("FORBIDDEN", "API key does not belong to this owner wallet", 403);
  }

  const channels = getChannelsByOwner(owner);
  return NextResponse.json({ channels });
}
