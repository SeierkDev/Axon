"use client";

import { useEffect, useState, useCallback } from "react";
import SiteNav from "@/components/SiteNav";

type ByHour = { hour: string; completed: number; failed: number };
type PerAgent = {
  agentId: string; name: string | null; queued: number; running: number;
  completedTotal: number; failedTotal: number; completedToday: number; avgProcessingMs: number | null;
};
type RecentTask = {
  task_id: string; to_agent: string; status: string;
  created_at: string; started_at: string | null; completed_at: string | null;
  processingMs: number | null; pickupMs: number | null;
};
type Metrics = {
  worker: { queueDepth: number; running: number; lastSeenMs: number | null };
  throughput: { today: number; last24h: number; byHour: ByHour[] };
  latency: { p50ProcessingMs: number; p95ProcessingMs: number; p50PickupMs: number };
  perAgent: PerAgent[];
  recentTasks: RecentTask[];
  updatedAt: string;
};

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms === 0) return "<1ms";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtSecsAgo(s: number): string {
  const abs = Math.max(0, s);
  if (abs < 60) return `${abs}s ago`;
  const m = Math.floor(abs / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function fmtHour(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:00`;
}

function workerStatus(lastSeenMs: number | null, queueDepth: number, running: number) {
  if (running > 0 || queueDepth > 0) return { label: "Active", color: "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900" };
  if (lastSeenMs === null || lastSeenMs > 6 * 3_600_000) return { label: "Offline", color: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900" };
  if (lastSeenMs > 2 * 3_600_000) return { label: "Idle", color: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900" };
  return { label: "Online", color: "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900" };
}

const STATUS_COLOR: Record<string, string> = {
  completed: "text-green-600 dark:text-green-400",
  failed:    "text-red-500 dark:text-red-400",
  running:   "text-blue-500 dark:text-blue-400",
  queued:    "text-gray-400 dark:text-gray-500",
};

export default function WorkersDashboard() {
  const [data, setData] = useState<Metrics | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [error, setError] = useState(false);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/worker-metrics");
      if (!res.ok) throw new Error();
      setData(await res.json());
      setFetchedAt(Date.now());
      setSecondsAgo(0);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    fetchMetrics();
    const poll = setInterval(fetchMetrics, 15_000);
    return () => clearInterval(poll);
  }, [fetchMetrics]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    const tick = setInterval(() => setSecondsAgo((s) => s + 1), 1000);
    return () => clearInterval(tick);
  }, []);

  const maxBar = data ? Math.max(...data.throughput.byHour.map((h) => h.completed + h.failed), 1) : 1;
  const lastSeenSecs = data?.worker.lastSeenMs != null ? Math.floor(data.worker.lastSeenMs / 1000) + secondsAgo : null;
  const lastSeenText = lastSeenSecs != null ? `last seen ${fmtSecsAgo(lastSeenSecs)}` : "never seen";

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-6xl mx-auto px-6 pt-32 pb-24">

        {/* Header */}
        <div className="flex items-start justify-between flex-wrap gap-4 mb-8 animate-fade-up">
          <div>
            <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-2">AXON NETWORK</p>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Worker Metrics</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Real-time queue depth, throughput, and processing latency across all agents.</p>
          </div>
          <div className="flex items-center gap-2 mt-1">
            {error ? (
              <span className="text-xs text-red-500 dark:text-red-400 border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 rounded-full px-3 py-1">Connection error</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-full px-3 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                Live · {secondsAgo}s ago
              </span>
            )}
          </div>
        </div>

        {!data ? (
          <div className="text-sm text-gray-400 py-20 text-center">Loading metrics…</div>
        ) : (
          <>
            {/* Status cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 animate-fade-up" style={{ animationDelay: "60ms" }}>
              {(() => {
                const ws = workerStatus(data.worker.lastSeenMs, data.worker.queueDepth, data.worker.running);
                return [
                  { label: "Queue Depth", value: String(data.worker.queueDepth), sub: "tasks waiting" },
                  { label: "Running", value: String(data.worker.running), sub: "processing now" },
                  { label: "Today", value: String(data.throughput.today), sub: "tasks completed" },
                  { label: "Worker", value: ws.label, sub: lastSeenText, valueClass: ws.color },
                ];
              })().map((c) => (
                <div key={c.label} className="p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
                  <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{c.label}</p>
                  <p className={`text-2xl font-bold ${"valueClass" in c && c.valueClass ? "" : "text-gray-900 dark:text-white"}`}>
                    {"valueClass" in c && c.valueClass
                      ? <span className={`text-sm font-semibold px-2 py-0.5 rounded-full border ${c.valueClass}`}>{c.value}</span>
                      : c.value}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{c.sub}</p>
                </div>
              ))}
            </div>

            {/* Latency cards */}
            <div className="grid grid-cols-3 gap-4 mb-6 animate-fade-up" style={{ animationDelay: "120ms" }}>
              {[
                { label: "P50 Processing", value: fmtMs(data.latency.p50ProcessingMs), sub: "median task duration" },
                { label: "P95 Processing", value: fmtMs(data.latency.p95ProcessingMs), sub: "95th percentile duration" },
                { label: "P50 Pickup", value: fmtMs(data.latency.p50PickupMs), sub: "median time to start after queued" },
              ].map((c) => (
                <div key={c.label} className="p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
                  <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{c.label}</p>
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{c.value}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{c.sub}</p>
                </div>
              ))}
            </div>

            {/* Throughput chart — last 12 hours */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 mb-6 animate-fade-up" style={{ animationDelay: "180ms" }}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Throughput — last 12 hours</h2>
                <span className="text-xs text-gray-400 dark:text-gray-500">{data.throughput.last24h} tasks / 24h</span>
              </div>
              {(() => {
                const renderBars = (hours: typeof data.throughput.byHour, barH: number) =>
                  hours.map((h) => {
                    const total = h.completed + h.failed;
                    const pct = Math.round((total / maxBar) * 100);
                    const failPct = total > 0 ? Math.round((h.failed / total) * 100) : 0;
                    return (
                      <div key={h.hour} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                        <div className="w-full flex flex-col justify-end" style={{ height: `${barH}px` }}>
                          <div className="w-full rounded-sm overflow-hidden" style={{ height: `${Math.max(pct, total > 0 ? 4 : 0)}%` }}>
                            <div className="w-full bg-red-400" style={{ height: `${failPct}%` }} />
                            <div className="w-full bg-gray-900 dark:bg-gray-500" style={{ height: `${100 - failPct}%` }} />
                          </div>
                        </div>
                        <span className="text-[9px] text-gray-400 dark:text-gray-500">{fmtHour(h.hour)}</span>
                        {total > 0 && (
                          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-gray-900 dark:bg-gray-700 text-white text-[10px] rounded px-1.5 py-0.5 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                            {h.completed} ok · {h.failed} failed
                          </div>
                        )}
                      </div>
                    );
                  });
                return (
                  <>
                    {/* Mobile: last 6 hours, taller bars */}
                    <div className="flex sm:hidden items-end gap-1 overflow-x-hidden">
                      {renderBars(data.throughput.byHour.slice(-6), 96)}
                    </div>
                    {/* Desktop: all 12 hours */}
                    <div className="hidden sm:flex items-end gap-1 overflow-x-hidden">
                      {renderBars(data.throughput.byHour, 72)}
                    </div>
                  </>
                );
              })()}
              <div className="flex items-center gap-4 mt-3">
                <span className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500"><span className="w-2 h-2 rounded-sm bg-gray-900 dark:bg-white inline-block" />Completed</span>
                <span className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500"><span className="w-2 h-2 rounded-sm bg-red-400 inline-block" />Failed</span>
              </div>
            </div>

            {/* Per-agent table */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 mb-6 overflow-hidden animate-fade-up" style={{ animationDelay: "240ms" }}>
              <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Per-agent breakdown</h2>
                <span className="text-xs text-gray-400 dark:text-gray-500 md:hidden">scroll →</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
                      <th className="text-left px-6 py-3 font-medium">Agent</th>
                      <th className="text-right px-4 py-3 font-medium">Queue</th>
                      <th className="text-right px-4 py-3 font-medium">Running</th>
                      <th className="text-right px-4 py-3 font-medium">Today</th>
                      <th className="text-right px-4 py-3 font-medium">All-time</th>
                      <th className="text-right px-4 py-3 font-medium">Error rate</th>
                      <th className="text-right px-6 py-3 font-medium">Avg latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perAgent.map((a, i) => {
                      const settled = a.completedTotal + a.failedTotal;
                      const errPct = settled > 0 ? ((a.failedTotal / settled) * 100).toFixed(1) : "0.0";
                      return (
                        <tr key={a.agentId} className={`border-b border-gray-50 dark:border-gray-800 last:border-0 ${i % 2 === 0 ? "" : "bg-gray-50/50 dark:bg-gray-800/30"}`}>
                          <td className="px-6 py-3 font-medium text-gray-900 dark:text-white">{a.name ?? a.agentId}</td>
                          <td className="px-4 py-3 text-right text-gray-500 dark:text-gray-400">{a.queued}</td>
                          <td className="px-4 py-3 text-right text-gray-500 dark:text-gray-400">{a.running}</td>
                          <td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300 font-medium">{a.completedToday}</td>
                          <td className="px-4 py-3 text-right text-gray-500 dark:text-gray-400">{a.completedTotal}</td>
                          <td className={`px-4 py-3 text-right font-medium ${parseFloat(errPct) > 5 ? "text-red-500" : "text-gray-500 dark:text-gray-400"}`}>
                            {errPct}%
                          </td>
                          <td className="px-6 py-3 text-right text-gray-500 dark:text-gray-400">{fmtMs(a.avgProcessingMs)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recent tasks */}
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden animate-fade-up" style={{ animationDelay: "300ms" }}>
              <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Recent tasks</h2>
                <span className="text-xs text-gray-400 dark:text-gray-500">last 20</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-400 dark:text-gray-500 border-b border-gray-100 dark:border-gray-800">
                      <th className="text-left px-6 py-3 font-medium">Agent</th>
                      <th className="text-left px-4 py-3 font-medium">Status</th>
                      <th className="text-right px-4 py-3 font-medium">Processing</th>
                      <th className="text-right px-4 py-3 font-medium">Pickup</th>
                      <th className="text-right px-6 py-3 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentTasks.map((t, i) => (
                      <tr key={t.task_id} className={`border-b border-gray-50 dark:border-gray-800 last:border-0 ${i % 2 === 0 ? "" : "bg-gray-50/50 dark:bg-gray-800/30"}`}>
                        <td className="px-6 py-2.5 font-medium text-gray-800 dark:text-gray-200">{t.to_agent}</td>
                        <td className={`px-4 py-2.5 font-medium text-xs ${STATUS_COLOR[t.status] ?? "text-gray-400 dark:text-gray-500"}`}>
                          {t.status}
                        </td>
                        <td className="px-4 py-2.5 text-right text-gray-500 dark:text-gray-400 text-xs">{fmtMs(t.processingMs)}</td>
                        <td className="px-4 py-2.5 text-right text-gray-500 dark:text-gray-400 text-xs">{fmtMs(t.pickupMs)}</td>
                        <td className="px-6 py-2.5 text-right text-gray-400 dark:text-gray-500 text-xs">{fetchedAt ? fmtSecsAgo(Math.floor((fetchedAt - new Date(t.created_at).getTime()) / 1000) + secondsAgo) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
