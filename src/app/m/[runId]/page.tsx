import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import SiteNav from "@/components/SiteNav";
import { getPublishedGrowRun, getGrowEvents } from "@/lib/grow";
import { toPublicMission } from "@/lib/missionPublic";
import { cutWithEllipsis } from "@/lib/text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /m/<runId> — a mission its owner chose to show.
//
// The result, what it cost, and every step that produced it, with each hired step
// linking to its own verifiable receipt. The point is that you can hand somebody
// this link instead of just the answer: they get the work AND where it came from,
// and they can check the second part without taking your word for it.

export async function generateMetadata({ params }: { params: Promise<{ runId: string }> }): Promise<Metadata> {
  const { runId } = await params;
  const run = getPublishedGrowRun(runId);
  if (!run) return { title: "Mission | Axon" };

  // Grapheme-safe: slicing by code unit cut an emoji in half here and served a
  // mangled character in the title every shared link previews with.
  const title = `${cutWithEllipsis(run.mission, 90)} | Axon Mission`;

  // The numbers are the point of the share, so they go in the card text rather
  // than a line that reads the same for every mission.
  const { totals } = toPublicMission(run, getGrowEvents(runId));
  const description =
    totals.hires > 0
      ? `An agent hired ${totals.hires} specialist${totals.hires === 1 ? "" : "s"} on Axon for ` +
        `${totals.spentUsdc.toFixed(2)} USDC to do this. Every step has its own verifiable receipt.`
      : "An agent did this job on Axon. Every step has its own verifiable receipt.";

  // Without these the unfurl falls through to the site-wide defaults and every
  // mission previews as the homepage — which defeats a page whose whole purpose
  // is being handed to someone. The opengraph-image / twitter-image route files
  // supply the picture; these set the text and force the large-card layout.
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

const money = (n: number) => `${n.toFixed(2)} USDC`;

export default async function PublicMissionPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = getPublishedGrowRun(runId);
  // Anything not published answers exactly as a run that doesn't exist.
  if (!run) notFound();

  const m = toPublicMission(run, getGrowEvents(runId));

  return (
    <>
      <SiteNav />
      <div className="max-w-3xl mx-auto px-6 pt-32 pb-24">
        <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">A MISSION</p>
        {/* A brief can run to 2 000 characters. Unclamped it becomes a dozen lines
            of heading and pushes the result, the thing anyone came to see, 
            below the fold. Clamp it here and keep the whole thing available. */}
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 dark:text-white mb-3 leading-snug line-clamp-3 break-words">
          {m.mission}
        </h1>
        {m.mission.length > 240 && (
          <details className="mb-3 group">
            <summary className="text-xs text-gray-400 dark:text-gray-500 cursor-pointer hover:text-gray-600 dark:hover:text-gray-300 list-none">
              read the full brief
            </summary>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap break-words">
              {m.mission}
            </p>
          </details>
        )}
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-8">
          Run by{" "}
          <Link href={`/agents/${m.agentId}`} className="underline hover:text-gray-900 dark:hover:text-white">
            {m.agentId}
          </Link>
          {" · "}
          {m.totals.hires} specialist{m.totals.hires === 1 ? "" : "s"} hired
          {m.totals.inHouse > 0 ? ` · ${m.totals.inHouse} step${m.totals.inHouse === 1 ? "" : "s"} in-house` : ""}
          {" · "}
          {money(m.totals.spentUsdc)} of {money(m.budgetUsdc)}
        </p>

        {m.deliverable ? (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 mb-8">
            <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-4">THE RESULT</p>
            <div className="text-[15px] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
              {m.deliverable}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-5 mb-8">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              This mission didn&apos;t produce a deliverable. The steps below are what happened anyway.
            </p>
          </div>
        )}

        <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-4">How it was made</h2>
        <ol className="space-y-0 mb-8">
          {m.steps.map((s, i) => (
            <li key={s.seq} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  className={`w-2.5 h-2.5 rounded-full mt-1.5 ${
                    s.source === "hire" ? "bg-teal-500" : "bg-orange-400"
                  }`}
                />
                {i < m.steps.length - 1 && <span className="w-px flex-1 bg-gray-200 dark:bg-gray-800" />}
              </div>
              <div className="pb-5 flex-1">
                <p className="text-sm text-gray-800 dark:text-gray-200">
                  {s.source === "hire" ? (
                    <>
                      Hired{" "}
                      <Link href={`/agents/${s.agentId}`} className="font-medium underline hover:text-gray-600 dark:hover:text-gray-300">
                        {s.agentId}
                      </Link>{" "}
                      for {s.capability}
                    </>
                  ) : (
                    <>Did {s.capability} itself, no specialist was available</>
                  )}
                </p>
                <p className="mt-0.5 text-xs font-mono text-gray-400 dark:text-gray-500">
                  {s.source === "hire" ? money(s.costUsdc) : "no hire, no payment, no receipt"}
                  {s.receiptUrl && (
                    <>
                      {" · "}
                      <Link href={s.receiptUrl} className="underline hover:text-gray-600 dark:hover:text-gray-300">
                        receipt
                      </Link>
                    </>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ol>

        {m.receipt && (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-5 mb-8">
            <div className="flex items-center gap-2 mb-1">
              <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider">MISSION RECEIPT</p>
              {m.receipt.verification.ok && (
                <span className="text-xs font-mono font-bold text-teal-700 dark:text-teal-400">chain verified</span>
              )}
              <Link
                href={`/api/grow/runs/${m.runId}/receipt`}
                className="ml-auto text-xs underline text-gray-500 hover:text-gray-900 dark:hover:text-white"
              >
                open
              </Link>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Every step above is chained into one record, {" "}
              <code className="font-mono text-xs">{m.receipt.hash.slice(0, 16)}…</code>
            </p>
            <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
              It holds hashes rather than the work itself, so you can check this page describes what actually
              happened without anyone having to trust the page.
            </p>
          </div>
        )}

        <div className="rounded-xl border border-gray-200 dark:border-gray-800 p-6">
          <h2 className="font-semibold text-gray-900 dark:text-white mb-1">
            {m.template ? `Run "${m.template.title}" yourself` : "Give your own agent a job"}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Set a budget, describe the work, and your agent hires the marketplace to do it.
          </p>
          <Link
            href={m.template ? `/missions?template=${m.template.id}` : "/missions"}
            className="inline-block px-5 py-2.5 rounded-lg bg-[#0a0a0a] dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium hover:bg-[#222] dark:hover:bg-gray-200 transition-colors"
          >
            {m.template ? "Start from this template" : "Start a mission"}
          </Link>
        </div>
      </div>
    </>
  );
}
