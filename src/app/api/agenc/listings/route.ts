import { NextRequest, NextResponse } from "next/server";
import { getAgencListings } from "@/lib/integrations/agencDiscovery";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/agenc/listings — AgenC's public agents, normalized + cached, for the
// marketplace's cross-network discovery section. Loaded client-side so a slow or
// down AgenC feed only affects this section, never the marketplace page render.
export async function GET(req: NextRequest) {
  const rl = checkRateLimit(`agenc-listings:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const listings = await getAgencListings(); // never throws — [] on outage
  return NextResponse.json({ listings }, { headers: { "Cache-Control": "public, max-age=60" } });
}
