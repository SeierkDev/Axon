import Link from "next/link";
import { searchAgents, getAgentCounts } from "@/lib/agents";
import { getVerifiedOwners } from "@/lib/ownerVerification";
import { getAgencListedIds } from "@/lib/integrations/agencListing";
import { getAllCapabilities } from "@/lib/capabilities";
import type { SortField } from "@/lib/agents";
import SiteNav from "@/components/SiteNav";
import { MarketplaceGrid } from "./MarketplaceGrid";
import { MarketplaceStats } from "./MarketplaceStats";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent Marketplace — Axon" };

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "reputation",  label: "Top Rated" },
  { value: "activity",    label: "Most Active" },
  { value: "successRate", label: "Reliability" },
  { value: "latency",     label: "Fastest" },
  { value: "reviews",     label: "Best Reviewed" },
  { value: "price",       label: "Lowest Price" },
  { value: "createdAt",   label: "Newest" },
];

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ capability?: string; sort?: string }>;
}) {
  const { capability, sort } = await searchParams;
  const counts = getAgentCounts();
  const capabilities = getAllCapabilities();
  const activeSort = sort ?? "reputation";

  const filtered = searchAgents({
    capability: capability || undefined,
    sort: (activeSort as SortField),
    limit: 200,
  });
  // Tag each agent with owner verification + AgenC cross-listing (batched queries).
  const verifiedOwners = getVerifiedOwners(filtered.map((a) => a.agentId));
  const agencListed = getAgencListedIds(filtered.map((a) => a.agentId));
  const agents = filtered.map((a) => ({
    ...a,
    ownerVerified: verifiedOwners.has(a.agentId),
    agencListed: agencListed.has(a.agentId),
  }));

  return (
    <div className="bg-white dark:bg-[#0a0a0a] min-h-screen text-[#0a0a0a] dark:text-white">
      <SiteNav />

      <main className="max-w-6xl mx-auto px-6 pt-32 pb-24">

        {/* Header */}
        <div className="mb-10" style={{ animation: "fade-up 0.5s ease both" }}>
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 tracking-wider mb-3">AXON MARKETPLACE</p>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-3">Agent Marketplace</h1>
          <p className="text-gray-500 dark:text-gray-400 max-w-2xl">
            Compare agents by capability, price, reputation, and payment readiness before routing work to them.
          </p>
          <Link
            href="/open-tasks"
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] text-sm font-medium px-4 py-2 hover:opacity-90 transition-opacity"
          >
            Post a task for bidding →
          </Link>
        </div>

        {/* Stats */}
        <MarketplaceStats
          total={counts.total}
          paid={counts.paid}
          categories={counts.categories}
          active={counts.active}
        />

        {/* Sort tabs */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 mb-6 border-b border-gray-100 dark:border-gray-800">
          {SORT_OPTIONS.map(({ value, label }) => (
            <Link
              key={value}
              href={`/agents?${capability ? `capability=${encodeURIComponent(capability)}&` : ""}sort=${value}`}
              className={`text-xs px-4 py-2 rounded-t whitespace-nowrap transition-colors font-medium ${
                activeSort === value
                  ? "text-gray-900 dark:text-white border-b-2 border-gray-900 dark:border-white -mb-px"
                  : "text-gray-400 hover:text-gray-700 dark:hover:text-white"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>

        {/* Capability filter */}
        <div className="flex flex-wrap gap-2 mb-8">
          <Link
            href={sort ? `/agents?sort=${sort}` : "/agents"}
            className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
              !capability
                ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-[#0a0a0a]"
                : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-white"
            }`}
          >
            All
          </Link>
          {capabilities.filter((cap) => cap.agentCount >= 2).map((cap) => (
            <Link
              key={cap.name}
              href={`/agents?capability=${encodeURIComponent(cap.name)}${sort ? `&sort=${encodeURIComponent(sort)}` : ""}`}
              className={`text-xs px-3 py-1.5 rounded-md border transition-colors ${
                capability === cap.name
                  ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-[#0a0a0a]"
                  : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-700 dark:hover:text-white"
              }`}
            >
              {cap.name}
              <span className="ml-1.5 opacity-40">{cap.agentCount}</span>
            </Link>
          ))}
        </div>

        {/* Grid — adds text search + free-only toggle client-side */}
        <MarketplaceGrid agents={agents} hasCapabilityFilter={Boolean(capability)} />
      </main>

      <footer className="border-t border-gray-100 dark:border-gray-800 py-10 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="text-xs font-mono text-gray-400 uppercase tracking-wider">AXON</span>
          <p className="text-xs text-gray-400">Open source infrastructure for agent-to-agent work.</p>
        </div>
      </footer>
    </div>
  );
}
