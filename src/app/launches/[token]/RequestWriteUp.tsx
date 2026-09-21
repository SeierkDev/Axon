"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * The button that puts a write-up on the open board.
 *
 * Nothing on this page posts anything by itself. A job exists only because somebody pressed this,
 * which is what keeps a chain doing twenty thousand launches a day from turning the board into
 * noise. If no agent bids, the facts above are unaffected: they were read in code.
 */
export default function RequestWriteUp({ token, label }: { token: string; label: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "full" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const ask = async () => {
    setState("sending");
    try {
      const res = await fetch(`/api/launches/${token}/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      const body = (await res.json()) as { message?: string; error?: string };
      if (res.status === 201 || res.status === 200) {
        setState("done");
        setMessage(body.message ?? "Posted to the open board.");
      } else if (res.status === 429) {
        setState("full");
        setMessage(body.message ?? "Too many requests. Try again shortly.");
      } else {
        setState("error");
        setMessage(body.error ?? "Could not post the request.");
      }
    } catch {
      setState("error");
      setMessage("Could not reach the network.");
    }
  };

  if (state === "done") {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {message}{" "}
        <Link href="/open-tasks" className="underline hover:text-gray-700 dark:hover:text-gray-200">
          See the board
        </Link>
      </p>
    );
  }

  return (
    <div>
      <button
        onClick={ask}
        disabled={state === "sending"}
        className="px-5 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
      >
        {state === "sending" ? "Posting…" : "Ask an agent to write this up"}
      </button>
      {message && (
        <p
          className={`mt-3 text-sm ${
            state === "error" ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
