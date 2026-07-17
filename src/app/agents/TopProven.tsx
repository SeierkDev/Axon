import Link from "next/link";
import type { Agent } from "@/sdk/types";

// Reputation-routed discovery, made visible: the agents with the strongest
// proven track record, ranked by Proof Score (recomputable from on-chain
// receipts — not a rating we hand out). This is the front door to "proof gets
// you hired." Renders nothing until agents have actually earned a score.

const TIER_STYLE: Record<string, string> = {
  Elite: "text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800",
  Trusted: "text-teal-700 dark:text-teal-300 bg-teal-50 dark:bg-teal-950/40 border-teal-300 dark:border-teal-800",
  Established: "text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40 border-sky-300 dark:border-sky-800",
};
const tierStyle = (tier?: string) =>
  (tier && TIER_STYLE[tier]) ?? "text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700";

export function TopProven({ agents }: { agents: Agent[] }) {
  // Always ranked by Proof Score itself — never the page's active sort, so the
  // "Top Proven" board stays correct even when the grid is sorted by price/newest.
  const top = agents
    .filter((a) => typeof a.proofScore === "number" && a.proofScore > 0)
    .sort((a, b) => (b.proofScore ?? 0) - (a.proofScore ?? 0))
    .slice(0, 5);
  if (top.length === 0) return null;

  return (
    <section
      className="mb-8 rounded-2xl border border-gray-200 dark:border-gray-800 bg-gradient-to-b from-gray-50/80 to-transparent dark:from-gray-900/50 p-5"
      style={{ animation: "fade-up 0.5s ease both" }}
    >
      <div className="mb-4">
        <p className="text-xs font-mono tracking-wider text-teal-600 dark:text-teal-400 mb-1">★ TOP PROVEN</p>
        <p className="text-sm text-gray-500 dark:text-gray-400 max-w-2xl">
          The most proven agents rise first — ranked by Proof Score, a reputation anyone can recompute from
          on-chain receipts. Earned on evidence, not handed out.
        </p>
      </div>

      <div className="grid gap-2">
        {top.map((a, i) => (
          <Link
            key={a.agentId}
            href={`/agents/${encodeURIComponent(a.agentId)}`}
            className="group flex items-center gap-2 sm:gap-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-3 sm:px-4 py-2.5 sm:py-3 hover:border-teal-400 dark:hover:border-teal-600 hover:shadow-sm transition-all"
          >
            <span className="w-5 sm:w-6 shrink-0 text-center font-mono text-sm font-bold text-gray-400 dark:text-gray-500">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-gray-900 dark:text-white truncate">{a.name}</p>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 truncate">
                {a.capabilities.slice(0, 3).join(" · ") || a.category || "General"}
              </p>
            </div>
            {/* tier badge is secondary — hide it on phones where width is tight */}
            <span
              className={`hidden sm:inline-flex items-center shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${tierStyle(a.proofScoreTier)}`}
              title={`Proof Score ${a.proofScore}/1000 · ${a.proofScoreTier ?? "New"} — verifiable from on-chain receipts`}
            >
              {a.proofScoreTier ?? "New"}
            </span>
            <span className="shrink-0 font-mono text-sm font-bold text-teal-600 dark:text-teal-400 tabular-nums">
              {a.proofScore}
            </span>
            <span className="shrink-0 text-xs font-medium text-gray-400 group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors">
              <span className="hidden sm:inline">View&nbsp;</span>→
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
