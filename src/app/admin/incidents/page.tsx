import { getDb } from "@/lib/db";
import SiteNav from "@/components/SiteNav";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Incident Timeline — Axon Admin" };

type Incident =
  | { kind: "task_failed"; ts: string; taskId: string; fromAgent: string; toAgent: string; error: string | null }
  | { kind: "refund"; ts: string; txId: string; taskId: string | null; fromAgent: string; toAgent: string; amount: number; currency: string };

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" }) + " UTC";
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function getIncidents(): Incident[] {
  const db = getDb();

  const failedTasks = db.prepare(`
    SELECT task_id, from_agent, to_agent, error, completed_at
    FROM tasks
    WHERE status = 'failed' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 200
  `).all() as { task_id: string; from_agent: string; to_agent: string; error: string | null; completed_at: string }[];

  const refunds = db.prepare(`
    SELECT tx_id, task_id, from_agent, to_agent, amount_sol, currency, settled_at
    FROM transactions
    WHERE status = 'refunded' AND settled_at IS NOT NULL
    ORDER BY settled_at DESC
    LIMIT 200
  `).all() as { tx_id: string; task_id: string | null; from_agent: string; to_agent: string; amount_sol: number; currency: string; settled_at: string }[];

  const incidents: Incident[] = [
    ...failedTasks.map((t): Incident => ({
      kind: "task_failed",
      ts: t.completed_at,
      taskId: t.task_id,
      fromAgent: t.from_agent,
      toAgent: t.to_agent,
      error: t.error,
    })),
    ...refunds.map((r): Incident => ({
      kind: "refund",
      ts: r.settled_at,
      txId: r.tx_id,
      taskId: r.task_id,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      amount: r.amount_sol,
      currency: r.currency,
    })),
  ];

  return incidents.sort((a, b) => b.ts.localeCompare(a.ts));
}

function getStats() {
  const db = getDb();
  const cutoff7d = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const { failed7d } = db.prepare(`SELECT COUNT(*) AS failed7d FROM tasks WHERE status = 'failed' AND completed_at >= ?`).get(cutoff7d) as { failed7d: number };
  const { refunds7d } = db.prepare(`SELECT COUNT(*) AS refunds7d FROM transactions WHERE status = 'refunded' AND settled_at >= ?`).get(cutoff7d) as { refunds7d: number };
  const { totalFailed } = db.prepare(`SELECT COUNT(*) AS totalFailed FROM tasks WHERE status = 'failed'`).get() as { totalFailed: number };
  const { totalRefunds } = db.prepare(`SELECT COUNT(*) AS totalRefunds FROM transactions WHERE status = 'refunded'`).get() as { totalRefunds: number };
  return { failed7d, refunds7d, totalFailed, totalRefunds };
}

export default async function IncidentsPage({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const params = await searchParams;
  const secret = process.env.CRON_SECRET?.trim();
  const authorized = secret && params.key === secret;

  if (!authorized) {
    return (
      <div className="bg-white min-h-screen text-[#0a0a0a]">
        <SiteNav />
        <main className="max-w-2xl mx-auto px-6 pt-32 pb-24 text-center">
          <p className="text-sm text-gray-400">Unauthorized.</p>
        </main>
      </div>
    );
  }

  const incidents = getIncidents();
  const stats = getStats();

  return (
    <div className="bg-white min-h-screen text-[#0a0a0a]">
      <SiteNav />
      <main className="max-w-4xl mx-auto px-6 pt-32 pb-24">

        {/* Header */}
        <div className="mb-8 animate-fade-up">
          <p className="text-xs font-mono text-gray-400 tracking-wider mb-2">AXON ADMIN</p>
          <h1 className="text-3xl font-bold text-gray-900">Incident Timeline</h1>
          <p className="text-sm text-gray-500 mt-1">Failed tasks and refunds across the network, newest first.</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8 animate-fade-up" style={{ animationDelay: "60ms" }}>
          {[
            { label: "Failed (7d)", value: stats.failed7d, color: "text-red-600" },
            { label: "Refunds (7d)", value: stats.refunds7d, color: "text-amber-600" },
            { label: "Failed (all-time)", value: stats.totalFailed, color: "text-gray-900" },
            { label: "Refunds (all-time)", value: stats.totalRefunds, color: "text-gray-900" },
          ].map((s) => (
            <div key={s.label} className="p-5 rounded-xl border border-gray-200 bg-white">
              <p className="text-xs text-gray-400 mb-1">{s.label}</p>
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Timeline */}
        {incidents.length === 0 ? (
          <div className="text-center py-16 text-gray-400 text-sm animate-fade-up" style={{ animationDelay: "120ms" }}>
            No incidents recorded. All tasks are completing successfully.
          </div>
        ) : (
          <div className="flex flex-col gap-3 animate-fade-up" style={{ animationDelay: "120ms" }}>
            {incidents.map((inc) =>
              inc.kind === "task_failed" ? (
                <div key={inc.taskId} className="rounded-xl border border-red-100 bg-red-50/40 p-5">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                    <span className="text-xs font-semibold text-red-600 uppercase tracking-wide">Task Failed</span>
                    <span className="ml-auto text-xs text-gray-400">{timeSince(inc.ts)}</span>
                  </div>
                  <p className="text-sm font-medium text-gray-900 mb-1">
                    <span className="text-gray-500">to</span> {inc.toAgent}
                    <span className="text-gray-400 mx-1">·</span>
                    <span className="text-gray-500">from</span> {inc.fromAgent}
                  </p>
                  {inc.error && (
                    <p className="text-sm text-red-700 mt-1">{inc.error}</p>
                  )}
                  <p className="text-xs text-gray-400 mt-2">{formatTime(inc.ts)}</p>
                  <p className="text-xs text-gray-300 mt-0.5 font-mono">{inc.taskId}</p>
                </div>
              ) : (
                <div key={inc.txId} className="rounded-xl border border-amber-100 bg-amber-50/40 p-5">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                    <span className="text-xs font-semibold text-amber-600 uppercase tracking-wide">Refund</span>
                    <span className="ml-auto text-xs text-gray-400">{timeSince(inc.ts)}</span>
                  </div>
                  <p className="text-sm font-medium text-gray-900 mb-1">
                    <span className="text-gray-500">to</span> {inc.fromAgent}
                    <span className="text-gray-400 mx-2">·</span>
                    <span className="font-semibold">{inc.amount.toFixed(2)} {inc.currency}</span>
                  </p>
                  {inc.taskId && (
                    <p className="text-xs text-gray-400 mt-1">Task: <span className="font-mono">{inc.taskId}</span></p>
                  )}
                  <p className="text-xs text-gray-400 mt-2">{formatTime(inc.ts)}</p>
                  <p className="text-xs text-gray-300 mt-0.5 font-mono">{inc.txId}</p>
                </div>
              )
            )}
          </div>
        )}
      </main>
    </div>
  );
}
