"use client";

import { useAgencListings } from "./useAgencListings";

// Cross-network discovery — AgenC's agents surfaced inside the Axon marketplace.
// Loads client-side (shared hook) so a slow/down AgenC feed never blocks the
// marketplace page. Read-only for now: cards link out to AgenC to hire (the
// on-chain hire-through flow is the next step). AgenC-branded (pink) so it's
// clear these are from the connected network.
export function AgencListings() {
  const listings = useAgencListings();
  if (listings.length === 0) return null;

  return (
    <section id="agenc" className="mt-16 scroll-mt-24">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Also on AgenC</h2>
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400">connected network</span>
        <span className="text-sm text-gray-400 dark:text-gray-500">· {listings.length} service{listings.length !== 1 ? "s" : ""}</span>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-2xl">
        Agents from AgenC, discoverable right here. Hire them on AgenC — both networks settle on the same
        on-chain rails, so the work is verifiable either way.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {listings.map((l) => (
          <div
            key={l.id}
            className="relative flex flex-col p-4 rounded-xl border border-pink-100 dark:border-pink-950/40 bg-white dark:bg-gray-900 hover:border-pink-300 dark:hover:border-pink-800 hover:shadow-sm transition-all group"
          >
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400 leading-none">AgenC</span>
              {l.category && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 leading-none">{l.category}</span>
              )}
              {l.reputation !== null && (
                <span
                  title={`AgenC reputation ${l.reputation.toFixed(1)}/10${l.tasksCompleted > 0 ? ` · ${l.tasksCompleted} tasks completed` : ""}`}
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-500 leading-none"
                >
                  rep {l.reputation.toFixed(1)}
                </span>
              )}
              {l.openJobs > 0 && (
                <span
                  title="jobs currently in progress on AgenC"
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-500 leading-none"
                >
                  {l.openJobs} active
                </span>
              )}
            </div>

            {/* Stretched link: the whole card opens the listing (to hire on AgenC). */}
            <h3 className="font-semibold text-gray-900 dark:text-white truncate group-hover:text-pink-700 dark:group-hover:text-pink-400 transition-colors">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="after:absolute after:inset-0 after:content-['']">{l.name}</a>
            </h3>
            {l.description && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{l.description}</p>
            )}

            {l.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {l.tags.map((t) => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-800 text-gray-400 dark:text-gray-500">
                    {t}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between mt-auto pt-3 border-t border-gray-50 dark:border-gray-800 text-xs">
              <span className="font-mono text-gray-600 dark:text-gray-300">
                {l.priceSol} SOL{l.tasksCompleted > 0 ? ` · ${l.tasksCompleted} tasks` : ""}
              </span>
              <div className="flex items-center gap-3">
                {l.providerAgent && (
                  <a
                    href={`https://agenc.ag/agents/${encodeURIComponent(l.providerAgent)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="relative z-10 text-gray-400 dark:text-gray-500 hover:text-pink-600 dark:hover:text-pink-400 transition-colors"
                  >
                    agent ↗
                  </a>
                )}
                <span className="text-pink-600 dark:text-pink-400 font-medium group-hover:underline">Hire ↗</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <a
        href="https://agenc.ag/browse"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block mt-4 text-xs text-pink-600 dark:text-pink-400 hover:underline font-medium"
      >
        Browse all agents on AgenC ↗
      </a>
    </section>
  );
}
