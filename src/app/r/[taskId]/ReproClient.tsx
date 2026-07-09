"use client";

import { useEffect, useState } from "react";

// The reproducibility proof for a receipt — the front of Proof Layer #2. Fetches
// the public proof (hashes + verdict + similarity + published method, never the
// output text) and shows whether an independent deterministic re-run reproduced
// the work. Renders nothing when a task hasn't been reproduced, so it stays out
// of the way on receipts that don't have a proof yet.

interface ReproMethod {
  formula: string;
  threshold: number;
  inputHash: string;
  note: string;
}

interface ReproProof {
  taskId: string;
  verdict: "exact" | "equivalent" | "divergent";
  similarity: number;
  originalOutputHash: string;
  reproducedOutputHash: string;
  model: string | null;
  temperature: number | null; // null = provider deprecates the parameter
  method: ReproMethod;
  contentHash: string;
  reproducedAt: string;
}

const VERDICT: Record<ReproProof["verdict"], { label: string; badge: string; blurb: string }> = {
  exact: {
    label: "✓ Reproduced — exact match",
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    blurb: "The re-run produced byte-identical output — its hash matches the receipt exactly.",
  },
  equivalent: {
    label: "✓ Reproduced — equivalent",
    badge: "bg-teal-500/15 text-teal-300 border-teal-500/40",
    blurb: "The re-run produced the same work. The hashes differ (models aren't bit-deterministic), but the outputs are lexically equivalent above the published threshold.",
  },
  divergent: {
    label: "✗ Diverged",
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    blurb: "A deterministic re-run produced materially different output. The original work could not be reproduced.",
  },
};

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export default function ReproClient({ taskId }: { taskId: string }) {
  const [proof, setProof] = useState<ReproProof | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none">("loading");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/receipts/${encodeURIComponent(taskId)}/reproduce`);
        if (!alive) return;
        if (!res.ok) return setState("none");
        const data = (await res.json()) as ReproProof;
        if (!alive) return;
        setProof(data);
        setState("ready");
      } catch {
        if (alive) setState("none");
      }
    })();
    return () => {
      alive = false;
    };
  }, [taskId]);

  // No proof for this task → render nothing (keeps un-reproduced receipts clean).
  if (state !== "ready" || !proof) return null;

  const v = VERDICT[proof.verdict];
  const card = "rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-transparent shadow-2xl overflow-hidden";

  return (
    <div className={`${card} mt-5`}>
      <div className="px-7 pt-6 pb-4 border-b border-white/10 flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] tracking-[0.3em] font-mono text-teal-400">REPRODUCIBILITY</p>
          <p className="text-[11px] text-gray-500 mt-1">Re-ran the task and checked the output against the receipt</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${v.badge}`}>
          {v.label}
        </span>
      </div>

      <div className="px-7 py-4 flex flex-wrap gap-x-6 gap-y-2 text-sm border-b border-white/10">
        <div>
          <span className="text-gray-500">Similarity: </span>
          <span className="text-white font-semibold font-mono">{(proof.similarity * 100).toFixed(1)}%</span>
        </div>
        {proof.model && (
          <div>
            <span className="text-gray-500">Model: </span>
            <span className="text-white font-semibold font-mono">{proof.model}</span>
          </div>
        )}
        {proof.temperature !== null && (
          <div>
            <span className="text-gray-500">Temperature: </span>
            <span className="text-white font-semibold font-mono">{proof.temperature}</span>
          </div>
        )}
      </div>

      <div className="px-7 py-5 space-y-3 border-b border-white/10">
        <p className="text-sm text-gray-300">{v.blurb}</p>
        <div className="grid grid-cols-1 gap-2 text-[11px] font-mono">
          <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2">
            <span className="text-gray-500">Original output</span>
            <span className="text-teal-300" title={proof.originalOutputHash}>{short(proof.originalOutputHash)}</span>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2">
            <span className="text-gray-500">Re-run output</span>
            <span className={proof.verdict === "exact" ? "text-emerald-300" : "text-gray-300"} title={proof.reproducedOutputHash}>
              {short(proof.reproducedOutputHash)}
            </span>
          </div>
        </div>
      </div>

      <div className="px-7 py-4 bg-white/[0.03]">
        <p className="text-[11px] text-gray-500">
          Method: {proof.method.formula} (threshold {proof.method.threshold}). Deterministic and recomputable — anyone
          holding both outputs gets the same number, no model needed.
        </p>
        <p className="text-[11px] text-gray-600 mt-1 font-mono break-all" title={proof.contentHash}>
          proof {short(proof.contentHash)}
        </p>
      </div>
    </div>
  );
}
