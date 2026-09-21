import { NextResponse } from "next/server";
import { burnHealth } from "@/lib/burnHealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/burn/health
//
// Whether the burn is still actually running: the loop alive, the gas wallet funded, and no burn
// sitting due and fundable for longer than it should. Public, because it says nothing that is not
// already on chain, and because something anyone can check is more use than something only we can.
//
// 200 when healthy, 503 when not, so an uptime monitor can watch this URL and say something
// without anyone having to read the body.
export async function GET() {
  const health = await burnHealth();
  return NextResponse.json(health, {
    status: health.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
