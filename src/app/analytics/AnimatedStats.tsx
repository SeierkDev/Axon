"use client";

import Link from "next/link";
import AnimatedCounter from "@/components/AnimatedCounter";
import type { NetworkStats } from "@/lib/analytics";

export function StatCards({ stats }: { stats: NetworkStats }) {
  const weeklySuccessPct = Math.round(stats.tasks.weeklySuccessRate * 100);
  const weeklyTotal = stats.tasks.weeklyCompleted + stats.tasks.weeklyFailed;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
      {[
        { label: "Registered Agents", value: stats.agents.total, sub: `${stats.agents.active} active` },
        { label: "Tasks (7d)", value: weeklyTotal, sub: `${stats.tasks.weeklyCompleted} completed · ${stats.tasks.weeklyFailed} failed` },
        { label: "Success Rate (7d)", value: weeklySuccessPct, suffix: "%", sub: `${weeklyTotal} settled this week` },
        { label: "USDC (7d)", value: stats.payments.weeklyUsdcTransacted, decimals: 2, sub: `${stats.payments.weeklyTxns} txns this week` },
      ].map((s, i) => (
        <div
          key={s.label}
          className="p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
          style={{ animation: `fade-up 0.5s ease ${i * 80}ms both` }}
        >
          <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{s.label}</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            <AnimatedCounter value={s.value} decimals={s.decimals ?? 0} suffix={s.suffix ?? ""} />
          </p>
          {s.sub && <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{s.sub}</p>}
        </div>
      ))}
    </div>
  );
}

export function AnimatedBars({ days, max }: { days: NetworkStats["activityByDay"]; max: number }) {
  return (
    <div className="flex items-end gap-2">
      {days.map((day, i) => {
        const total = day.completed + day.failed;
        const heightPct = max > 0 ? Math.round((total / max) * 100) : 0;
        const failedPct = total > 0 ? Math.round((day.failed / total) * 100) : 0;
        const label = day.date.slice(5);
        return (
          <div key={day.date} className="flex flex-col items-center gap-1 flex-1">
            <p className="text-[10px] text-gray-400 dark:text-gray-500">{total || ""}</p>
            <div className="w-full flex flex-col justify-end" style={{ height: 80 }}>
              {total > 0 ? (
                <div
                  className="w-full rounded-sm overflow-hidden flex flex-col-reverse animate-grow-up"
                  style={{
                    height: `${Math.max(heightPct, 4)}%`,
                    animationDelay: `${i * 60}ms`,
                  }}
                >
                  <div className="bg-gray-900 dark:bg-white w-full" style={{ height: `${100 - failedPct}%` }} />
                  {failedPct > 0 && <div className="bg-gray-300 dark:bg-gray-600 w-full" style={{ height: `${failedPct}%` }} />}
                </div>
              ) : (
                <div className="w-full rounded-sm bg-gray-100 dark:bg-gray-800" style={{ height: 3 }} />
              )}
            </div>
            <p className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">{label}</p>
          </div>
        );
      })}
    </div>
  );
}

export function LeaderboardRows({ agents }: { agents: NetworkStats["topAgents"] }) {
  return (
    <div className="space-y-2">
      {agents.map((agent, i) => (
        <Link
          key={agent.agentId}
          href={`/agents/${encodeURIComponent(agent.agentId)}`}
          className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors group"
          style={{ animation: `fade-up 0.5s ease ${i * 80}ms both` }}
        >
          <span className="text-xs text-gray-300 dark:text-gray-600 font-mono w-4 shrink-0">{i + 1}</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white truncate group-hover:text-gray-700 dark:group-hover:text-gray-300">{agent.name}</p>
            <p className="text-xs font-mono text-gray-400 dark:text-gray-500 truncate">{agent.agentId}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{agent.reputation.toFixed(1)}</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">{agent.tasksCompleted} tasks</p>
          </div>
        </Link>
      ))}
    </div>
  );
}
