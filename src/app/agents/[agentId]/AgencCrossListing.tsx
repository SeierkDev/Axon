"use client";

import { useEffect, useState } from "react";

interface AgencListing {
  agencAgentId: string;
  listingId: string;
  specHash: string;
  cluster: string;
  agentAddress: string | null;
  listingAddress: string | null;
  status: "prepared" | "verified-sandbox" | "live";
  updatedAt: string;
}

const STATUS_LABEL: Record<AgencListing["status"], string> = {
  prepared: "Prepared — goes on-chain when AgenC devnet opens",
  "verified-sandbox": "Verified against AgenC's on-chain program (sandbox)",
  live: "Live on AgenC",
};

const short = (h: string) => `${h.slice(0, 10)}…`;

// Opt-in AgenC cross-listing: mirrors this agent as a service listing on the
// AgenC marketplace protocol. Ids + spec hash are derived deterministically;
// in dev the full flow is executed against AgenC's compiled program first.
export default function AgencCrossListing({ agentId }: { agentId: string }) {
  const [listing, setListing] = useState<AgencListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/agenc/cross-list?agentId=${encodeURIComponent(agentId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { listing: AgencListing | null } | null) => {
        if (alive && d) setListing(d.listing);
      })
      .catch(() => { /* panel just shows the button */ });
    return () => { alive = false; };
  }, [agentId]);

  const crossList = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agenc/cross-list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { listing: AgencListing };
      setListing(d.listing);
    } catch {
      setError("Cross-listing failed — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden mb-10">
      <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex items-center justify-between gap-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          AgenC Cross-Listing
        </p>
        {listing && (
          <span className="inline-flex items-center gap-1 rounded-full border border-pink-200 dark:border-pink-900 bg-pink-50 dark:bg-pink-950/40 px-2 py-0.5 text-[10px] font-semibold text-pink-700 dark:text-pink-400">
            ✓ AgenC
          </span>
        )}
      </div>
      <div className="px-5 py-4">
        {listing ? (
          <div className="space-y-1.5 text-sm">
            <p className="text-gray-700 dark:text-gray-300">{STATUS_LABEL[listing.status]}</p>
            <p className="text-xs text-gray-400 font-mono">agent id: {short(listing.agencAgentId)}</p>
            <p className="text-xs text-gray-400 font-mono">listing id: {short(listing.listingId)}</p>
            <p className="text-xs text-gray-400 font-mono">spec hash: {short(listing.specHash)}</p>
            {listing.listingAddress && (
              <p className="text-xs text-gray-400 font-mono">listing PDA: {short(listing.listingAddress)}</p>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md">
              Mirror this agent as a service listing on the{" "}
              <a href="https://agenc.tech" target="_blank" rel="noopener noreferrer" className="text-pink-600 dark:text-pink-400 hover:underline">
                AgenC
              </a>{" "}
              marketplace protocol. Same canonical spec hash, verifiable on their chain. Settlement stays on Axon.
            </p>
            <button
              onClick={crossList}
              disabled={busy}
              className="rounded-lg bg-pink-600 hover:bg-pink-500 disabled:opacity-60 text-white text-sm font-semibold px-4 py-2"
            >
              {busy ? "Listing…" : "List on AgenC"}
            </button>
          </div>
        )}
        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
      </div>
    </div>
  );
}
