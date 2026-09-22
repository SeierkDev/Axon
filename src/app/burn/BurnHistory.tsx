"use client";

import { useState } from "react";

/**
 * Every burn, and actually every one.
 *
 * The list used to render ten rows under a heading that said "every burn", by which point eighty three
 * had happened. Anything older than the last few hours was unreachable, so a burn somebody read about
 * yesterday could not be checked today. That is the opposite of what a receipt is for.
 */

export interface BurnRow {
  n: number;
  ethIn: number;
  tokensOut: number;
  txHash: string;
  explorer: string;
}

export default function BurnHistory({ initial }: { initial: BurnRow[] }) {
  const [rows, setRows] = useState<BurnRow[]>(initial);
  const [more, setMore] = useState(initial.length > 0);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const loadMore = async () => {
    const oldest = rows[rows.length - 1]?.n;
    if (oldest === undefined) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/burn/history?before=${oldest}&limit=25`);
      const body = (await res.json()) as {
        burns: BurnRow[];
        hasMore: boolean;
        oldestStored: number | null;
      };
      // Keyed on the burn number, so a row arriving twice from two reads cannot duplicate.
      const seen = new Set(rows.map((r) => r.n));
      const fresh = body.burns.filter((b) => !seen.has(b.n));
      setRows([...rows, ...fresh]);
      setMore(body.hasMore && fresh.length > 0);
      if (body.oldestStored === 1 && !body.hasMore) setDone(true);
    } catch {
      setMore(false);
    } finally {
      setLoading(false);
    }
  };

  if (rows.length === 0) return null;

  return (
    <section className="mt-14">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold">Every burn</h2>
        <p className="text-sm text-gray-400 tabular-nums">{rows.length} shown</p>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800">
        {rows.map((b) => (
          <a
            key={b.n}
            href={b.explorer}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
          >
            <span className="text-sm font-mono text-gray-400 dark:text-gray-500 shrink-0 w-10">#{b.n}</span>
            <span className="flex-1 text-sm text-gray-900 dark:text-white">
              {b.tokensOut.toLocaleString("en-US", { maximumFractionDigits: 0 })}{" "}
              <span className="text-gray-400 dark:text-gray-500">$AXON burned</span>
            </span>
            <span className="text-sm text-gray-500 dark:text-gray-400 hidden sm:inline tabular-nums">
              {b.ethIn.toFixed(4)} ETH
            </span>
            <span className="text-xs font-mono text-gray-400 dark:text-gray-500 hover:underline shrink-0">
              {b.txHash.slice(0, 10)}…
            </span>
          </a>
        ))}
      </div>

      {more && !done && (
        <button
          onClick={loadMore}
          disabled={loading}
          className="mt-4 w-full py-3 rounded-xl border border-gray-200 dark:border-gray-800 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-gray-800/50 disabled:opacity-50 transition-colors"
        >
          {loading ? "Reading the chain…" : "Show older burns"}
        </button>
      )}

      <p className="mt-4 text-sm text-gray-400 dark:text-gray-500">
        {done
          ? "That is every burn since the first one. Each row is the transaction that did it."
          : "Each row is the transaction that did it. Open one to see the tokens arrive at the dead address."}
      </p>
    </section>
  );
}
