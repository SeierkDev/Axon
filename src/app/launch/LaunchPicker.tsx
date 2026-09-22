"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { connectWallet } from "@/app/world/wallet";
import { sameAddress } from "@/lib/address";

/**
 * Which of your agents can launch a token.
 *
 * A header link needs somewhere to point, and /launch/<agentId> needs an agent id. So this is the way in:
 * connect a wallet, see the agents registered to it, pick one. An agent's token is deployed with its dev
 * address burned in permanently, so the wallet is the thing that decides what you are allowed to see here.
 */

interface Row {
  agentId: string;
  name: string;
  walletAddress?: string | null;
  endpoint?: string | null;
  verificationStatus?: string | null;
}

export default function LaunchPicker() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [agents, setAgents] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet) return;
    let alive = true;
    (async () => {
      const res = await fetch("/api/agents");
      const body = (await res.json()) as Row[] | { agents: Row[] };
      const all = Array.isArray(body) ? body : body.agents ?? [];
      if (alive) setAgents(all.filter((a) => a.walletAddress && sameAddress(a.walletAddress, wallet)));
    })().catch(() => {
      if (alive) setError("Could not read your agents.");
    });
    return () => { alive = false; };
  }, [wallet]);

  const connect = async () => {
    setError(null);
    try {
      setWallet(await connectWallet());
    } catch (e) {
      setError(
        e instanceof Error && e.message === "WALLET_NOT_FOUND"
          ? "No wallet found in this browser."
          : "Could not connect.",
      );
    }
  };

  if (!wallet) {
    return (
      <div>
        <button
          onClick={connect}
          className="px-6 py-3 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 font-semibold"
        >
          Connect your wallet
        </button>
        <p className="mt-3 text-sm text-gray-400">To find the agents registered to it.</p>
        {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  if (!agents) return <p className="text-gray-400">Looking for your agents…</p>;

  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6">
        <p className="font-semibold mb-2">No agents on this wallet</p>
        <p className="text-gray-500 dark:text-gray-400 mb-4">
          A token belongs to an agent, so there needs to be one first. Register an agent with an endpoint
          that answers, then come back.
        </p>
        <Link href="/publish" className="underline text-gray-600 dark:text-gray-300">
          Register an agent
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {agents.map((a) => {
        // The page itself does the real check; this is only about what to offer.
        const ready = Boolean(a.endpoint) && a.verificationStatus !== "unreachable";
        return (
          <div
            key={a.agentId}
            className="flex items-center justify-between gap-4 p-5 rounded-xl border border-gray-200 dark:border-gray-800"
          >
            <div className="min-w-0">
              <p className="font-semibold truncate">{a.name}</p>
              <p className="text-sm text-gray-400 truncate">
                {ready ? "Ready to launch" : "Its endpoint is not answering yet"}
              </p>
            </div>
            {ready ? (
              <Link
                href={`/launch/${a.agentId}`}
                className="shrink-0 px-5 py-2.5 rounded-xl bg-gray-900 dark:bg-white text-white dark:text-gray-900 text-sm font-semibold"
              >
                Launch a token
              </Link>
            ) : (
              <Link
                href={`/agents/${a.agentId}`}
                className="shrink-0 text-sm text-gray-400 underline"
              >
                Fix the endpoint
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}
