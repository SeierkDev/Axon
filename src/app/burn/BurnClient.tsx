"use client";

import { useEffect, useRef, useState } from "react";
import type { BurnLive } from "@/lib/burnLive";

export interface BurnPayload extends BurnLive {
  forwarded: { totalEth: number; pendingEth: number };
}

/**
 * The countdown, and everything that moves.
 *
 * The clock runs off `readAt`: the server says what time it was when it read the chain, and the
 * browser counts from there. That way a cached response still shows a correct countdown instead of
 * a stale one, and viewers who loaded the page at different moments agree.
 */
export default function BurnClient({ initial }: { initial: BurnPayload }) {
  const [data, setData] = useState(initial);
  const [now, setNow] = useState(() => initial.readAt);
  const drift = useRef(0);

  // The server's clock is the reference. Hold the offset between it and this machine's, so a
  // viewer whose clock is wrong still sees the right number of seconds.
  useEffect(() => {
    drift.current = Math.floor(Date.now() / 1000) - data.readAt;
  }, [data.readAt]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000) - drift.current), 1000);
    return () => clearInterval(t);
  }, []);

  // Re-read the pot periodically, and immediately after a burn becomes due.
  useEffect(() => {
    const refresh = async () => {
      try {
        const r = await fetch("/api/burn", { cache: "no-store" });
        if (r.ok) setData(await r.json());
      } catch {
        /* a failed refresh just leaves the last good reading on screen */
      }
    };
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, []);

  const remaining = data.nextBurnAt > 0 ? Math.max(0, data.nextBurnAt - now) : null;

  return (
    <>
      <Countdown remaining={remaining} data={data} />
      <Totals data={data} />
      <Schedule data={data} now={now} />
    </>
  );
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/**
 * The clock, in whichever unit keeps it readable.
 *
 * Burns are thirty minutes apart, so mm:ss is the normal case. A pot below the minimum waits for
 * the 24 hour backstop instead, and mm:ss renders that as "1427:51", which reads as a broken
 * counter rather than as most of a day.
 */
export function formatLeft(seconds: number): string {
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
  }
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function Countdown({ remaining, data }: { remaining: number | null; data: BurnPayload }) {
  const due = remaining !== null && remaining === 0;

  // Below the minimum the pot is not on the 30 minute cadence at all: it is waiting out the 24
  // hour backstop, and the ring has to wind over that window or it sits empty for a whole day.
  const waiting = data.launched && data.nextBurnEth > 0 && data.nextBurnEth < data.rules.minBurnEth;
  const window = waiting ? data.rules.maxWaitSeconds : data.rules.minIntervalSeconds;

  const pct = remaining === null ? 0 : Math.min(1, Math.max(0, 1 - remaining / window));
  const C = 2 * Math.PI * 88;

  return (
    <section className="mb-14">
      <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-6 py-12 sm:px-12">
        <div className="flex flex-col lg:flex-row items-center gap-12 lg:gap-16">
          <div className="relative shrink-0" style={{ width: 200, height: 200 }}>
            <svg width="200" height="200" viewBox="0 0 200 200" className="-rotate-90">
              <circle cx="100" cy="100" r="88" fill="none" strokeWidth="6" className="stroke-gray-100 dark:stroke-gray-800" />
              <circle
                cx="100" cy="100" r="88" fill="none" strokeWidth="6" strokeLinecap="round"
                className={due ? "stroke-green-500" : "stroke-gray-900 dark:stroke-white"}
                strokeDasharray={C}
                strokeDashoffset={C * (1 - pct)}
                style={{ transition: "stroke-dashoffset 1s linear" }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              {remaining === null ? (
                <span className="text-2xl font-semibold text-gray-400 dark:text-gray-500">Idle</span>
              ) : due ? (
                <>
                  <span className="text-3xl font-bold text-green-600 dark:text-green-500">Due</span>
                  <span className="mt-1 text-[11px] font-mono uppercase tracking-widest text-gray-400">now</span>
                </>
              ) : (
                <>
                  <span
                    className={`${
                      remaining >= 3600 ? "text-4xl" : "text-5xl"
                    } font-bold tabular-nums tracking-tight text-gray-900 dark:text-white`}
                  >
                    {formatLeft(remaining)}
                  </span>
                  <span className="mt-1 text-[11px] font-mono uppercase tracking-widest text-gray-400">
                    {waiting ? "until the backstop" : "until next burn"}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex-1 text-center lg:text-left">
            <p className="text-xs font-mono uppercase tracking-widest text-gray-400 dark:text-gray-500 mb-3">
              Next burn
            </p>
            {!data.live ? (
              <>
                <h2 className="text-2xl sm:text-3xl font-bold mb-3">The pot is not live yet</h2>
                <p className="text-gray-500 dark:text-gray-400 max-w-xl">
                  The burn starts when the token launches. Every figure on this page is read from the
                  pot on Robinhood Chain, so there is nothing to show until it exists.
                </p>
              </>
            ) : !data.launched ? (
              <>
                <h2 className="text-2xl sm:text-3xl font-bold mb-3">Deployed, waiting on the token</h2>
                <p className="text-gray-500 dark:text-gray-400 max-w-xl">
                  The pot is on chain and holding. Burns begin once the token launches through it.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-3xl sm:text-4xl font-bold mb-3 tabular-nums">
                  {data.nextBurnEth.toFixed(4)} <span className="text-gray-400 dark:text-gray-500">ETH</span>
                </h2>
                <p className="text-gray-500 dark:text-gray-400 max-w-xl">
                  {data.ready
                    ? "A burn is due. Anyone can fire it: the pot buys $AXON on the market and sends it to the dead address."
                    : waiting
                      ? `The pot holds ${data.potBalanceEth.toFixed(4)} ETH, under the ${data.rules.minBurnEth} ETH a burn needs. The clock above is the backstop: the burn fires the moment the pot passes that mark, and 24 hours after the last burn either way.`
                      : `The pot holds ${data.potBalanceEth.toFixed(4)} ETH. A burn spends what the depth cap allows, and whatever is left stays for the next one.`}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Totals({ data }: { data: BurnPayload }) {
  const cells: { label: string; value: string; sub?: string }[] = [
    { label: "ETH burned", value: data.totalEthBurned.toFixed(4), sub: "spent buying $AXON" },
    {
      label: "Tokens burned",
      value: data.totalTokensBurned > 0 ? compact(data.totalTokensBurned) : "0",
      sub: "sent to 0x…dEaD",
    },
    { label: "Burns", value: String(data.burnCount), sub: "since launch" },
    { label: "In the pot", value: data.potBalanceEth.toFixed(4), sub: "waiting to burn" },
  ];

  return (
    <section className="mb-14">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cells.map((c) => (
          <div
            key={c.label}
            className="p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900"
          >
            <p className="text-xs font-mono uppercase tracking-widest text-gray-400 dark:text-gray-500">
              {c.label}
            </p>
            <p className="mt-3 text-2xl sm:text-3xl font-bold tabular-nums text-gray-900 dark:text-white">
              {c.value}
            </p>
            {c.sub && <p className="mt-1 text-sm text-gray-400 dark:text-gray-500">{c.sub}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function Schedule({ data, now }: { data: BurnPayload; now: number }) {
  const ago = (t: number) => {
    if (!t) return "never";
    const s = Math.max(0, now - t);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  const rows: { k: string; v: string }[] = [
    { k: "Minimum between burns", v: `${data.rules.minIntervalSeconds / 60} minutes` },
    { k: "At full cadence", v: `${data.rules.burnsPerDay} burns a day` },
    { k: "Maximum per burn", v: `${data.rules.depthPercent}% of the market's ETH depth` },
    { k: "Smallest burn", v: `${data.rules.minBurnEth} ETH, unless 24 hours have passed` },
    { k: "Who can fire it", v: "Anyone. burn() takes no permissions" },
    { k: "Last burn", v: ago(data.lastBurnAt) },
  ];

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">How the schedule works</h2>
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 divide-y divide-gray-100 dark:divide-gray-800">
        {rows.map((r) => (
          <div key={r.k} className="flex items-center justify-between gap-6 px-5 py-4">
            <span className="text-sm text-gray-500 dark:text-gray-400">{r.k}</span>
            <span className="text-sm font-medium text-gray-900 dark:text-white text-right">{r.v}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
