// POST /api/mpp/channels/:channelId/topup — add USDC to an existing channel
//
// 1. Send USDC to the payment receiver wallet on-chain
// 2. POST body: { depositUsdc, depositSignature }
// Requires: Authorization: Bearer <channelKey>

import { NextRequest, NextResponse } from "next/server";
import { getChannelById, verifyChannelKey, verifyMppDeposit, recordDeposit, parseMppUsdcAmount } from "@/lib/mpp";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";

type Params = { params: Promise<{ channelId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`mpp-topup:${ip}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const authHeader = req.headers.get("authorization") ?? "";
  const key = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!key) return apiError("AUTH_REQUIRED", "Invalid or missing channel key", 401);
  const { channelId } = await params;
  const channel = getChannelById(channelId);
  if (!channel || !verifyChannelKey(channelId, key)) {
    return apiError("AUTH_REQUIRED", "Invalid or missing channel key", 401);
  }

  if (channel.status !== "open") {
    return apiError("CONFLICT", "Cannot top up a closed channel", 409);
  }

  const body = await req.json().catch(() => null) as {
    depositUsdc?: number | string;
    depositSignature?: string;
  } | null;
  if (!body || typeof body !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }

  const deposit = parseMppUsdcAmount(body.depositUsdc);
  if (!deposit) {
    return apiError("VALIDATION_ERROR", "depositUsdc must be a positive USDC amount with at most 6 decimals", 400);
  }
  if (!body.depositSignature) {
    return apiError(
      "PAYMENT_REQUIRED",
      "depositSignature is required — complete the MPP top-up payment first, then provide the tx signature",
      400
    );
  }

  // Verify on-chain before touching the DB
  let verification: { verified: boolean; error?: string };
  try {
    verification = await verifyMppDeposit(body.depositSignature, deposit, channel.ownerAddress);
  } catch {
    return apiError("PAYMENT_UNAVAILABLE", "Payment processing unavailable", 503);
  }

  if (!verification.verified) {
    return apiError("PAYMENT_FAILED", verification.error ?? "Deposit could not be verified on-chain", 402);
  }

  // Atomically record the deposit and credit the channel balance
  try {
    recordDeposit(channelId, deposit, body.depositSignature);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Deposit could not be recorded";
    const conflict = /already used|not open|not found/i.test(msg);
    return apiError(conflict ? "CONFLICT" : "INTERNAL_ERROR", msg, conflict ? 409 : 500);
  }

  const updated = getChannelById(channelId)!;
  recordAuditEvent({
    req,
    actor: { walletAddress: updated.ownerAddress },
    action: "mpp_channel.topped_up",
    resourceType: "mpp_channel",
    resourceId: channelId,
    ownerWallet: updated.ownerAddress,
    metadata: {
      depositUsdc: deposit.amountUsdc,
      balanceUsdc: updated.balanceUsdc,
      status: updated.status,
    },
  });
  return NextResponse.json({ channel: updated });
}
