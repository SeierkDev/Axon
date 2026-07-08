import { NextRequest, NextResponse } from "next/server";
import { prepareHire } from "@/lib/integrations/agencHire";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// POST /api/agenc/hire/prepare — phase 1 of the non-custodial hire. Attests the
// listing (server; the attestor pays the on-chain record) and returns an UNSIGNED
// register+hire transaction for the user's own wallet to sign. Spends no Axon SOL,
// so it's public — just rate-limited (it hits the attestor + RPC).
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`agenc-hire-prepare:${getClientIp(req)}`, 10, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const body = (await req.json().catch(() => ({}))) as { listingPda?: unknown; task?: unknown; buyerPubkey?: unknown };
  const listingPda = typeof body.listingPda === "string" ? body.listingPda.trim() : "";
  const task = typeof body.task === "string" ? body.task.trim() : "";
  const buyerPubkey = typeof body.buyerPubkey === "string" ? body.buyerPubkey.trim() : "";
  if (!listingPda || !task || !buyerPubkey) {
    return apiError("VALIDATION_ERROR", "listingPda, task, and buyerPubkey are required", 400);
  }

  try {
    return NextResponse.json(await prepareHire({ listingPda, task, buyerPubkey }));
  } catch (e) {
    return apiError("UPSTREAM_ERROR", e instanceof Error ? e.message : "prepare failed", 502);
  }
}
