"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";
import { ConnectWallet } from "@/components/ConnectWallet";

interface Entitlements {
  rateMultiplier: number;
  freeCalls: number;
  queuePriority: number;
  agent: { toolGrants: number; toolSteps: number; toolResultChars: number };
}
interface Rung {
  name: string;
  rank: number;
  minimum: number;
  entitlements: Entitlements;
}
interface TierPayload {
  wallet: string | null;
  balance?: number | null;
  stale?: boolean;
  tier: Rung | null;
  next?: { name: string; minimum: number; needed: number | null } | null;
  ladder: Rung[];
}

const whole = (n: number) => n.toLocaleString("en-US");

/**
 * What your wallet holds, and what it is worth on the network.
 *
 * The page works before anything is connected: the ladder is public and somebody deciding whether
 * to hold should be able to read exactly what they would get without being asked to connect a
 * wallet first. Connecting only fills in which rung is yours.
 */
export default function TierClient() {
  const { address } = useWallet();
  const [data, setData] = useState<TierPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const url = address ? `/api/tier?wallet=${address}` : "/api/tier";
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: TierPayload) => live && (setData(d), setFailed(false)))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [address]);

  const ladder = data?.ladder ?? [];
  const mine = data?.tier ?? null;

  return (
    <div className="max-w-4xl mx-auto px-6 pt-32 pb-24">
      {/* Same way back as every other page off the main nav. */}
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white mb-6 transition-colors"
      >
        ← Back to Axon
      </Link>
      <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">$AXON</p>
      <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white mb-4">
        What your balance is worth
      </h1>
      <p className="text-gray-500 dark:text-gray-400 max-w-2xl leading-relaxed mb-10">
        Holding $AXON raises what the network gives you back: more throughput, a longer free
        allowance, priority when it is busy, and deeper agents. Read straight from the chain.
        Nothing is staked, locked or transferred, and selling drops the tier at the next read.
      </p>

      {/* ── your standing ─────────────────────────────────────────────── */}
      <section className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-6 py-8 sm:px-10 mb-12">
        {!address ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-5 sm:justify-between">
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">Connect to see your tier</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Read-only. Connecting proves which wallet is yours, nothing is signed or spent.
              </p>
            </div>
            <ConnectWallet />
          </div>
        ) : failed ? (
          <p className="text-gray-500 dark:text-gray-400">
            Could not read your balance just now. Your tier is unaffected: entitlements fall back to
            the last reading rather than being withdrawn.
          </p>
        ) : !data ? (
          <p className="text-gray-400 dark:text-gray-500">Reading the chain…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
              <div>
                <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-2">Your tier</p>
                <p className="text-4xl font-bold capitalize text-gray-900 dark:text-white">{mine?.name ?? "base"}</p>
              </div>
              <div>
                <p className="text-xs font-mono uppercase tracking-widest text-gray-400 mb-2">You hold</p>
                <p className="text-4xl font-bold tabular-nums text-gray-900 dark:text-white">
                  {data.balance === null || data.balance === undefined ? "—" : whole(data.balance)}
                </p>
              </div>
            </div>

            {data.stale && (
              <p className="mt-5 text-sm text-gray-400 dark:text-gray-500">
                The chain could not be reached just now, so this is your last known balance. Your
                entitlements are being honoured from it rather than withdrawn.
              </p>
            )}

            {data.next && data.next.needed !== null && data.next.needed > 0 && (
              <p className="mt-5 text-sm text-gray-500 dark:text-gray-400">
                {whole(data.next.needed)} more $AXON reaches{" "}
                <span className="font-semibold capitalize text-gray-900 dark:text-white">{data.next.name}</span>.
              </p>
            )}
          </>
        )}
      </section>

      {/* ── the ladder ────────────────────────────────────────────────── */}
      <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-5">The ladder</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800">
              <th className="py-3 pr-6 text-xs font-mono uppercase tracking-widest text-gray-400 font-normal">Tier</th>
              <th className="py-3 pr-6 text-xs font-mono uppercase tracking-widest text-gray-400 font-normal">Hold</th>
              <th className="py-3 pr-6 text-xs font-mono uppercase tracking-widest text-gray-400 font-normal">Rate limit</th>
              <th className="py-3 pr-6 text-xs font-mono uppercase tracking-widest text-gray-400 font-normal">Free calls</th>
              <th className="py-3 pr-6 text-xs font-mono uppercase tracking-widest text-gray-400 font-normal">Queue</th>
              <th className="py-3 text-xs font-mono uppercase tracking-widest text-gray-400 font-normal">Agent depth</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((rung) => {
              const yours = mine?.name === rung.name && !!address;
              return (
                <tr
                  key={rung.name}
                  className={`border-b border-gray-100 dark:border-gray-800/60 ${yours ? "bg-gray-50 dark:bg-gray-900" : ""}`}
                >
                  <td className="py-4 pr-6">
                    <span className="font-semibold capitalize text-gray-900 dark:text-white">{rung.name}</span>
                    {yours && (
                      <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] leading-none align-middle">
                        YOU
                      </span>
                    )}
                  </td>
                  <td className="py-4 pr-6 tabular-nums text-gray-600 dark:text-gray-300">
                    {rung.minimum === 0 ? "anything" : whole(rung.minimum)}
                  </td>
                  <td className="py-4 pr-6 text-gray-600 dark:text-gray-300">
                    {rung.entitlements.rateMultiplier}&times;
                  </td>
                  <td className="py-4 pr-6 tabular-nums text-gray-600 dark:text-gray-300">
                    {rung.entitlements.freeCalls}
                  </td>
                  <td className="py-4 pr-6 text-gray-600 dark:text-gray-300">
                    {rung.rank === 0 ? "standard" : `+${rung.rank}`}
                  </td>
                  <td className="py-4 text-gray-600 dark:text-gray-300 whitespace-nowrap">
                    {rung.entitlements.agent.toolGrants} tools &middot; {rung.entitlements.agent.toolSteps} steps
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-8 text-sm text-gray-400 dark:text-gray-500 max-w-2xl leading-relaxed">
        Base is the network as it has always been, so nobody loses anything by any of this existing.
        Agent depth applies to work that was paid for. Free-lane hires run at base depth whatever the
        owner holds.
      </p>
    </div>
  );
}
