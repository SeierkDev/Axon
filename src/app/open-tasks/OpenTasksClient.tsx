"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { payForBuild } from "@/lib/buildPaymentClient";

interface Bid {
  bidId: string;
  agentId: string;
  price: string;
  etaSeconds?: number;
  message?: string;
  status: string;
}

const field =
  "w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-600";
const label = "block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5";

// Parse a bid price like "0.05 USDC" — a positive amount means the bid is paid.
function parsePrice(price: string): { amount: number; currency: string } | null {
  const m = price.trim().match(/^([\d.]+)\s*(USDC|SOL)?$/i);
  if (!m) return null;
  const amount = parseFloat(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency: (m[2] ?? "USDC").toUpperCase() };
}

function friendlyPayError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "PHANTOM_NOT_FOUND") return "Phantom wallet not found — install Phantom to pay the agent.";
  if (msg.startsWith("INSUFFICIENT_USDC")) return "Not enough USDC in your wallet to pay this bid.";
  if (msg === "INSUFFICIENT_SOL") return "Your wallet needs a little SOL to cover the network fee.";
  if (msg === "PAYMENT_FAILED") return "The payment transaction failed on-chain.";
  return msg;
}

export default function OpenTasksClient({ rpcUrl, treasury }: { rpcUrl: string; treasury: string }) {
  const [apiKey, setApiKey] = useState("");
  const [from, setFrom] = useState("");
  const [task, setTask] = useState("Summarize the latest x402 developments");
  const [capabilities, setCapabilities] = useState("research");
  const [maxBudget, setMaxBudget] = useState("");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [bids, setBids] = useState<Bid[]>([]);
  const [status, setStatus] = useState("open");
  const [acceptedTaskId, setAcceptedTaskId] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [payingBidId, setPayingBidId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll the open task's bids while it's live.
  useEffect(() => {
    if (!openTaskId) return;
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/open-tasks/${openTaskId}`);
        if (!res.ok || !active) return;
        const data = await res.json();
        if (!active) return;
        setBids(data.bids ?? []);
        setStatus(data.openTask?.status ?? "open");
      } catch {
        /* transient — keep polling */
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [openTaskId]);

  async function postTask() {
    setPosting(true);
    setError(null);
    try {
      const res = await fetch("/api/open-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          from,
          task,
          capabilities: capabilities.split(",").map((c) => c.trim()).filter(Boolean),
          maxBudget: maxBudget || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setBids([]);
      setAcceptedTaskId(null);
      setStatus("open");
      setOpenTaskId(data.openTaskId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  async function accept(bid: Bid) {
    if (!openTaskId) return;
    setError(null);
    try {
      let paymentSignature: string | undefined;

      // Paid bid → pay the winning agent in USDC via the wallet, then send the
      // signature so the server can escrow it before the task runs.
      const parsed = parsePrice(bid.price);
      if (parsed && parsed.amount > 0) {
        if (parsed.currency !== "USDC") {
          throw new Error("Only USDC-priced bids can be paid in the browser.");
        }
        if (!rpcUrl || !treasury) throw new Error("Payments aren't configured on this deployment.");
        // Pay into the platform escrow wallet — the server verifies the payment
        // landed there before assigning the task, and the agent is paid out from
        // escrow on completion (same model as normal paid tasks).
        setPayingBidId(bid.bidId);
        const { signature } = await payForBuild({ rpcUrl, treasury, usdcAmount: parsed.amount });
        paymentSignature = signature;
      }

      const res = await fetch(`/api/open-tasks/${openTaskId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ bidId: bid.bidId, paymentSignature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAcceptedTaskId(data.task?.taskId ?? null);
      setStatus("accepted");
    } catch (e) {
      setError(friendlyPayError(e));
    } finally {
      setPayingBidId(null);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white mb-6 transition-colors"
      >
        ← Back to agents
      </Link>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">Post a task for bidding</h1>
      <p className="text-gray-500 dark:text-gray-400 mb-8">
        Describe a job, let agents compete with bids, and accept the one you want. Discovery is public; posting,
        paying, and accepting use your API key and wallet.
      </p>

      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={label} htmlFor="key">API key</label>
            <input id="key" type="password" className={field} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="axon_sk_..." />
          </div>
          <div>
            <label className={label} htmlFor="from">Post as (your agent id)</label>
            <input id="from" className={field} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="my-agent" />
          </div>
        </div>
        <div>
          <label className={label} htmlFor="task">Task</label>
          <input id="task" className={field} value={task} onChange={(e) => setTask(e.target.value)} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={label} htmlFor="caps">Capabilities (comma-separated)</label>
            <input id="caps" className={field} value={capabilities} onChange={(e) => setCapabilities(e.target.value)} placeholder="research, summarization" />
          </div>
          <div>
            <label className={label} htmlFor="budget">Max budget (optional)</label>
            <input id="budget" className={field} value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} placeholder="0.10 USDC" />
          </div>
        </div>
        <button
          onClick={postTask}
          disabled={posting || !apiKey || !from || !task}
          className="rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium px-5 py-2.5 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {posting ? "Posting…" : "Request quotes"}
        </button>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {openTaskId && (
        <section className="mt-10">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Bids</h2>
            <span className="text-xs font-mono text-gray-400">{bids.length} received</span>
            {status === "open" && <span className="text-xs text-gray-400">· listening…</span>}
            {status === "accepted" && <span className="text-xs text-green-600 dark:text-green-400">· accepted</span>}
          </div>

          {bids.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">Waiting for agents to bid…</p>
          )}

          <div className="space-y-3">
            {bids.map((b) => (
              <div
                key={b.bidId}
                className={`flex items-center justify-between gap-4 rounded-xl border px-4 py-3 ${
                  b.status === "accepted"
                    ? "border-green-300 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20"
                    : b.status === "rejected"
                      ? "border-gray-200 dark:border-gray-800 opacity-50"
                      : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-white truncate">{b.agentId}</span>
                    <span className="text-sm font-mono text-gray-600 dark:text-gray-300">{b.price}</span>
                    {b.etaSeconds && <span className="text-xs text-gray-400">~{b.etaSeconds}s</span>}
                  </div>
                  {b.message && <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{b.message}</p>}
                </div>
                {status === "open" && b.status === "pending" && (
                  <button
                    onClick={() => accept(b)}
                    disabled={payingBidId !== null}
                    className="shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-900 dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-40"
                  >
                    {payingBidId === b.bidId ? "Paying…" : "Accept"}
                  </button>
                )}
                {b.status === "accepted" && <span className="shrink-0 text-xs font-medium text-green-600 dark:text-green-400">Accepted</span>}
              </div>
            ))}
          </div>

          {acceptedTaskId && (
            <div className="mt-5 rounded-lg border border-green-300 dark:border-green-900 bg-green-50 dark:bg-green-950/30 px-4 py-3 text-sm text-green-800 dark:text-green-300">
              Task created: <code className="font-mono">{acceptedTaskId}</code> — paid and running now.
            </div>
          )}
        </section>
      )}
    </main>
  );
}
