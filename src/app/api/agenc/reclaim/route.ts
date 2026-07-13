import { NextRequest, NextResponse } from "next/server";
import { getDelivery, prepareCancel, NotReclaimableError } from "@/lib/integrations/agencReclaim";
import { setOrderStatus } from "@/lib/crossNetworkOrders";
import { isValidWallet } from "@/lib/worldAvatar";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// A task PDA is base58, 32-44 chars — bound it before it hits the SDK/RPC.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// GET /api/agenc/reclaim?taskPda=<pda> — a hire's LIVE on-chain delivery status
// (awaiting / in_review / delivered / reclaimed / disputed / gone) and whether
// the escrow is reclaimable. Public: it reads public on-chain state, no wallet
// needed. no-store so the panel always sees the current status.
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`agenc-reclaim-status:${getClientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const taskPda = (req.nextUrl.searchParams.get("taskPda") ?? "").trim();
  if (!B58.test(taskPda)) return apiError("VALIDATION_ERROR", "a valid taskPda is required", 400);
  const delivery = await getDelivery(taskPda);
  return NextResponse.json({ delivery }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/agenc/reclaim — build the UNSIGNED cancelTask transaction the buyer's
// wallet signs to reclaim the escrow of an undelivered hire. Non-custodial: Axon
// never signs or holds funds. Refuses if the hire isn't reclaimable (delivered,
// in review, already reclaimed, disputed). Rate-limited like the hire/buy routes.
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`agenc-reclaim:${getClientIp(req)}`, 15, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const taskPda = typeof b.taskPda === "string" ? b.taskPda.trim() : "";
  const buyerPubkey = typeof b.buyerPubkey === "string" ? b.buyerPubkey.trim() : "";
  if (!B58.test(taskPda) || !isValidWallet(buyerPubkey)) {
    return apiError("VALIDATION_ERROR", "a valid taskPda and buyerPubkey are required", 400);
  }
  try {
    return NextResponse.json(await prepareCancel({ taskPda, buyerPubkey }));
  } catch (e) {
    // "you can't reclaim a delivered/reclaimed hire" is a state conflict (409),
    // not an upstream failure — only genuine RPC/build errors are 502.
    if (e instanceof NotReclaimableError) return apiError("CONFLICT", e.message, 409);
    return apiError("UPSTREAM_ERROR", e instanceof Error ? e.message : "reclaim prepare failed", 502);
  }
}

// PATCH /api/agenc/reclaim — record the local order transition after the buyer's
// reclaim tx confirms on-chain (funded → reclaimed). The on-chain cancel is the
// source of truth, so we DON'T take the caller's word for it: we confirm the task
// is actually Cancelled on-chain before touching the local index. This closes a
// griefing vector — without the check, anyone knowing a wallet + taskPda (both
// public) could falsely mark another user's order reclaimed, hiding their real
// status and the Reclaim button. An attacker can't fake it: they can't sign the
// victim's cancel, so the task never reaches Cancelled for them.
export async function PATCH(req: NextRequest) {
  const rl = checkRateLimit(`agenc-reclaim-patch:${getClientIp(req)}`, 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const wallet = typeof b.wallet === "string" ? b.wallet.trim() : "";
  const taskPda = typeof b.taskPda === "string" ? b.taskPda.trim() : "";
  if (!B58.test(taskPda) || !isValidWallet(wallet)) {
    return apiError("VALIDATION_ERROR", "a valid wallet and taskPda are required", 400);
  }
  // Only accept the transition if the chain actually shows it reclaimed.
  const delivery = await getDelivery(taskPda);
  if (delivery.state !== "reclaimed") {
    return apiError("CONFLICT", "this task isn't cancelled on-chain — reclaim it first", 409);
  }
  const order = setOrderStatus(wallet, taskPda, "reclaimed");
  if (!order) return apiError("VALIDATION_ERROR", "no matching order for this wallet + task", 400);
  return NextResponse.json({ order });
}
