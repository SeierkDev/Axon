"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Agent } from "@/sdk/types";

function formatPrice(price?: string) {
  return price?.trim() || "Free";
}

function listingMode(agent: Agent) {
  if (agent.endpoint) return "External endpoint";
  if (agent.provider === "ollama") return "Self-hosted model";
  if (agent.provider === "grok") return `${agent.providerModel ?? "Grok 4.20"} (xAI)`;
  return "Managed model";
}

function trustLevel(reputation = 0) {
  if (reputation >= 8) return "High trust";
  if (reputation >= 5) return "Building trust";
  return "New listing";
}

function paymentLabel(agent: Agent) {
  if (!agent.price?.trim()) return "Free task ready";
  if (agent.walletAddress) return "x402 ready";
  return "Payment setup needed";
}

function verificationLabel(agent: Agent) {
  if (agent.verificationStatus === "platform") return "Axon hosted";
  if (agent.verificationStatus === "modulr") return "Modulr partner";
  if (!agent.endpoint) return "Hosted route";
  if (agent.verificationStatus === "x402_compliant") return "x402 verified";
  if (agent.verificationStatus === "reachable") return "Endpoint reachable";
  if (agent.verificationStatus === "unreachable") return "Endpoint offline";
  return "Unverified endpoint";
}

function healthDot(agent: Agent): string {
  if (agent.verificationStatus === "platform") return "bg-green-400";
  if (agent.verificationStatus === "modulr") return "bg-purple-400";
  if (!agent.endpoint) return "bg-green-400";
  if (agent.verificationStatus === "x402_compliant") return "bg-green-400";
  if (agent.verificationStatus === "reachable") return "bg-blue-400";
  if (agent.verificationStatus === "unreachable") return "bg-red-400";
  return "bg-gray-300";
}

function AgentCard({ agent, index = 0 }: { agent: Agent; index?: number }) {
  const price = formatPrice(agent.price);
  const reputation = agent.reputation ?? 0;

  return (
    <Link
      href={`/agents/${encodeURIComponent(agent.agentId)}`}
      className="block p-5 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:border-gray-400 dark:hover:border-gray-700 hover:shadow-sm transition-all group"
      style={{ animation: `fade-up 0.5s ease ${index * 60}ms both` }}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 dark:text-gray-500">
              {listingMode(agent)}
            </p>
            {agent.verificationStatus === "platform" ? (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-900 dark:bg-white text-white dark:text-[#0a0a0a] leading-none">Axon</span>
            ) : agent.verificationStatus === "modulr" ? (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-600 text-white leading-none">Modulr</span>
            ) : (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 leading-none">Community</span>
            )}
            {agent.ownerVerified && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-400 leading-none">Verified owner</span>
            )}
            {agent.agencListed && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-pink-100 dark:bg-pink-950/40 text-pink-700 dark:text-pink-400 leading-none">✓ AgenC</span>
            )}
            {typeof agent.proofScore === "number" && agent.proofScore > 0 && (
              <span
                title={`Proof Score ${agent.proofScore}/1000 · ${agent.proofScoreTier} — verifiable from on-chain receipts`}
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-teal-100 dark:bg-teal-950/40 text-teal-700 dark:text-teal-400 leading-none"
              >
                Proof {agent.proofScore}
              </span>
            )}
          </div>
          <h3 className="font-semibold text-gray-900 dark:text-white group-hover:text-gray-700 dark:group-hover:text-gray-300 transition-colors">
            {agent.name}
          </h3>
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500 mt-0.5">{agent.agentId}</p>
        </div>
        <span className="text-xs font-mono text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 rounded-md shrink-0">
          {price}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {agent.capabilities.map((cap) => (
          <span key={cap} className="text-[11px] px-2 py-0.5 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400">
            {cap}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 mb-4 text-xs">
        <div>
          <p className="text-gray-400 dark:text-gray-500 text-[11px]">Reputation</p>
          <p className="font-semibold text-gray-900 dark:text-white mt-0.5">
            {reputation > 0 ? reputation.toFixed(1) : "New"}
          </p>
        </div>
        <div>
          <p className="text-gray-400 dark:text-gray-500 text-[11px]">Market signal</p>
          <p className="font-semibold text-gray-900 dark:text-white mt-0.5">{trustLevel(reputation)}</p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-gray-400 dark:text-gray-500 border-t border-gray-50 dark:border-gray-800 pt-3">
        <span className="flex items-center gap-1.5 truncate">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${healthDot(agent)}`} />
          {paymentLabel(agent)} · {verificationLabel(agent)}
        </span>
        <span className="group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-colors shrink-0">Send task →</span>
      </div>
    </Link>
  );
}

interface Props {
  agents: Agent[];
  hasCapabilityFilter: boolean;
}

const CATEGORY_ORDER = ["Build", "Research", "Development", "Finance", "Content", "General"];

function isNaturalLanguage(q: string): boolean {
  return q.trim().split(/\s+/).length >= 3;
}

export function MarketplaceGrid({ agents, hasCapabilityFilter }: Props) {
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [semanticResults, setSemanticResults] = useState<Agent[] | null>(null);
  const [completedQuery, setCompletedQuery] = useState("");

  // Derived — avoids synchronous setState in the effect body
  const q = query.trim();
  const isNL = isNaturalLanguage(q);
  const semanticLoading = isNL && completedQuery !== q;
  const activeResults = isNL && !semanticLoading ? semanticResults : null;

  useEffect(() => {
    const trimmed = query.trim();
    if (!isNaturalLanguage(trimmed)) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/agents?q=${encodeURIComponent(trimmed)}&limit=50`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setSemanticResults(null);
        } else {
          const data = await res.json() as { agents: Agent[]; semanticQuery?: string };
          setSemanticResults(data.semanticQuery ? data.agents : null);
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        setSemanticResults(null);
      } finally {
        if (!controller.signal.aborted) setCompletedQuery(trimmed);
      }
    }, 700);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const visible = useMemo(() => {
    // When semantic results are available, use them directly (already ranked)
    let result = activeResults ?? agents;
    if (freeOnly) result = result.filter((a) => !a.price?.trim());
    // Keyword filter only when NOT in semantic mode and not waiting for semantic results
    if (!activeResults && !semanticLoading && query.trim()) {
      const qLower = query.trim().toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(qLower) ||
          a.agentId.toLowerCase().includes(qLower) ||
          a.capabilities.some((c) => c.toLowerCase().includes(qLower)) ||
          (a.category ?? "").toLowerCase().includes(qLower)
      );
    }
    return result;
  }, [agents, query, freeOnly, activeResults, semanticLoading]);

  // Group by category unless user is searching/filtering (never group semantic results — order matters)
  const grouped = useMemo(() => {
    if (query.trim() || freeOnly || hasCapabilityFilter || activeResults) return null;

    const map = new Map<string, Agent[]>();
    for (const agent of visible) {
      const cat = agent.category ?? "General";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(agent);
    }
    // Sort categories by preferred order, then alphabetically
    const sorted = [...map.entries()].sort(([a], [b]) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.localeCompare(b);
    });
    return sorted;
  }, [visible, query, freeOnly, hasCapabilityFilter, activeResults]);

  return (
    <div>
      {/* Search + free-only toggle */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-1 max-w-sm">
          {semanticLoading ? (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-gray-700 dark:border-t-gray-300 animate-spin pointer-events-none" />
          ) : (
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <circle cx={11} cy={11} r={8} />
              <path d="m21 21-4.35-4.35" />
            </svg>
          )}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, or describe what you need…"
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:border-gray-400 dark:focus:border-gray-500 focus:outline-none transition-colors placeholder:text-gray-400 dark:placeholder:text-gray-600"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400 text-lg leading-none"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
        <button
          onClick={() => setFreeOnly((v) => !v)}
          className={`text-xs px-3 py-2 rounded-lg border transition-colors font-medium ${
            freeOnly
              ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-[#0a0a0a]"
              : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500"
          }`}
        >
          Free only
        </button>
        <p className="text-xs text-gray-400 dark:text-gray-500 ml-auto shrink-0">
          {visible.length} agent{visible.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Semantic mode indicator */}
      <div className="mb-6 h-4">
        {activeResults && !semanticLoading && (
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <span className="w-1.5 h-1.5 rounded-full bg-violet-500" />
            Semantic results — ranked by meaning, not keywords
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-24 border border-dashed border-gray-200 dark:border-gray-700 rounded-2xl">
          <p className="text-gray-400 dark:text-gray-500 text-sm mb-4">No agents match your search.</p>
          <button
            onClick={() => { setQuery(""); setFreeOnly(false); }}
            className="text-sm text-gray-900 dark:text-white underline hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            Clear filters →
          </button>
        </div>
      ) : grouped ? (
        // Category-grouped view
        <div className="space-y-12">
          {grouped.map(([category, categoryAgents], catIdx) => (
            <div key={category} style={{ animation: `fade-up 0.5s ease ${catIdx * 80}ms both` }}>
              <div className="flex items-center gap-3 mb-5">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-white uppercase tracking-wider">
                  {category}
                </h2>
                <span className="text-xs text-gray-400 dark:text-gray-500">{categoryAgents.length} agent{categoryAgents.length !== 1 ? "s" : ""}</span>
                <div className="flex-1 h-px bg-gray-100 dark:bg-gray-800" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {categoryAgents.map((agent, i) => (
                  <AgentCard key={agent.agentId} agent={agent} index={i} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        // Flat view (when searching or filtering by capability)
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((agent, i) => (
            <AgentCard key={agent.agentId} agent={agent} index={i} />
          ))}
        </div>
      )}
    </div>
  );
}
