"use client";

import { useEffect, useState } from "react";
import type { AgencService } from "@/lib/integrations/agencDiscovery";

// Shared client-side loader for the cross-network section. Both the header promo
// (AgencIntro) and the listings section (AgencListings) read from this one hook so
// they appear and disappear together — the promo can never advertise agents that
// aren't shown, and the "#agenc" jump-link never points at a section that isn't
// there. A module-level promise coalesces both consumers onto a single fetch.
let inFlight: Promise<AgencService[]> | null = null;

function load(): Promise<AgencService[]> {
  if (!inFlight) {
    inFlight = fetch("/api/agenc/listings")
      .then((r) => (r.ok ? r.json() : { listings: [] }))
      .then((d: { listings?: AgencService[] }) => d.listings ?? [])
      .catch(() => []) // fail soft — both consumers just render nothing
      // Clear once settled so a later mount refetches: a transient first-load
      // failure (network blip, a 429 from the route's own rate limit, AgenC briefly
      // down) recovers on the next visit instead of hiding the section all session,
      // and navigating back to /agents picks up fresh listings. Concurrent consumers
      // still coalesce — they both call load() before this first fetch resolves.
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

export function useAgencListings(): AgencService[] {
  const [listings, setListings] = useState<AgencService[]>([]);
  useEffect(() => {
    let alive = true;
    load().then((l) => { if (alive) setListings(l); });
    return () => { alive = false; };
  }, []);
  return listings;
}
