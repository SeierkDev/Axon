import { NextRequest, NextResponse } from "next/server";
import { getAgencListings } from "@/lib/integrations/agencDiscovery";
import { getAxonProofByPda } from "@/lib/integrations/agencProof";
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

  const raw = await getAgencListings(); // never throws — [] on outage
  // Attach portable Axon Proof Scores where a provider maps to a cross-listed
  // Axon agent — reputation a hirer can verify BEFORE hiring across networks.
  // Copied per request: the lib caches its array, never mutate shared objects.
  const proofs = getAxonProofByPda(raw.flatMap((l) => [l.providerAgent, l.id]));
  const listings = raw.map((l) => ({ ...l, axonProof: proofs.get(l.providerAgent) ?? proofs.get(l.id) ?? null }));
  return NextResponse.json({ listings }, { headers: { "Cache-Control": "public, max-age=60" } });
}
