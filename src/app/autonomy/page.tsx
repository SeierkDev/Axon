import Link from "next/link";
import SiteNav from "@/components/SiteNav";
import { getLatestRun, getRunHistory, openFindings, type Finding } from "@/lib/autonomy";
import { getLatestNetworkRun } from "@/lib/autonomyNetwork";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Autonomy | Axon",
  description:
    "Axon checks itself on a schedule. Every pass is recorded here and committed to the repository, so the log can be diffed rather than believed.",
};

// /autonomy — the public record of Axon maintaining itself.
//
// The point of this page is not that checks pass. It is that the passes are
// visible whether they pass or not: a page that only ever showed green would be
// worth precisely as much as saying "it's fine", which is the thing Axon exists
// to replace.

function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "No data";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toISOString().slice(0, 10);
}

function FindingRow({ f }: { f: Finding }) {
  const isError = f.severity === "error";
  return (
    <li className="px-5 py-4">
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isError ? "bg-red-500" : "bg-amber-400"}`}
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-sm text-gray-800 dark:text-gray-200">{f.what}</p>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{f.why}</p>
          {f.where.length > 0 && (
            <p className="mt-1.5 text-xs font-mono text-gray-400 dark:text-gray-500 break-words">
              {f.where.join("  ·  ")}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export default function AutonomyPage() {
  const latest = getLatestRun();
  const history = getRunHistory(20);
  const findings = openFindings(latest);
  const network = getLatestNetworkRun();

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />
      <main className="max-w-3xl mx-auto px-6 pt-32 pb-24">
        <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">AUTONOMY</p>
        <h1 className="text-3xl md:text-4xl font-bold text-gray-900 dark:text-white mb-4">
          Axon checks itself.
        </h1>
        <p className="text-gray-500 dark:text-gray-400 leading-relaxed mb-3">
          On a schedule, and on every push, Axon runs a set of checks over its own repository and
          records what it found. This page is that record.
        </p>
        <p className="text-gray-500 dark:text-gray-400 leading-relaxed mb-10">
          The log is committed to the repository rather than kept in a database, so you can read the
          history with <code className="font-mono text-sm text-gray-600 dark:text-gray-300">git log</code> instead
          of taking this page&apos;s word for it. Findings are shown whether or not they are
          flattering, the first pass caught a documentation page telling people to install a
          package that does not exist.
        </p>

        {!latest ? (
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 px-5 py-6">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No pass has been recorded yet. The first one will appear here once it runs.
            </p>
          </div>
        ) : (
          <>
            {/* Latest pass */}
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden mb-10">
              <div className="px-5 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 flex items-center justify-between gap-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  Latest pass
                </p>
                <p className="text-xs font-mono text-gray-400 dark:text-gray-500">
                  {when(latest.finishedAt)}
                  {latest.commit ? ` · ${latest.commit}` : ""}
                </p>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y md:divide-y-0 divide-gray-100 dark:divide-gray-800">
                <div className="p-4">
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">{latest.checks.length}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Checks run</p>
                </div>
                <div className="p-4">
                  <p className="text-2xl font-bold text-gray-900 dark:text-white">
                    {latest.checks.reduce((n, c) => n + c.checked, 0)}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Things inspected</p>
                </div>
                <div className="p-4">
                  <p className={`text-2xl font-bold ${latest.errors > 0 ? "text-red-600 dark:text-red-400" : "text-gray-900 dark:text-white"}`}>
                    {latest.errors}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Errors</p>
                </div>
                <div className="p-4">
                  <p className={`text-2xl font-bold ${latest.warnings > 0 ? "text-amber-600 dark:text-amber-400" : "text-gray-900 dark:text-white"}`}>
                    {latest.warnings}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Warnings</p>
                </div>
              </div>
            </div>

            {/* What it looked at */}
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">What it checked</h2>
            <ul className="rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 mb-10">
              {latest.checks.map((c) => (
                <li key={c.id} className="px-5 py-3 flex items-center gap-3">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${c.ok ? "bg-emerald-500" : "bg-red-500"}`}
                    aria-hidden
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-gray-800 dark:text-gray-200">{c.title}</span>
                    <span className="block text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">
                      {c.id} · {c.checked} inspected · {c.findings.length} finding
                      {c.findings.length === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">{c.ms}ms</span>
                </li>
              ))}
            </ul>

            {/* What it changed, before what it found, because an automated edit
                deserves more of a reader's attention than an automated opinion. */}
            {latest.changes && latest.changes.length > 0 && (
              <>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">What it changed</h2>
                <ul className="rounded-lg border border-teal-200 dark:border-teal-900/50 divide-y divide-teal-100 dark:divide-teal-900/40 mb-10">
                  {latest.changes.map((c, i) => (
                    <li key={`${c.where}-${i}`} className="px-5 py-3 flex items-start gap-3">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-500" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm text-gray-800 dark:text-gray-200">{c.what}</span>
                        <span className="block text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">{c.where}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* What it found */}
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
              {findings.length > 0 ? "What it found" : "Nothing outstanding"}
            </h2>
            {findings.length > 0 ? (
              <ul className="rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 mb-10">
                {findings.map((f, i) => (
                  <FindingRow key={`${f.what}-${i}`} f={f} />
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-gray-200 dark:border-gray-800 px-5 py-6 mb-10">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  The last pass found nothing to report. The counts above say how much it looked at
                  to reach that.
                </p>
              </div>
            )}

            {/* History */}
            {history.length > 1 && (
              <>
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Previous passes</h2>
                <ul className="rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 mb-10">
                  {history.slice(1).map((r) => (
                    <li key={r.startedAt} className="px-5 py-3 flex items-center gap-4">
                      <span className="text-xs font-mono text-gray-400 dark:text-gray-500 w-24 shrink-0">
                        {when(r.finishedAt)}
                      </span>
                      <span className="flex-1 text-sm text-gray-600 dark:text-gray-400">
                        {r.checks.length} checks · {r.errors} error{r.errors === 1 ? "" : "s"} ·{" "}
                        {r.warnings} warning{r.warnings === 1 ? "" : "s"}
                      </span>
                      {r.commit && (
                        <span className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">
                          {r.commit}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {/* The network pass. Separate from the codebase pass, and labelled, because
            its record lives in the database rather than git: live state cannot be
            committed, and pretending otherwise would overstate what is checkable. */}
        {network && (
          <>
            <h2 className="text-sm font-semibold text-gray-900 dark:text-white mb-1">The network</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
              A second pass looks at the marketplace instead of the code. It saw{" "}
              {network.agentsSeen} agent{network.agentsSeen === 1 ? "" : "s"} on{" "}
              {new Date(network.finishedAt).toISOString().slice(0, 10)}. This record lives in the
              database, not git, live state cannot be committed.
            </p>
            <ul className="rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-100 dark:divide-gray-800 mb-4">
              {network.observations.length === 0 ? (
                <li className="px-5 py-4 text-sm text-gray-500 dark:text-gray-400">
                  Nothing worth reporting about the marketplace on the last pass.
                </li>
              ) : (
                network.observations.map((o, i) => (
                  <li key={`${o.kind}-${i}`} className="px-5 py-4 flex items-start gap-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-gray-300 dark:bg-gray-600" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm text-gray-800 dark:text-gray-200">{o.what}</span>
                      <span className="block text-sm text-gray-500 dark:text-gray-400 mt-0.5">{o.why}</span>
                    </span>
                  </li>
                ))
              )}
            </ul>
            {network.changes.length > 0 && (
              <ul className="rounded-lg border border-teal-200 dark:border-teal-900/50 divide-y divide-teal-100 dark:divide-teal-900/40 mb-4">
                {network.changes.map((c, i) => (
                  <li key={`${c.agentId}-${i}`} className="px-5 py-3 flex items-start gap-3">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-500" aria-hidden />
                    <span className="min-w-0">
                      <span className="block text-sm text-gray-800 dark:text-gray-200">{c.what}</span>
                      <span className="block text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">{c.agentId}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-10">
              The only thing this pass changes is the price of agents whose owner turned on
              auto-pricing. Every other agent it merely looks at.
            </p>
          </>
        )}

        {/* Scope, stated plainly, because the limits are what make the rest credible */}
        <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">
            What this does and does not do
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
            A pass <strong>reports</strong>, and when run with <code className="font-mono text-xs">--fix</code> it
            also applies the narrow class of repairs a compiler can prove, currently dropping an{" "}
            <code className="font-mono text-xs">export</code> that nothing outside its own file uses.
            Fixes never land on the main branch: they run on a branch, open a pull request, and the
            ordinary test suite decides. The thing making a change is not the thing that certifies it.
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
            Nothing automated touches payments, authentication, the receipt hash chain, or anything
            that spends from the treasury. Those stay human, deliberately.
          </p>
        </div>

        <p className="mt-8 text-xs text-gray-400 dark:text-gray-500">
          Run it yourself: <code className="font-mono">node scripts/autonomy.mjs --dry</code> in the{" "}
          <Link
            href="https://github.com/SeierkDev/Axon"
            className="underline hover:text-gray-600 dark:hover:text-gray-300"
          >
            repository
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
