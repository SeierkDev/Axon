import { NextRequest, NextResponse } from "next/server";
import { getWorldSnapshot } from "@/lib/world";
import { getTier } from "@/lib/holderTier";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/world — the Axon Open World city model derived from live network state
// (Phase 10). Metadata only: agent name, district, real metrics, and a stable
// world position per agent. Rate-limited per IP; the snapshot is memoized so a
// flood can't load the DB.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`world:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const snapshot = getWorldSnapshot();

  // What each building's owner holds, so standing in the world reflects standing on the network.
  //
  // Resolved here rather than in the snapshot builder, which is synchronous and memoized: a tier is
  // a balance on chain, and pulling a network call into that would make the city model wait on an
  // RPC. Tiers are cached per wallet, and most plots share a handful of owners, so this is a few
  // reads rather than one per building. A failure leaves every plot at base, which shows nothing.
  const owners = [...new Set(snapshot.plots.map((p) => p.walletAddress).filter(Boolean))] as string[];
  const byWallet = new Map<string, string>();
  await Promise.all(
    owners.map(async (w) => {
      const { tier } = await getTier(w);
      if (tier.rank > 0) byWallet.set(w.toLowerCase(), tier.name);
    }),
  );

  const plots = snapshot.plots.map((p) => ({
    ...p,
    ownerTier: p.walletAddress ? byWallet.get(p.walletAddress.toLowerCase()) ?? null : null,
  }));

  return NextResponse.json({ ...snapshot, plots }, {
    headers: { ...rateLimitHeaders(rl, RATE_LIMIT), "Cache-Control": "public, max-age=15" },
  });
}
