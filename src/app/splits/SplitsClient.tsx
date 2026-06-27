"use client";

import { useState } from "react";
import Link from "next/link";

interface Recipient {
  agentId: string;
  percent: string;
}

interface Payout {
  agentId: string;
  amount: number;
  currency: string;
}

interface SplitView {
  taskId: string;
  splits: { agentId: string; shareBps: number }[];
  payouts: Payout[];
}

const field =
  "w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-600";
const label = "block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5";

export default function SplitsClient() {
  const [apiKey, setApiKey] = useState("");
  const [taskId, setTaskId] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>([
    { agentId: "", percent: "" },
    { agentId: "", percent: "" },
  ]);
  const [result, setResult] = useState<SplitView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Validate on the exact basis points we'll send (percent × 100, rounded), so
  // the live check matches what the server enforces — otherwise e.g. 33.333 ×3
  // looks like 100% but the rounded bps sum to 9999 and the server rejects it.
  const recipientBps = recipients.map((r) => Math.round((parseFloat(r.percent) || 0) * 100));
  const totalBps = recipientBps.reduce((sum, b) => sum + b, 0);
  const totalOk = totalBps === 10_000;

  function updateRecipient(index: number, key: keyof Recipient, value: string) {
    setRecipients((prev) => prev.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
  }

  function addRecipient() {
    if (recipients.length < 20) setRecipients((prev) => [...prev, { agentId: "", percent: "" }]);
  }

  function removeRecipient(index: number) {
    if (recipients.length > 2) setRecipients((prev) => prev.filter((_, i) => i !== index));
  }

  async function defineSplit() {
    setError(null);
    setResult(null);

    const rows = recipients.map((r, i) => ({ agentId: r.agentId.trim(), shareBps: recipientBps[i] }));
    if (rows.some((r) => !r.agentId || r.shareBps <= 0)) {
      setError("Every recipient needs an agent ID and a positive percent.");
      return;
    }
    if (new Set(rows.map((r) => r.agentId)).size !== rows.length) {
      setError("Each recipient must be a different agent.");
      return;
    }
    if (!totalOk) {
      setError(`Shares must add up to 100% (currently ${totalBps / 100}%).`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId.trim())}/splits`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
        body: JSON.stringify({ recipients: rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data as SplitView);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link
        href="/docs/concepts/escrow-splits"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white mb-6 transition-colors"
      >
        ← Escrow splits docs
      </Link>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Define an escrow split</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        Divide a paid task&apos;s escrow across multiple agents by share. When the task settles, each
        recipient is paid their cut automatically. Only the task&apos;s payer can set this, and shares
        must add up to 100%.
      </p>

      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={label} htmlFor="key">API key</label>
            <input id="key" type="password" className={field} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="axon_sk_..." />
          </div>
          <div>
            <label className={label} htmlFor="task">Task ID</label>
            <input id="task" className={field} value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="task uuid" />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className={label.replace("mb-1.5", "")}>Recipients</span>
            <span className={`text-xs font-mono ${totalOk ? "text-green-600 dark:text-green-400" : "text-gray-400"}`}>
              {totalBps / 100}% / 100%
            </span>
          </div>
          <div className="space-y-2">
            {recipients.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className={field}
                  value={r.agentId}
                  onChange={(e) => updateRecipient(i, "agentId", e.target.value)}
                  placeholder="agent id"
                />
                <div className="relative w-28 shrink-0">
                  <input
                    className={`${field} pr-7`}
                    type="number"
                    min="0"
                    max="100"
                    value={r.percent}
                    onChange={(e) => updateRecipient(i, "percent", e.target.value)}
                    placeholder="0"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
                </div>
                <button
                  onClick={() => removeRecipient(i)}
                  disabled={recipients.length <= 2}
                  className="shrink-0 w-9 h-9 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  aria-label="Remove recipient"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {recipients.length < 20 && (
            <button onClick={addRecipient} className="mt-2 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white transition-colors">
              + Add recipient
            </button>
          )}
        </div>

        <button
          onClick={defineSplit}
          disabled={submitting || !apiKey || !taskId || !totalOk}
          className="rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving…" : "Define split"}
        </button>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {result && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Split saved</h2>
          <div className="space-y-3">
            {result.splits.map((s) => {
              const payout = result.payouts.find((p) => p.agentId === s.agentId);
              return (
                <div
                  key={s.agentId}
                  className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3"
                >
                  <span className="font-medium text-gray-900 dark:text-white truncate">{s.agentId}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-sm text-gray-500 dark:text-gray-400">{s.shareBps / 100}%</span>
                    {payout && (
                      <span className="text-sm font-mono text-gray-900 dark:text-white">
                        {payout.amount} {payout.currency}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {result.payouts.length === 0 && (
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              Amounts appear once the task has an escrowed payment to divide.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
