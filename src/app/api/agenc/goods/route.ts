import { NextRequest, NextResponse } from "next/server";
import { getAgencGoods } from "@/lib/integrations/agencGoods";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// GET /api/agenc/goods — AgenC's public goods listings, normalized for the Axon
// marketplace. Public, read-only, fails soft to [] on any AgenC outage. Rate-
// limited for parity with the sibling /api/agenc/listings route. no-store so the
// browser never serves a stale list — a good selling out or a new listing shows
// immediately; AgenC's feed is still shielded from load by the 5-min lib cache.
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`agenc-goods:${getClientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const goods = await getAgencGoods();
  return NextResponse.json({ goods }, { headers: { "Cache-Control": "no-store" } });
}
