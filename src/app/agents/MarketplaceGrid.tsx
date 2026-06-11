"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Agent } from "@/sdk/types";

function formatPrice(price?: string) {
  return price?.trim() || "Free";
}

function listingMode(agent: Agent) {
  if (agent.endpoint) return "External endpoint";
  if (agent.provider === "ollama") return "Self-hosted model";
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
  if (!agent.endpoint) return "Hosted route";
  if (agent.verificationStatus === "x402_compliant") return "x402 verified";
  if (agent.verificationStatus === "reachable") return "Endpoint reachable";
  if (agent.verificationStatus === "unreachable") return "Endpoint offline";
  return "Unverified endpoint";
}

function healthDot(agent: Agent): string {
  if (agent.verificationStatus === "platform") return "bg-green-400";
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
      className="block p-5 rounded-xl border border-gray-200 bg-white hover:border-gray-400 hover:shadow-sm transition-all group"
      style={{ animation: `fade-up 0.5s ease ${index * 60}ms both` }}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1">
            {listingMode(agent)}
          </p>
          <h3 className="font-semibold text-gray-900 group-hover:text-gray-700 transition-colors">
            {agent.name}
          </h3>
          <p className="text-xs font-mono text-gray-400 mt-0.5">{agent.agentId}</p>
        </div>
        <span className="text-xs font-mono text-gray-600 bg-gray-50 border border-gray-200 px-2 py-1 rounded-md shrink-0">
          {price}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {agent.capabilities.map((cap) => (
          <span key={cap} className="text-[11px] px-2 py-0.5 rounded-md bg-gray-50 border border-gray-100 text-gray-500">
            {cap}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 mb-4 text-xs">
        <div>
          <p className="text-gray-400 text-[11px]">Reputation</p>
          <p className="font-semibold text-gray-900 mt-0.5">
            {reputation > 0 ? reputation.toFixed(1) : "New"}
          </p>
        </div>
        <div>
          <p className="text-gray-400 text-[11px]">Market signal</p>
          <p className="font-semibold text-gray-900 mt-0.5">{trustLevel(reputation)}</p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs text-gray-400 border-t border-gray-50 pt-3">
        <span className="flex items-center gap-1.5 truncate">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${healthDot(agent)}`} />
          {paymentLabel(agent)} · {verificationLabel(agent)}
        </span>
        <span className="group-hover:text-gray-600 transition-colors shrink-0">Send task →</span>
      </div>
    </Link>
  );
}

interface Props {
  agents: Agent[];
  hasCapabilityFilter: boolean;
}

const CATEGORY_ORDER = ["Research", "Development", "Finance", "Content", "General"];

export function MarketplaceGrid({ agents, hasCapabilityFilter }: Props) {
  const [query, setQuery] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);

  const visible = useMemo(() => {
    let result = agents;
    if (freeOnly) result = result.filter((a) => !a.price?.trim());
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      result = result.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.agentId.toLowerCase().includes(q) ||
          a.capabilities.some((c) => c.toLowerCase().includes(q)) ||
          (a.category ?? "").toLowerCase().includes(q)
      );
    }
    return result;
  }, [agents, query, freeOnly]);

  // Group by category unless user is searching/filtering
  const grouped = useMemo(() => {
    if (query.trim() || freeOnly || hasCapabilityFilter) return null;
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
  }, [visible, query, freeOnly, hasCapabilityFilter]);

  return (
    <div>
      {/* Search + free-only toggle */}
      <div className="flex items-center gap-3 mb-8">
        <div className="relative flex-1 max-w-sm">
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
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, capability…"
            className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:border-gray-400 focus:outline-none transition-colors placeholder:text-gray-400"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600 text-lg leading-none"
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
              ? "border-gray-900 bg-gray-900 text-white"
              : "border-gray-200 text-gray-500 hover:border-gray-400"
          }`}
        >
          Free only
        </button>
        <p className="text-xs text-gray-400 ml-auto shrink-0">
          {visible.length} agent{visible.length !== 1 ? "s" : ""}
        </p>
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-24 border border-dashed border-gray-200 rounded-2xl">
          <p className="text-gray-400 text-sm mb-4">No agents match your search.</p>
          <button
            onClick={() => { setQuery(""); setFreeOnly(false); }}
            className="text-sm text-gray-900 underline hover:text-gray-600 transition-colors"
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
                <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">
                  {category}
                </h2>
                <span className="text-xs text-gray-400">{categoryAgents.length} agent{categoryAgents.length !== 1 ? "s" : ""}</span>
                <div className="flex-1 h-px bg-gray-100" />
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
