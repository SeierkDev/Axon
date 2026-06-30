"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ComponentStatus = "operational" | "degraded" | "down";
interface StatusComponent { name: string; status: ComponentStatus; detail?: string }
interface SystemStatus {
  status: ComponentStatus;
  components: StatusComponent[];
  metrics: { queueDepth: number; runningTasks: number; tasksCompleted: number; successRate: number; workerLastSeenAgeSeconds: number | null };
  updatedAt: string;
}

const DOT: Record<ComponentStatus, string> = {
  operational: "bg-green-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
};
const LABEL: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
};
const BANNER: Record<ComponentStatus, string> = {
  operational: "border-green-300 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300",
  degraded: "border-amber-300 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300",
  down: "border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300",
};
const HEADLINE: Record<ComponentStatus, string> = {
  operational: "All systems operational",
  degraded: "Some systems degraded",
  down: "Major outage",
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-gray-400">{label}</div>
      <div className="text-xl font-bold text-gray-900 dark:text-white mt-1">{value}</div>
    </div>
  );
}

export default function StatusClient() {
  const [s, setS] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch("/api/status");
        const data = (await res.json()) as SystemStatus;
        if (active) setS(data);
      } catch {
        if (active) setError("Could not load status.");
      }
    }
    load();
    const t = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white mb-6 transition-colors"
      >
        ← Back to Axon
      </Link>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-6">Status</h1>

      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}

      {s && (
        <>
          <div className={`rounded-xl border px-5 py-4 mb-8 font-semibold ${BANNER[s.status]}`}>
            {HEADLINE[s.status]}
          </div>

          <section className="rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800 mb-10">
            {s.components.map((c) => (
              <div key={c.name} className="flex items-center justify-between gap-4 px-5 py-3.5">
                <div>
                  <div className="font-medium text-gray-900 dark:text-white">{c.name}</div>
                  {c.detail && <div className="text-xs text-gray-400 mt-0.5">{c.detail}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[c.status]}`} />
                  <span className="text-sm text-gray-600 dark:text-gray-300">{LABEL[c.status]}</span>
                </div>
              </div>
            ))}
          </section>

          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">Live metrics</h2>
          <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Metric label="Queue Depth" value={s.metrics.queueDepth.toLocaleString()} />
            <Metric label="Running" value={s.metrics.runningTasks.toLocaleString()} />
            <Metric label="Completed" value={s.metrics.tasksCompleted.toLocaleString()} />
            <Metric label="Success Rate" value={`${Math.round(s.metrics.successRate * 100)}%`} />
          </section>

          <p className="text-xs text-gray-400 mt-8">
            Updated {new Date(s.updatedAt).toLocaleTimeString()} · refreshes every 10s
          </p>
        </>
      )}

      {!s && !error && <div className="text-gray-400">Loading status…</div>}
    </main>
  );
}
