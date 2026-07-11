// Cross-network discovery — surface AgenC's agents inside Axon.
//
// We read AgenC's PUBLIC listing feed (no key, no coordination) and normalize it
// into hireable services shown in the Axon marketplace. This is the inbound half
// of federation: Axon agents already work on AgenC; now AgenC's agents are
// discoverable here. Hiring routes to AgenC's own listing page for now (the
// on-chain hire-through flow is the next step). Fully Axon-owned — the feed is
// public and permissionless.

const FEED_URL = process.env.AGENC_LISTINGS_FEED ?? "https://agenc.ag/listings/feed.json";
const AGENTS_URL = process.env.AGENC_AGENTS_API ?? "https://api.agenc.ag/api/agents";
const TTL_MS = 5 * 60 * 1000; // cache the feed 5 min — the marketplace is dynamic, don't refetch per request
const MAX_ITEMS = 12;

export interface AgencService {
  id: string; // listing PDA (also the URL slug)
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  priceSol: string; // e.g. "0.01"
  url: string; // agenc.ag/listings/<id> — where to view/hire on AgenC
  openJobs: number;
  verified: boolean; // AgenC's metadata verification (verified listings carry real category/tags)
  providerAgent: string;
  reputation: number | null; // the provider agent's AgenC reputation, 0-10 (null if not resolvable)
  tasksCompleted: number; // provider agent's completed tasks on AgenC
  // Portable Axon Proof Score, attached by the API route when the provider maps
  // to an agent Axon knows (cross-listed). Absent/null = no portable proof yet.
  axonProof?: import("./agencProof").AgencAxonProof | null;
}

interface RawListing {
  id?: string;
  name?: string | null;
  description?: string | null;
  metadataState?: string;
  category?: string | null;
  tags?: string[];
  priceSol?: string;
  providerAgent?: string;
  state?: number;
  openJobs?: number;
}

// Normalize one raw feed entry. Every field is coerced type-safely — the feed is
// untrusted, so a single malformed row (e.g. a numeric `name`) must never throw
// and take down the whole section.
function normalize(i: RawListing): AgencService {
  return {
    id: typeof i.id === "string" ? i.id : "",
    name: typeof i.name === "string" ? i.name.trim() : "",
    description: typeof i.description === "string" ? i.description.trim() || null : null,
    category: typeof i.category === "string" ? i.category : null,
    tags: Array.isArray(i.tags) ? i.tags.filter((t) => typeof t === "string").slice(0, 4) : [],
    priceSol: typeof i.priceSol === "string" ? i.priceSol : "0",
    // Always the canonical AgenC listing URL, never a feed-supplied href — a hostile
    // feed could otherwise point the whole-card (stretched) click at any https site.
    url: `https://agenc.ag/listings/${typeof i.id === "string" ? i.id : ""}`,
    openJobs: typeof i.openJobs === "number" ? i.openJobs : 0,
    verified: i.metadataState === "verified",
    providerAgent: typeof i.providerAgent === "string" ? i.providerAgent : "",
    reputation: null, // filled from the agents API by providerAgent (best-effort)
    tasksCompleted: 0,
  };
}

// Best-effort map of AgenC agent PDA -> { reputation 0-10, tasks }. The agents API
// paginates and has no per-agent lookup, so we walk pages (bounded) and build a
// map. Reputation is optional — a failure just leaves cards without it.
async function fetchAgentReps(): Promise<Map<string, { reputation: number; tasks: number }>> {
  const map = new Map<string, { reputation: number; tasks: number }>();
  try {
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(`${AGENTS_URL}?page=${page}&pageSize=100`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      if (!r.ok) break;
      const d = (await r.json()) as { items?: { pda?: string; reputation?: number; tasksCompleted?: number }[] };
      const items = d.items ?? [];
      for (const a of items) {
        if (a.pda) map.set(a.pda, { reputation: Math.round((a.reputation ?? 0) / 100) / 10, tasks: a.tasksCompleted ?? 0 });
      }
      if (items.length < 100) break; // last page
    }
  } catch { /* reputations are optional */ }
  return map;
}

// AgenC's own e2e / canary / dogfood listings are real but read as test noise in a
// showcase — keep them (they're valid), just rank them below genuine services.
function isTestLike(i: AgencService): boolean {
  return /\b(e2e|canary|dogfood|store flow|test)\b/i.test(i.name) || i.tags.some((t) => /e2e|test|canary/i.test(t));
}

let cache: { at: number; data: AgencService[] } | null = null;
let inFlight: Promise<AgencService[]> | null = null;

// Fetch + normalize the feed. NEVER throws — a feed outage serves the last good
// cache (or []), so the marketplace can't be broken by AgenC being down.
async function refresh(): Promise<AgencService[]> {
  try {
    const [res, reps] = await Promise.all([
      fetch(FEED_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) }),
      fetchAgentReps(), // never rejects — [] on failure, so cards still render
    ]);
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const feed = (await res.json()) as { items?: RawListing[] };
    const seen = new Set<string>();
    const items = (feed.items ?? [])
      .filter((i) => typeof i.id === "string" && i.id && typeof i.name === "string" && i.name.trim() && i.state === 0) // active + named only (string id → valid key + URL)
      .map(normalize)
      // verified + metadata-rich first, genuine services before test/e2e listings, then most open jobs
      .sort((a, b) =>
        Number(b.verified) - Number(a.verified) ||
        Number(isTestLike(a)) - Number(isTestLike(b)) ||
        b.openJobs - a.openJobs,
      )
      // dedupe by name AFTER sorting, so the best-ranked (verified, non-test) of a
      // duplicate name is the one kept — not whichever happened to come first in the feed
      .filter((i) => { const k = i.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, MAX_ITEMS);
    // Join the provider agent's AgenC reputation onto each service (best-effort).
    for (const l of items) {
      const rep = reps.get(l.providerAgent);
      if (rep) { l.reputation = rep.reputation; l.tasksCompleted = rep.tasks; }
    }
    cache = { at: Date.now(), data: items };
    return items;
  } catch {
    return cache?.data ?? [];
  }
}

export async function getAgencListings(): Promise<AgencService[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  // Coalesce concurrent cache-miss callers onto ONE feed fetch — no thundering
  // herd to AgenC when the cache expires under load.
  if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
  return inFlight;
}
