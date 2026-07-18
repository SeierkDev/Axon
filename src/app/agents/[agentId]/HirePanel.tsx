"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

// Close the loop: hire an agent right here. Free-lane agents run immediately —
// compose a task, send it anonymously, poll the result with the returned
// claimToken, and get the output plus a verifiable receipt. The hire settles
// into a real receipt that feeds the agent's Proof Score, so discovery →
// reputation → work → reputation comes full circle.
//
// Paid agents need an on-chain USDC payment (x402); in-browser payment is the
// next piece — for now they point at the API/MCP, which pay per task.

type Phase = "idle" | "hiring" | "running" | "done" | "error";

const MAX_POLLS = 45; // ~90s at 2s intervals
const POLL_MS = 2000;

export default function HirePanel({ agentId, agentName, isPaid, price }: { agentId: string; agentName: string; isPaid: boolean; price?: string | null }) {
  const [task, setTask] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  // Stop the poll loop if the user navigates away mid-hire — no setState on an
  // unmounted component, no orphaned timers.
  useEffect(() => () => { cancelled.current = true; }, []);

  async function poll(id: string, claimToken: string, attempt: number) {
    if (cancelled.current) return;
    if (attempt > MAX_POLLS) {
      setError("The agent is taking longer than expected — check the receipt shortly.");
      setPhase("error");
      return;
    }
    try {
      // Send the claimToken as a header, not in the URL — keeps this read
      // permission out of access logs and browser history.
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { headers: { "x-claim-token": claimToken } });
      const t = (await res.json()) as { status?: string; output?: string | null };
      if (cancelled.current) return;
      if (t.status === "completed") {
        setOutput(t.output ?? "");
        setPhase("done");
        return;
      }
      if (t.status === "failed") {
        setError("The agent couldn't complete this task. No charge — try rephrasing.");
        setPhase("error");
        return;
      }
    } catch {
      /* transient — keep polling */
    }
    setTimeout(() => poll(id, claimToken, attempt + 1), POLL_MS);
  }

  async function hire() {
    const t = task.trim();
    if (!t || phase === "hiring" || phase === "running") return;
    cancelled.current = false;
    setPhase("hiring");
    setError(null);
    setOutput(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "anonymous", to: agentId, task: t }),
      });
      const data = (await res.json()) as { taskId?: string; claimToken?: string; error?: string };
      if (!res.ok || !data.taskId || !data.claimToken) {
        setError(data.error ?? "Couldn't start the hire. Try again.");
        setPhase("error");
        return;
      }
      setTaskId(data.taskId);
      setPhase("running");
      poll(data.taskId, data.claimToken, 0);
    } catch {
      setError("Network error starting the hire. Try again.");
      setPhase("error");
    }
  }

  function reset() {
    cancelled.current = true;
    setPhase("idle");
    setOutput(null);
    setError(null);
    setTaskId(null);
    setTask("");
  }

  // ── Paid agents: point at the API/MCP until in-browser payment ships
  if (isPaid) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5 mb-10">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">Hire {agentName}</p>
          <span className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 rounded-md">{price} / task</span>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Paid agents settle with a single on-chain USDC payment (x402) — the payment is the authorization, no account
          needed. Hire via the <Link href="/docs/sdk" className="text-teal-600 dark:text-teal-400 hover:underline">API or MCP</Link> today; in-browser payment is next.
        </p>
      </div>
    );
  }

  // ── Free agents: full in-browser hire
  return (
    <div className="rounded-lg border border-teal-200 dark:border-teal-900/50 p-5 mb-10">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm font-semibold text-gray-900 dark:text-white">Hire {agentName}</p>
        <span className="text-xs font-medium text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900/50 px-2 py-0.5 rounded-full">Free lane</span>
      </div>

      {(phase === "idle" || phase === "hiring" || phase === "error") && (
        <>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={`Describe the task for ${agentName}…`}
            rows={3}
            disabled={phase === "hiring"}
            className="w-full rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:border-teal-400 disabled:opacity-60 resize-y"
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={hire}
              disabled={!task.trim() || phase === "hiring"}
              className="text-sm font-medium px-4 py-2 rounded-md bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white transition-colors"
            >
              {phase === "hiring" ? "Starting…" : "Hire"}
            </button>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">Runs immediately · leaves a verifiable receipt · 3 free hires</span>
          </div>
          {error && <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">{error}</p>}
        </>
      )}

      {phase === "running" && (
        <div className="flex items-center gap-2 py-2 text-sm text-gray-500 dark:text-gray-400">
          <span className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 animate-spin" />
          {agentName} is working on it…
        </div>
      )}

      {phase === "done" && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-400 mb-1.5">Result</p>
          <div className="rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/40 p-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words max-h-80 overflow-auto">
            {output || <span className="text-gray-400">(empty response)</span>}
          </div>
          <div className="mt-3 flex items-center gap-4">
            {taskId && (
              <a href={`/r/${encodeURIComponent(taskId)}`} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 dark:text-teal-400 hover:underline">
                View the receipt →
              </a>
            )}
            <button onClick={reset} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
              Hire again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
