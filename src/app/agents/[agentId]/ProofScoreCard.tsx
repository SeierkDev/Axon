"use client";

import { useState } from "react";
import type { ProofScore } from "@/lib/proofScore";

// Colours per tier — a credit-score-style ladder.
const TIER_STYLES: Record<string, string> = {
  Elite: "border-violet-200 dark:border-violet-900/50 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400",
  Trusted: "border-teal-200 dark:border-teal-900/50 bg-teal-50 dark:bg-teal-950/30 text-teal-700 dark:text-teal-400",
  Established: "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400",
  Emerging: "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400",
  New: "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400",
};

type Verification = {
  verified: boolean;
  receiptsChecked: number;
  receiptsSettled: number;
  recomputedScore: number;
  scoreMatches: boolean;
  note: string;
};

export default function ProofScoreCard({ proof, agentId }: { proof: ProofScore; agentId: string }) {
  const [state, setState] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  const [v, setV] = useState<Verification | null>(null);

  async function verify() {
    setState("checking");
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/proof-score?verify=1`);
      const data = (await res.json()) as Verification;
      setV(data);
      setState(data.verified ? "ok" : "fail");
    } catch {
      setState("fail");
    }
  }

  const quality = Math.round(proof.components.quality.factor * 100);
  const provenWork = Math.round(proof.components.provenWork.factor * 100);
  const tierStyle = TIER_STYLES[proof.tier] ?? TIER_STYLES.New;

  return (
    <div className="rounded-lg border border-teal-200 dark:border-teal-900/50 overflow-hidden mb-10">
      <div className="px-5 py-3 border-b border-teal-200 dark:border-teal-900/50 bg-teal-50/60 dark:bg-teal-950/20 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400">Proof Score</p>
        <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${tierStyle}`}>{proof.tier}</span>
      </div>

      <div className="p-5">
        <div className="flex items-end gap-2 mb-1">
          <span className="text-5xl font-bold text-gray-900 dark:text-white leading-none">{proof.score}</span>
          <span className="text-sm text-gray-400 dark:text-gray-500 mb-1">/ 1000</span>
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-5">
          A portable, recomputable reputation credential — built only from work that settled on-chain.
        </p>

        {/* Component breakdown */}
        <div className="space-y-3 mb-5">
          <Bar label="Quality" pct={quality} sub="success, latency, payment reliability" />
          <Bar label="Proven work" pct={provenWork} sub={`${proof.evidenceCount} settled task${proof.evidenceCount !== 1 ? "s" : ""} on-chain`} />
        </div>

        {/* Verify */}
        <div className="flex flex-wrap items-center gap-3">
          {proof.evidenceCount > 0 ? (
            <button
              onClick={verify}
              disabled={state === "checking"}
              className="text-sm font-medium px-4 py-2 rounded-md bg-teal-600 hover:bg-teal-700 disabled:opacity-60 text-white transition-colors"
            >
              {state === "checking" ? "Verifying…" : "Verify independently"}
            </button>
          ) : (
            <span className="text-xs text-gray-400 dark:text-gray-500">No settled work yet — nothing to verify.</span>
          )}
          <a
            href={`/api/agents/${encodeURIComponent(agentId)}/proof-score`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-teal-600 dark:text-teal-400 hover:underline"
          >
            view raw proof ↗
          </a>
        </div>

        {state === "ok" && v && (
          <div className="mt-4 rounded-md border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/20 px-4 py-3">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              ✓ Independently verified against {v.receiptsSettled} on-chain receipt{v.receiptsSettled !== 1 ? "s" : ""}
            </p>
            <p className="text-xs text-emerald-600/90 dark:text-emerald-500/90 mt-0.5">
              Every cited settlement re-fetched and confirmed; score recomputed to {v.recomputedScore} and matches.
            </p>
          </div>
        )}
        {state === "fail" && (
          <div className="mt-4 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-4 py-3">
            <p className="text-sm text-amber-700 dark:text-amber-400">{v?.note ?? "Could not complete verification — try again."}</p>
          </div>
        )}

        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-4">
          Anyone can recompute this from the cited public receipts — no need to trust Axon. Content hash:{" "}
          <code className="font-mono">{proof.contentHash.slice(0, 16)}…</code>
        </p>
      </div>
    </div>
  );
}

function Bar({ label, pct, sub }: { label: string; pct: number; sub: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-gray-600 dark:text-gray-300 font-medium">{label}</span>
        <span className="text-gray-400 dark:text-gray-500">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
        <div className="h-full rounded-full bg-teal-500 dark:bg-teal-400" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>
    </div>
  );
}
