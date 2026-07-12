import { NextRequest, NextResponse } from "next/server";
import { recordOrder, listOrders } from "@/lib/crossNetworkOrders";
import { isValidWallet } from "@/lib/worldAvatar";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// GET /api/agenc/orders?wallet=<base58> — one wallet's cross-network order
// history (My Hires / My Buys). Public + read-only: the data is already public
// on-chain, this is just the buyer's convenient index of it. no-store so a fresh
// hire/buy shows the moment you reload.
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`agenc-orders-get:${getClientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const wallet = (req.nextUrl.searchParams.get("wallet") ?? "").trim();
  if (!isValidWallet(wallet)) return apiError("VALIDATION_ERROR", "a valid wallet is required", 400);
  return NextResponse.json({ orders: listOrders(wallet) }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/agenc/orders — record an order the user just placed with their own
// wallet (non-custodial; the tx already landed on-chain). Best-effort convenience
// copy: idempotent on the tx signature, so a retried call never duplicates. The
// caller is the hire/buy client after confirmation.
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`agenc-orders-post:${getClientIp(req)}`, 20, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const order = recordOrder({
    wallet: b.wallet,
    kind: b.kind,
    itemPda: b.itemPda,
    name: b.name,
    price: b.price,
    txSig: b.txSig,
  });
  if (!order) return apiError("VALIDATION_ERROR", "wallet, kind (hire|buy), itemPda and txSig are required", 400);
  return NextResponse.json({ order }, { status: 201 });
}
