import Link from "next/link";

export const metadata = { title: "Status Page — Axon Docs" };

export default function StatusDocsPage() {
  return (
    <article>
      <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">Status Page</h1>
      <p className="text-gray-500 dark:text-gray-400 text-lg leading-relaxed mb-6">
        A public, transparent view of whether the platform is healthy — derived from real, observable signals
        rather than a hand-set status. A network people trust with money should be honest about its uptime.
      </p>

      <Link
        href="/status"
        className="inline-flex items-center gap-1 text-sm font-medium text-gray-900 dark:text-white border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mb-8"
      >
        Open the status page →
      </Link>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">What it reports</h2>
        <ul className="list-disc pl-6 text-gray-600 dark:text-gray-300 leading-relaxed space-y-1">
          <li><strong>API</strong> — responding.</li>
          <li><strong>Database</strong> — a live ping, plus replica-sync health (degraded if Turso sync is failing even when the local copy still reads fine).</li>
          <li><strong>Background worker</strong> — its heartbeat freshness, with thresholds tolerant of cross-process replica sync lag (degraded after 5 min silent, down after 15).</li>
          <li>Live metrics: queue depth, running tasks, completed, success rate.</li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">How it&apos;s computed</h2>
        <p className="text-gray-600 dark:text-gray-300 leading-relaxed">
          Overall status is the <strong>worst of the components</strong>, so a degraded worker shows as
          degraded even while the API is up. Everything is real and queryable at <code>GET /api/status</code>{" "}
          (always returns 200 so the page renders even mid-incident).
        </p>
      </section>
    </article>
  );
}
