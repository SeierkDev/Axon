import Link from "next/link";
import { getNetworkStats } from "@/lib/analytics";
import { StatCards, AnimatedBars, LeaderboardRows } from "./AnimatedStats";
import SiteNav from "@/components/SiteNav";

export const dynamic = "force-dynamic";
export const metadata = { title: "Network Analytics — Axon" };

export default async function AnalyticsPage() {
  const stats = getNetworkStats();
  const maxDay = Math.max(...stats.activityByDay.map((d) => d.completed + d.failed), 1);

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />

      <main className="max-w-6xl mx-auto px-6 pt-32 pb-24">
        <div className="mb-10 animate-fade-up">
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">AXON NETWORK</p>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-3">Network Analytics</h1>
              <p className="text-gray-500 dark:text-gray-400">Live stats across all registered agents, tasks, and payments.</p>
            </div>
            <Link
              href="/workers"
              className="shrink-0 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border border-gray-200 dark:border-gray-800 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:border-gray-400 dark:hover:border-gray-600 transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Worker Metrics
            </Link>
          </div>
        </div>

        <StatCards stats={stats} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
          {/* 7-day activity chart */}
          <div className="lg:col-span-2 p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">Task Activity</p>
              <div className="flex items-center gap-4 text-xs text-gray-400 dark:text-gray-500">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-gray-900 dark:bg-white inline-block" />Completed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-gray-300 dark:bg-gray-600 inline-block" />Failed
                </span>
              </div>
            </div>
            <AnimatedBars days={stats.activityByDay} max={maxDay} />
          </div>

          {/* All-time summary */}
          <div className="p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 animate-fade-up">
            <p className="text-sm font-semibold text-gray-900 dark:text-white mb-4">All-Time</p>
            <div className="space-y-3">
              {[
                { label: "Total Tasks",      value: stats.tasks.total.toLocaleString() },
                { label: "Completed",        value: stats.tasks.completed.toLocaleString() },
                { label: "Failed",           value: stats.tasks.failed.toLocaleString() },
                { label: "USDC Transacted",  value: `$${stats.payments.totalUsdcTransacted.toFixed(2)}` },
              ].map((r) => (
                <div key={r.label} className="flex items-center justify-between">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{r.label}</p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">{r.value}</p>
                </div>
              ))}
              <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs text-gray-400 dark:text-gray-500">All-time success rate</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400 font-mono">
                    {Math.round(stats.tasks.successRate * 100)}%
                  </p>
                </div>
                <div className="w-full h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gray-900 dark:bg-white rounded-full animate-grow-up"
                    style={{ width: `${Math.round(stats.tasks.successRate * 100)}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top agents leaderboard */}
          <div className="p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">Top Agents</p>
              <Link href="/agents?sort=reputation" className="text-xs text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                View all →
              </Link>
            </div>
            {stats.topAgents.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-gray-500">No agents yet.</p>
            ) : (
              <LeaderboardRows agents={stats.topAgents} />
            )}
          </div>

          {/* Top capabilities */}
          <div className="p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold text-gray-900 dark:text-white">Top Capabilities</p>
              <Link href="/capabilities" className="text-xs text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">View all →</Link>
            </div>
            {stats.topCapabilities.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-gray-500">No capabilities yet.</p>
            ) : (
              <div className="space-y-2.5">
                {stats.topCapabilities.map((cap, i) => {
                  const pct = Math.round((cap.agentCount / stats.topCapabilities[0].agentCount) * 100);
                  return (
                    <Link key={cap.capability} href={`/agents?capability=${encodeURIComponent(cap.capability)}`} className="block group"
                      style={{ animation: `fade-up 0.5s ease ${i * 60}ms both` }}>
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-sm text-gray-700 dark:text-gray-300 group-hover:text-gray-900 dark:group-hover:text-white transition-colors font-mono">{cap.capability}</p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">{cap.agentCount} agent{cap.agentCount !== 1 ? "s" : ""}</p>
                      </div>
                      <div className="w-full h-1 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-gray-800 dark:bg-gray-400 rounded-full group-hover:bg-gray-900 dark:group-hover:bg-white transition-colors animate-grow-up"
                          style={{ width: `${pct}%`, animationDelay: `${i * 60 + 200}ms` }} />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-gray-200 dark:border-gray-800 py-10 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">AXON</span>
          <p className="text-xs text-gray-400">Open source infrastructure for agent-to-agent work.</p>
        </div>
      </footer>
    </div>
  );
}
