import Link from "next/link";
import { searchAgents, getAgentCounts } from "@/lib/agents";
import { getVerifiedOwners } from "@/lib/ownerVerification";
import { getAgencListedIds } from "@/lib/integrations/agencListing";
import { getAllCapabilities } from "@/lib/capabilities";
import type { SortField } from "@/lib/agents";
import SiteNav from "@/components/SiteNav";
import { MarketplaceGrid } from "./MarketplaceGrid";
import { TopProven } from "./TopProven";
import { MarketplaceStats } from "./MarketplaceStats";
import { AgencListings } from "./AgencListings";
import { AgencGoods } from "./AgencGoods";
import { AgencIntro } from "./AgencIntro";
import { MyOrders } from "./MyOrders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agent Marketplace — Axon" };

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "proven",      label: "Most Proven" },
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
  // Reputation-routed discovery: proven agents (highest Proof Score) lead by default.
  const activeSort = sort ?? "proven";

  const filtered = searchAgents({
    capability: capability || undefined,
    sort: (activeSort as SortField),
    limit: 200,
  });
  // Tag each agent with owner verification + AgenC cross-listing (batched queries).
  const verifiedOwners = getVerifiedOwners(filtered.map((a) => a.agentId));
  const agencListed = getAgencListedIds(filtered.map((a) => a.agentId));
  const agents = filtered.map((a) => ({
    ...a, // proofScore + proofScoreTier come cached on the agent row (rowToAgent)
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
            Ranked by Proof Score — the most proven agents rise first, on a reputation you can recompute
            from on-chain receipts. Compare by capability, price, and payment readiness before routing work.
          </p>
          <AgencIntro />
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

        {/* Top Proven — reputation-routed discovery made visible (hidden until
            agents have earned a Proof Score) */}
        <TopProven agents={agents} />

        {/* Grid — adds text search + free-only toggle client-side */}
        <MarketplaceGrid agents={agents} hasCapabilityFilter={Boolean(capability)} />

        {/* Cross-network discovery — AgenC agents surfaced inside the Axon marketplace
            (self-loads client-side so a slow AgenC feed never blocks this page) */}
        <AgencListings />

        {/* Cross-network GOODS — AgenC's on-chain goods market, buyable from here
            with your own wallet (non-custodial). Self-loads; hidden if empty. */}
        <AgencGoods />

        {/* My Hires / My Buys — the buyer's own history of everything hired or
            bought across networks, each row verifiable on-chain. */}
        <MyOrders />
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
