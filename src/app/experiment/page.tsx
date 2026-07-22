"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { GrowRun, GrowEvent } from "@/lib/grow";

function BackLink() {
  return (
    <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors mb-8">
      <span aria-hidden>←</span> Axon
    </Link>
  );
}

interface GrowFeed {
  run: GrowRun | null;
  events: GrowEvent[];
  spentUsdc: number;
  remainingUsdc: number;
}

const KIND_LABEL: Record<string, string> = {
  plan: "Plan", search: "Search", hire: "Hire", payment: "Payment",
  result: "Result", synthesis: "Synthesis", note: "Note", error: "Error",
};

function StatusBadge({ status }: { status: string }) {
  const done = status === "completed";
  const failed = status === "failed";
  const cls = done
    ? "bg-black text-white"
    : failed
      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
      : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  return <span className={`px-2.5 py-1 rounded-full text-xs font-medium tracking-wide uppercase ${cls}`}>{status}</span>;
}

export default function ExperimentPage() {
  const [feed, setFeed] = useState<GrowFeed | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/grow", { cache: "no-store" });
        const data = (await res.json()) as GrowFeed;
        if (alive) { setFeed(data); setLoading(false); }
      } catch { if (alive) setLoading(false); }
    };
    load();
    const running = feed?.run?.status && !["completed", "failed"].includes(feed.run.status);
    const id = setInterval(load, running ? 3000 : 8000);
    return () => { alive = false; clearInterval(id); };
  }, [feed?.run?.status]);

  if (loading) return <main className="max-w-3xl mx-auto px-6 py-24 text-gray-400">Loading…</main>;
  const run = feed?.run;

  if (!run) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-16">
        <BackLink />
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">The Experiment</h1>
        <p className="mt-4 text-gray-500">No run yet. An agent will be given a budget and set loose on Axon — every move it makes will show up here, live and verifiable.</p>
      </main>
    );
  }

  const hires = feed!.events.filter((e) => e.kind === "payment").length;

  return (
    <main className="max-w-3xl mx-auto px-6 py-16">
      <BackLink />
      <header className="mb-10">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-xs font-mono uppercase tracking-widest text-gray-400">Live experiment</span>
          <StatusBadge status={run.status} />
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white leading-snug">{run.mission}</h1>
        <p className="mt-3 text-gray-500 dark:text-gray-400">
          One agent, a real budget, set loose on Axon. It plans the work, hires proven specialists, pays them, and assembles the result — every move a verifiable receipt.
        </p>
      </header>

      {hires > 0 && (
        <p className="mb-12 text-sm text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 pb-6">
          {hires} specialist{hires === 1 ? "" : "s"} hired — each paid on-chain, every payment a receipt you can verify.
        </p>
      )}

      {/* timeline */}
      <section className="mb-12">
        <h2 className="text-sm font-mono uppercase tracking-widest text-gray-400 mb-5">Timeline</h2>
        <ol className="space-y-4">
          {feed!.events.map((ev) => (
            <li key={ev.id} className="flex gap-4">
              <div className="flex flex-col items-center pt-1">
                <span className={`w-2 h-2 rounded-full ${ev.kind === "error" ? "bg-red-500" : ev.kind === "payment" ? "bg-black dark:bg-white" : "bg-gray-300 dark:bg-gray-600"}`} />
                <span className="flex-1 w-px bg-gray-100 dark:bg-gray-800 mt-1" />
              </div>
              <div className="flex-1 pb-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono uppercase tracking-wide text-gray-400">{KIND_LABEL[ev.kind] ?? ev.kind}</span>
                </div>
                <p className="text-sm text-gray-800 dark:text-gray-200 mt-0.5">{ev.summary}</p>
                {ev.taskId && (
                  <a href={`/r/${ev.taskId}`} className="text-xs font-mono text-gray-400 hover:text-black dark:hover:text-white underline mt-1 inline-block">
                    receipt /r/{ev.taskId.slice(0, 8)}…
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* deliverable */}
      {run.deliverable && (
        <section className="rounded-2xl border border-gray-200 dark:border-gray-800 p-6">
          <h2 className="text-sm font-mono uppercase tracking-widest text-gray-400 mb-4">Deliverable</h2>
          <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap text-gray-800 dark:text-gray-200">
            {run.deliverable}
          </div>
        </section>
      )}
    </main>
  );
}
