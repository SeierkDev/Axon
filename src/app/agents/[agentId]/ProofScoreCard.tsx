"use client";

import { useState } from "react";
import type { ProofScore } from "@/lib/proofScore";
import { ExtArrow } from "@/components/ExtArrow";

// Colours per tier — a credit-score-style ladder.
const TIER_STYLES: Record<string, string> = {
  Elite: "border-violet-200 dark:border-violet-900/50 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400",
  Trusted: "border-teal-200 dark:border-teal-900/50 bg-teal-50 dark:bg-teal-950/30 text-teal-700 dark:text-teal-400",
  Established: "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400",
  Emerging: "border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400",
  New: "border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400",
};

// Proper display names for networks (the stored key is lowercase, e.g. "agenc").
const NETWORK_LABEL: Record<string, string> = { agenc: "AgenC", axon: "Axon" };
function networkLabel(n: string): string {
  return NETWORK_LABEL[n.toLowerCase()] ?? n.charAt(0).toUpperCase() + n.slice(1);
}

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
  const [showMath, setShowMath] = useState(false);

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
  // Work this agent proved on OTHER networks (e.g. AgenC) — its reputation follows
  // it across the boundary instead of resetting, each item verifiable on its origin.
  const crossNetwork = (proof.evidence ?? []).filter((e) => e.network !== "axon");

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

        {/* Cross-network work — reputation that travels across agent networks */}
        {crossNetwork.length > 0 && (
          <div className="mb-5 rounded-md border border-pink-200 dark:border-pink-900/50 bg-pink-50/60 dark:bg-pink-950/20 px-4 py-3">
            <p className="text-xs font-semibold text-pink-700 dark:text-pink-400 mb-1.5">
              Reputation that travels — {crossNetwork.length} settlement{crossNetwork.length !== 1 ? "s" : ""} earned on other networks
            </p>
            <ul className="space-y-1">
              {crossNetwork.map((e) => (
                <li key={`${e.network}:${e.taskId}`} className="flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-300">
                  <span>{networkLabel(e.network)} · settled on-chain</span>
                  <a href={e.receipt} target="_blank" rel="noopener noreferrer" className="text-pink-600 dark:text-pink-400 hover:underline whitespace-nowrap">
                    receipt<ExtArrow />
                  </a>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1.5">
              Counted in the score above; each verifiable on the network that settled it.
            </p>
          </div>
        )}

        {/* The math — expandable, so the score is recomputable by hand, not just by the Verify button */}
        <div className="mb-5">
          <button
            onClick={() => setShowMath((s) => !s)}
            className="text-xs font-medium text-teal-600 dark:text-teal-400 hover:underline"
          >
            {showMath ? "Hide the math" : "Show the math — exactly how this score is computed"}
          </button>

          {showMath && <ScoreMath proof={proof} />}
        </div>

        {/* Verify */}
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
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
            view raw proof<ExtArrow />
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

// The recompute-it-yourself breakdown: the two components' raw math, the inputs
// (all derivable from public receipts), and the native settled receipts the
// score is actually built from. Pure + always-rendered, so it's render-testable.
export function ScoreMath({ proof }: { proof: ProofScore }) {
  const q = proof.components.quality;
  const pw = proof.components.provenWork;
  const qMax = Math.round(q.weight * proof.method.scale); // e.g. 600
  const pwMax = Math.round(pw.weight * proof.method.scale); // e.g. 400
  const native = (proof.evidence ?? []).filter((e) => e.network === "axon");
  const inputs = proof.inputs;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  // The two component points sum to a fractional total that the formula ROUNDS
  // to the final score — show that rounding step so the recompute reconciles
  // (594 + 383.6 = 977.6 → 978), never leaving a silent gap.
  const sum = Math.round((q.points + pw.points) * 100) / 100;
  const rounded = sum !== proof.score;

  return (
    <div className="mt-3 space-y-5 rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 p-4">
      {/* the computation */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">The computation</p>
        <div className="space-y-1.5 font-mono text-xs text-gray-600 dark:text-gray-300">
          <div className="flex items-center justify-between gap-2">
            <span>Quality<span className="text-gray-400"> · how well it works</span></span>
            <span className="tabular-nums whitespace-nowrap">{q.factor} × {qMax} = {q.points}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>Proven work<span className="text-gray-400"> · settled on-chain</span></span>
            <span className="tabular-nums whitespace-nowrap">{pw.factor} × {pwMax} = {pw.points}</span>
          </div>
          {rounded && (
            <div className="flex items-center justify-between gap-2 border-t border-gray-200 dark:border-gray-700 pt-1.5 text-gray-500 dark:text-gray-400">
              <span>Sum</span>
              <span className="tabular-nums">{sum}</span>
            </div>
          )}
          <div className={`flex items-center justify-between gap-2 font-semibold text-gray-900 dark:text-white ${rounded ? "" : "border-t border-gray-200 dark:border-gray-700 pt-1.5"}`}>
            <span>Proof Score{rounded ? " (rounded)" : ""}</span>
            <span className="tabular-nums">{proof.score}</span>
          </div>
        </div>
      </div>

      {/* the inputs — all derivable from public receipts */}
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">The inputs</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          <Fact k="Reputation" v={`${inputs.reputation} / 10`} />
          <Fact k="Settled value" v={`${inputs.settledUsdc} USDC`} />
          <Fact k="Tasks completed" v={String(inputs.tasksCompleted)} />
          <Fact k="Tasks failed" v={String(inputs.tasksFailed)} />
          <Fact k="Success rate" v={pct(inputs.successRate)} />
          <Fact k="Payment reliability" v={pct(inputs.paymentReliability)} />
          <Fact k="Avg response" v={`${inputs.avgResponseSec}s`} />
          <Fact k="Settled tasks" v={String(proof.evidenceCount)} />
        </dl>
      </div>

      {/* the receipts the score is actually built from */}
      {native.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
            The settled tasks behind it{proof.evidenceCount > native.length ? ` — ${native.length} of ${proof.evidenceCount}` : ""}
          </p>
          <ul className="space-y-1">
            {native.map((e) => (
              <li key={e.taskId} className="flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-300">
                <span className="tabular-nums text-gray-400 dark:text-gray-500">{new Date(e.completedAt).toISOString().slice(0, 10)}</span>
                <span className="flex-1 text-center tabular-nums">{e.settledUsdc} USDC</span>
                <a href={e.receipt} target="_blank" rel="noopener noreferrer" className="text-teal-600 dark:text-teal-400 hover:underline whitespace-nowrap">
                  receipt<ExtArrow />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-gray-400 dark:text-gray-500">
        Refetch each receipt to confirm it settled on-chain, apply the formula to the inputs, and you get {proof.score}. The full
        method (formula, weights, anchors) is in the raw proof below.
      </p>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-gray-400 dark:text-gray-500">{k}</dt>
      <dd className="font-mono text-gray-700 dark:text-gray-200 tabular-nums">{v}</dd>
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
