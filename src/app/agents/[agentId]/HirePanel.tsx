"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { payForBuild } from "@/lib/buildPaymentClient";

// Close the loop: hire an agent right here. Free-lane agents run immediately;
// paid agents settle a single on-chain USDC payment (x402) first — pay with
// Phantom, then the same anonymous hire runs. Either way we poll the result with
// the returned claimToken and the hire settles into a real receipt that feeds
// the agent's Proof Score, so discovery → reputation → work → reputation comes
// full circle.
//
// In-browser payment covers USDC-priced agents. A SOL price (or missing wallet
// config) falls back to the API/MCP, which pay per task.

type Phase = "idle" | "hiring" | "running" | "done" | "error";

const MAX_POLLS = 45; // ~90s at 2s intervals
const POLL_MS = 2000;

// Parse a USDC price like "0.25 USDC" → 0.25. null for SOL/unparseable prices.
function parseUsdc(price?: string | null): number | null {
  const m = (price ?? "").trim().match(/^(\d+(?:\.\d{1,6})?)\s*USDC$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Turn a payForBuild error code into something a hirer can act on.
function payErrorMessage(msg: string, usdcAmount: number): string {
  if (msg === "PHANTOM_NOT_FOUND") return "No Solana wallet found. Install Phantom to pay and hire in-browser.";
  if (msg.startsWith("INSUFFICIENT_USDC")) {
    const have = msg.split(":")[1];
    return `Not enough USDC — this costs ${usdcAmount} USDC, but your wallet only has ${have ?? "0"}. Add USDC and try again.`;
  }
  if (msg === "INSUFFICIENT_SOL") return "Your wallet needs a little SOL to cover the Solana network fee. Add some and try again.";
  if (msg === "PAYMENT_FAILED") return "The payment didn't go through — you weren't charged. Try again.";
  if (/reject|declin|cancel/i.test(msg)) return "Payment cancelled.";
  return "Couldn't complete the payment. Try again.";
}

export default function HirePanel({
  agentId,
  agentName,
  isPaid,
  price,
  receiver,
  rpcUrl,
}: {
  agentId: string;
  agentName: string;
  isPaid: boolean;
  price?: string | null;
  receiver?: string;
  rpcUrl?: string;
}) {
  const [task, setTask] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [hint, setHint] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  // A payment that already landed on-chain — kept so a failed submit retries with
  // the SAME signature instead of charging the wallet a second time.
  const paid = useRef<{ paymentSignature: string; payerWallet: string } | null>(null);

  // Stop the poll loop if the user navigates away mid-hire — no setState on an
  // unmounted component, no orphaned timers.
  useEffect(() => () => { cancelled.current = true; }, []);

  const usdcAmount = parseUsdc(price);
  // In-browser payment needs a USDC price AND the receiver + RPC config. Anything
  // else (SOL price, unset env) keeps the API/MCP fallback.
  const canPayInBrowser = isPaid && usdcAmount !== null && Boolean(receiver) && Boolean(rpcUrl);

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
      if (cancelled.current) return;
      // A bad token (403) is terminal — it will never read this task, so don't
      // poll to the timeout pretending it's just slow. A 404 is NOT terminal: on
      // a horizontally-scaled deploy the read can hit an instance whose replica
      // hasn't synced the just-created task yet, so keep polling through it.
      if (res.status === 403) {
        setError("Couldn't read this hire's result — check the receipt shortly.");
        setPhase("error");
        return;
      }
      const t = (await res.json()) as { status?: string; output?: string | null };
      if (cancelled.current) return;
      if (t.status === "completed") {
        setOutput(t.output ?? "");
        setPhase("done");
        return;
      }
      if (t.status === "failed") {
        setError("The agent couldn't complete this task. Check the receipt for details.");
        setPhase("error");
        return;
      }
    } catch {
      /* transient — keep polling */
    }
    setTimeout(() => poll(id, claimToken, attempt + 1), POLL_MS);
  }

  // Create the task (optionally with a verified payment) and start polling.
  // Self-contained: sets its own error/phase, never throws to the caller.
  async function submit(payment?: { paymentSignature: string; payerWallet: string }) {
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "anonymous", to: agentId, task: task.trim(), ...(payment ?? {}) }),
      });
      const data = (await res.json()) as { taskId?: string; claimToken?: string; error?: string };
      if (cancelled.current) return;
      if (res.ok && data.taskId && data.claimToken) {
        setTaskId(data.taskId);
        setPhase("running");
        poll(data.taskId, data.claimToken, 0);
        return;
      }
      // The payment already created a task (replay), but this response carries no
      // claimToken — a claimToken is minted only on the first create, never on a
      // replay, since the payment signature is public on-chain and re-reading it
      // must not hand anyone the private output. Surface the receipt so a spent
      // payment never dead-ends.
      if (res.ok && data.taskId) {
        setTaskId(data.taskId);
        setError("This payment already started a hire — view its receipt below.");
        setPhase("error");
        return;
      }
      setError(data.error ?? "Couldn't start the hire. Try again.");
      setPhase("error");
    } catch {
      setError("Network error starting the hire. Try again.");
      setPhase("error");
    }
  }

  async function hireFree() {
    if (!task.trim() || phase === "hiring" || phase === "running") return;
    cancelled.current = false;
    setPhase("hiring");
    setError(null);
    setOutput(null);
    setHint(null);
    await submit();
  }

  async function hirePaid() {
    if (!task.trim() || phase === "hiring" || phase === "running") return;
    if (usdcAmount === null || !receiver || !rpcUrl) return;
    cancelled.current = false;
    setPhase("hiring");
    setError(null);
    setOutput(null);
    try {
      // Pay once. If a previous attempt already paid (submit then failed), reuse
      // that signature — the money is already in the treasury; never charge twice.
      let justPaid = false;
      if (!paid.current) {
        setHint("Confirm the payment in your wallet…");
        // The receiver is the Axon treasury — the server re-verifies this payment
        // on-chain (amount, currency, and that `payer` signed it) before running.
        const { signature, payer } = await payForBuild({ rpcUrl, treasury: receiver, usdcAmount });
        if (cancelled.current) return;
        paid.current = { paymentSignature: signature, payerWallet: payer };
        justPaid = true;
      }
      setHint(justPaid ? "Payment sent — starting the hire…" : "Starting the hire…");
      await submit(paid.current);
    } catch (e) {
      if (cancelled.current) return;
      setError(payErrorMessage(e instanceof Error ? e.message : "", usdcAmount));
      setPhase("error");
    } finally {
      setHint(null);
    }
  }

  function reset() {
    cancelled.current = true;
    paid.current = null; // a fresh hire pays anew
    setPhase("idle");
    setOutput(null);
    setError(null);
    setHint(null);
    setTaskId(null);
    setTask("");
  }

  // ── Paid agent we can't settle in-browser (SOL price, or wallet config unset):
  // point at the API/MCP, which pay per task.
  if (isPaid && !canPayInBrowser) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-5 mb-10">
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-sm font-semibold text-gray-900 dark:text-white">Hire {agentName}</p>
          <span className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 rounded-md">{price} / task</span>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Paid agents settle with a single on-chain payment (x402) — the payment is the authorization, no account
          needed. Hire via the <Link href="/docs/sdk" className="text-teal-600 dark:text-teal-400 hover:underline">API or MCP</Link>.
        </p>
      </div>
    );
  }

  const payAndHire = canPayInBrowser;

  return (
    <div className="rounded-lg border border-teal-200 dark:border-teal-900/50 p-5 mb-10">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm font-semibold text-gray-900 dark:text-white">Hire {agentName}</p>
        {payAndHire ? (
          <span className="text-xs font-mono text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900/50 px-2 py-0.5 rounded-full">{price} / task</span>
        ) : (
          <span className="text-xs font-medium text-teal-700 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900/50 px-2 py-0.5 rounded-full">Free lane</span>
        )}
      </div>

      {(phase === "idle" || phase === "hiring" || (phase === "error" && !taskId)) && (
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
              onClick={payAndHire ? hirePaid : hireFree}
              disabled={!task.trim() || phase === "hiring"}
              className="text-sm font-medium px-4 py-2 rounded-md bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white transition-colors"
            >
              {phase === "hiring"
                ? (payAndHire && !paid.current ? "Paying…" : "Starting…")
                : payAndHire
                  ? (paid.current ? "Retry hire" : `Pay ${price} & Hire`)
                  : "Hire"}
            </button>
            <span className="text-[11px] text-gray-400 dark:text-gray-500">
              {payAndHire
                ? "Pay with Phantom · leaves a verifiable receipt · payment is the authorization"
                : "Runs immediately · leaves a verifiable receipt · 3 free hires"}
            </span>
          </div>
          {phase === "hiring" && hint && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
          {error && <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">{error}</p>}
        </>
      )}

      {phase === "running" && (
        <div className="flex items-center gap-2 py-2 text-sm text-gray-500 dark:text-gray-400">
          <span className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-teal-500 animate-spin" />
          {agentName} is working on it…
        </div>
      )}

      {/* The hire already started (a task exists), then the result failed or
          couldn't be read. Retrying the hire can't help — the payment is spent on
          this task — so point to the receipt and let them start a fresh hire. */}
      {phase === "error" && taskId && (
        <div>
          <p className="text-xs text-amber-600 dark:text-amber-400">{error}</p>
          <div className="mt-3 flex items-center gap-4">
            <a href={`/r/${encodeURIComponent(taskId)}`} target="_blank" rel="noopener noreferrer" className="text-xs text-teal-600 dark:text-teal-400 hover:underline">
              View the receipt →
            </a>
            <button onClick={reset} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
              Hire again
            </button>
          </div>
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
