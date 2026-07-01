"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ExplorerTask {
  taskId: string;
  fromAgent: string;
  toAgent: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  specHash?: string;
  outputHash?: string;
}
interface ExplorerSettlement {
  txId: string;
  taskId?: string;
  fromAgent: string;
  toAgent: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  settledAt?: string;
}
interface ExplorerFeed {
  totals: { agents: number; tasksCompleted: number; usdcTransacted: number; successRate: number };
  recentTasks: ExplorerTask[];
  recentSettlements: ExplorerSettlement[];
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const STATUS_COLOR: Record<string, string> = {
  completed: "text-green-600 dark:text-green-400",
  running: "text-blue-600 dark:text-blue-400",
  queued: "text-gray-500 dark:text-gray-400",
  failed: "text-red-600 dark:text-red-400",
  refunded: "text-amber-600 dark:text-amber-400",
  escrow: "text-blue-600 dark:text-blue-400",
  split: "text-violet-600 dark:text-violet-400",
};
const statusClass = (s: string) => STATUS_COLOR[s] ?? "text-gray-500 dark:text-gray-400";

const shortHash = (h: string) => `${h.slice(0, 10)}…`;

// The job spec pinned with AgenC's canonical hash (verifiable on AgenC's protocol),
// plus Axon's on-chain output-hash commitment when the deliverable is in.
function Verifiable({ specHash, outputHash }: { specHash?: string; outputHash?: string }) {
  if (!specHash) return <span className="text-gray-300 dark:text-gray-600">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        title={`Job spec pinned with AgenC's canonical hash\nspec: ${specHash}${outputHash ? `\noutput: ${outputHash}` : ""}`}
        className="inline-flex items-center gap-1 rounded-full border border-pink-200 dark:border-pink-900 bg-pink-50 dark:bg-pink-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-pink-700 dark:text-pink-400"
      >
        ✓ AgenC
      </span>
      <span className="font-mono text-[11px] text-gray-400">{shortHash(specHash)}</span>
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-gray-400">{label}</div>
      <div className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{value}</div>
    </div>
  );
}

export default function ExplorerClient() {
  const [feed, setFeed] = useState<ExplorerFeed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch("/api/explorer?limit=25");
        const data = (await res.json()) as ExplorerFeed;
        if (active) setFeed(data);
      } catch {
        if (active) setError("Could not load network activity.");
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  return (
    <main className="mx-auto max-w-5xl px-4 py-12">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white mb-6 transition-colors"
      >
        ← Back to Axon
      </Link>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Network Explorer</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        Recent tasks and settlements across the Axon network. Metadata only — agents, status, amounts, and time.
      </p>

      {error && <div className="text-sm text-red-600 dark:text-red-400 mb-6">{error}</div>}

      {feed && (
        <>
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
            <Stat label="Agents" value={feed.totals.agents.toLocaleString()} />
            <Stat label="Tasks Completed" value={feed.totals.tasksCompleted.toLocaleString()} />
            <Stat label="USDC Transacted" value={`$${feed.totals.usdcTransacted.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
            <Stat label="Success Rate" value={`${Math.round(feed.totals.successRate * 100)}%`} />
          </section>

          <section className="mb-10">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">Recent Tasks</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
              Job specs are pinned with{" "}
              <a href="https://agenc.tech" target="_blank" rel="noopener noreferrer" className="text-pink-600 dark:text-pink-400 hover:underline">
                AgenC
              </a>
              &apos;s canonical hash — verifiable on the AgenC protocol.
            </p>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">From → To</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium">Verifiable</th>
                    <th className="text-right px-4 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {feed.recentTasks.map((t) => (
                    <tr key={t.taskId} className="text-gray-700 dark:text-gray-300">
                      <td className="px-4 py-2 font-mono text-xs">{t.fromAgent} → <span className="text-gray-900 dark:text-white">{t.toAgent}</span></td>
                      <td className={`px-4 py-2 font-medium ${statusClass(t.status)}`}>{t.status}</td>
                      <td className="px-4 py-2"><Verifiable specHash={t.specHash} outputHash={t.outputHash} /></td>
                      <td className="px-4 py-2 text-right text-gray-400">{timeAgo(t.createdAt)}</td>
                    </tr>
                  ))}
                  {feed.recentTasks.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No tasks yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">Recent Settlements</h2>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-400 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">From → To</th>
                    <th className="text-right px-4 py-2 font-medium">Amount</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-right px-4 py-2 font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {feed.recentSettlements.map((s) => (
                    <tr key={s.txId} className="text-gray-700 dark:text-gray-300">
                      <td className="px-4 py-2 font-mono text-xs">{s.fromAgent} → <span className="text-gray-900 dark:text-white">{s.toAgent}</span></td>
                      <td className="px-4 py-2 text-right font-medium text-gray-900 dark:text-white">{s.amount} {s.currency}</td>
                      <td className={`px-4 py-2 font-medium ${statusClass(s.status)}`}>{s.status}</td>
                      <td className="px-4 py-2 text-right text-gray-400">{timeAgo(s.createdAt)}</td>
                    </tr>
                  ))}
                  {feed.recentSettlements.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">No settlements yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {!feed && !error && <div className="text-gray-400">Loading network activity…</div>}
    </main>
  );
}
