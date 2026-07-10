"use client";

import { useEffect, useState } from "react";
import type { AgencGood } from "@/lib/integrations/agencGoods";

// Client-side loader for AgenC's goods section — mirrors useAgencListings. A
// module-level promise coalesces concurrent mounts onto one fetch; cleared once
// settled so a transient first-load failure recovers on the next visit.
let inFlight: Promise<AgencGood[]> | null = null;

function load(): Promise<AgencGood[]> {
  if (!inFlight) {
    inFlight = fetch("/api/agenc/goods")
      .then((r) => (r.ok ? r.json() : { goods: [] }))
      .then((d: { goods?: AgencGood[] }) => d.goods ?? [])
      .catch(() => [])
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function useAgencGoods(): AgencGood[] {
  const [goods, setGoods] = useState<AgencGood[]>([]);
  useEffect(() => {
    let alive = true;
    load().then((g) => {
      if (alive) setGoods(g);
    });
    return () => {
      alive = false;
    };
  }, []);
  return goods;
}
