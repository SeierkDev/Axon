// GET    /api/mpp/channels/:channelId — inspect balance and status
// DELETE /api/mpp/channels/:channelId — close channel and refund remaining USDC (requires Bearer key)

import { NextRequest, NextResponse } from "next/server";
import {
  claimChannelClose,
  finalizeChannelClose,
  getChannelById,
  verifyChannelKey,
} from "@/lib/mpp";
import { sendUsdcRefund } from "@/lib/solana";
import { apiError } from "@/lib/apiError";
import { recordAuditEvent } from "@/lib/audit";
import { withRequestContext } from "@/lib/withRequestContext";

type Params = { params: Promise<{ channelId: string }> };

function extractKey(req: NextRequest): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

export async function GET(req: NextRequest, { params }: Params) {
  const key = extractKey(req);
  if (!key) return apiError("AUTH_REQUIRED", "Invalid or missing channel key", 401);
  const { channelId } = await params;
  const channel = getChannelById(channelId);
  if (!channel || !verifyChannelKey(channelId, key)) {
    return apiError("AUTH_REQUIRED", "Invalid or missing channel key", 401);
  }
  return NextResponse.json({ channel });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    const key = extractKey(req);
    if (!key) return apiError("AUTH_REQUIRED", "Invalid or missing channel key", 401);
    const { channelId } = await params;
    const channel = getChannelById(channelId);
    if (!channel || !verifyChannelKey(channelId, key)) {
      return apiError("AUTH_REQUIRED", "Invalid or missing channel key", 401);
    }

    if (channel.status !== "open") {
      return apiError("CONFLICT", "Channel is already closing or closed", 409);
    }

    if (channel.balanceUsdc > 0 && !process.env.REFUND_SIGNER_PRIVATE_KEY) {
      return apiError(
        "PAYMENT_UNAVAILABLE",
        "Refund processing unavailable. REFUND_SIGNER_PRIVATE_KEY is required to close a funded channel.",
        503
      );
    }

    const claimed = claimChannelClose(channelId);
    if (!claimed) {
      return apiError("CONFLICT", "Channel has in-flight debits or is already closing/closed", 409);
    }

    // ── Refund remaining balance before closing ──────────────────────────────────
    if (claimed.balanceUsdc > 0) {
      try {
        const refundSignature = await sendUsdcRefund(claimed.ownerAddress, claimed.balanceUsdc);
        const closed = finalizeChannelClose(channelId, true);
        if (!closed) return apiError("INTERNAL_ERROR", "Channel close could not be finalized", 500);
        recordAuditEvent({
          req,
          actor: { walletAddress: claimed.ownerAddress },
          action: "mpp_channel.closed",
          resourceType: "mpp_channel",
          resourceId: channelId,
          ownerWallet: claimed.ownerAddress,
          metadata: {
            refundedUsdc: claimed.balanceUsdc,
            refundSucceeded: true,
            status: closed.status,
          },
        });
        return NextResponse.json({
          channel: closed,
          refundedUsdc: claimed.balanceUsdc,
          refundSignature,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Refund failed";
        // Config mismatches are server faults (503); tx errors are surfaced directly (500)
        const isConfig = /is not set|REFUND|WALLET/i.test(msg);
        return apiError(
          isConfig ? "PAYMENT_UNAVAILABLE" : "PAYMENT_FAILED",
          isConfig ? "Refund processing unavailable" : `Refund failed: ${msg}`,
          isConfig ? 503 : 500,
          {
            channelStatus: "closing",
            note: "Channel remains locked to prevent duplicate on-chain refunds.",
          }
        );
      }
    }

    // ── Zero balance — just close ────────────────────────────────────────────────
    const closed = finalizeChannelClose(channelId, true);
    if (!closed) return apiError("INTERNAL_ERROR", "Channel close could not be finalized", 500);
    recordAuditEvent({
      req,
      actor: { walletAddress: claimed.ownerAddress },
      action: "mpp_channel.closed",
      resourceType: "mpp_channel",
      resourceId: channelId,
      ownerWallet: claimed.ownerAddress,
      metadata: {
        refundedUsdc: 0,
        refundSucceeded: true,
        status: closed.status,
      },
    });
    return NextResponse.json({ channel: closed, refundedUsdc: 0 });
  });
}
