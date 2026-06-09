import { NextRequest, NextResponse } from "next/server";
import { listAuditEvents } from "@/lib/audit";
import { requireAgentOwner, requireApiKey } from "@/lib/apiAuth";
import { isValidSolanaAddress } from "@/lib/solana";
import { apiError } from "@/lib/apiError";

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
}

export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get("agentId");
  const ownerWallet = req.nextUrl.searchParams.get("ownerWallet");
  const limit = parseLimit(req.nextUrl.searchParams.get("limit"));

  if (!agentId && !ownerWallet) {
    return apiError("VALIDATION_ERROR", "agentId or ownerWallet is required", 400);
  }
  if (agentId && ownerWallet) {
    return apiError("VALIDATION_ERROR", "Use either agentId or ownerWallet, not both", 400);
  }

  if (agentId) {
    const auth = requireAgentOwner(req, agentId);
    if (!auth.ok) return auth.response;
    return NextResponse.json({ events: listAuditEvents({ ownerAgentId: agentId, limit }) });
  }

  if (!ownerWallet || !isValidSolanaAddress(ownerWallet)) {
    return apiError("VALIDATION_ERROR", "ownerWallet must be a valid Solana address", 400);
  }
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (auth.user.walletAddress !== ownerWallet) {
    return apiError("FORBIDDEN", "API key does not belong to this owner wallet", 403);
  }

  return NextResponse.json({ events: listAuditEvents({ ownerWallet, limit }) });
}
