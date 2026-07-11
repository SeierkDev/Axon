import { NextRequest, NextResponse } from "next/server";
import { holdsAxon, GATE_AMOUNT } from "@/lib/arcadeGate";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// GET /api/world/arcade/gate?wallet=<address> — can this wallet play the
// minigames? The world checks BEFORE letting a player enter a mode: guests
// can't play at all, and a connected wallet must hold ≥ GATE_AMOUNT $AXON
// (balance verified on-chain, 5-min cached, fails open on RPC outage).
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`arcade-gate:${getClientIp(req)}`, 30, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const wallet = req.nextUrl.searchParams.get("wallet") ?? "";
  if (!wallet) return NextResponse.json({ eligible: false, required: GATE_AMOUNT }, { status: 400 });
  const eligible = await holdsAxon(wallet);
  return NextResponse.json({ eligible, required: GATE_AMOUNT }, { headers: { "Cache-Control": "no-store" } });
}
