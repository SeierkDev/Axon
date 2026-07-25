import { describe, it, expect } from "vitest";
import { createAgent } from "@/lib/agents";
import { createBudget } from "@/lib/budgets";
import { selectAgent, rankAgents } from "@/lib/routing";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let n = 0;

// reputation drives the Proof Score fallback (×100) when proof_score is unset,
// so it's how these tests control ranking.
function mk(cap: string, reputation: number, price?: string): Agent {
  n++;
  const a: Agent = {
    agentId: `route-${n}`,
    name: `Route ${n}`,
    capabilities: [cap],
    publicKey: `pk-${n}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation,
    price,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

describe("routing — Phase 11 auto-routing", () => {
  it("picks the highest-Proof agent for a capability", () => {
    const cap = `rt-pick-${n}`;
    mk(cap, 3, "0.10 USDC");
    const best = mk(cap, 9, "0.10 USDC");
    mk(cap, 6, "0.10 USDC");
    const r = selectAgent({ capability: cap });
    expect(r?.agent.agentId).toBe(best.agentId);
    expect(r?.considered).toBe(3);
    expect(r?.reason).toContain("Proof");
  });

  it("prefers the cheaper agent when Proof is equal", () => {
    const cap = `rt-price-${n}`;
    const cheap = mk(cap, 7, "0.05 USDC");
    mk(cap, 7, "0.50 USDC");
    expect(selectAgent({ capability: cap })?.agent.agentId).toBe(cheap.agentId);
  });

  it("skips agents in the exclude list", () => {
    const cap = `rt-excl-${n}`;
    const top = mk(cap, 9, "0.10 USDC");
    const second = mk(cap, 8, "0.10 USDC");
    expect(selectAgent({ capability: cap, exclude: [top.agentId] })?.agent.agentId).toBe(second.agentId);
  });

  it("honours the paying agent's budget allow-list", () => {
    const cap = `rt-budget-${n}`;
    mk(cap, 9, "0.10 USDC"); // higher Proof, but not on the allow-list
    const allowed = mk(cap, 5, "0.10 USDC");
    const payer = mk(`rt-payer-${n}`, 0);
    createBudget({ agentId: payer.agentId, allowedToAgents: [allowed.agentId] });
    expect(selectAgent({ capability: cap, fromAgent: payer.agentId })?.agent.agentId).toBe(allowed.agentId);
  });

  it("returns null when nothing matches", () => {
    expect(selectAgent({ capability: "no-such-capability-xyz-123" })).toBeNull();
  });

  it("never routes to a gateway-provider agent (the worker can't drive them)", () => {
    const cap = `rt-gw-${n}`;
    const gw = mk(cap, 9, "0.10 USDC");     // highest Proof, but a gateway provider
    const normal = mk(cap, 5, "0.10 USDC");
    getDb()
      .prepare("INSERT INTO gateway_providers (provider_id, name, endpoint, created_at) VALUES (?, ?, ?, ?)")
      .run(gw.agentId, "GW", "http://x", new Date().toISOString());
    // Escrowing a balance hire to a gateway agent would lock funds forever, so it
    // must be excluded from routing despite ranking highest.
    expect(selectAgent({ capability: cap })?.agent.agentId).toBe(normal.agentId);
  });

  it("rankAgents returns candidates best-first", () => {
    const cap = `rt-rank-${n}`;
    mk(cap, 4, "0.10 USDC");
    mk(cap, 9, "0.10 USDC");
    mk(cap, 6, "0.10 USDC");
    const ranked = rankAgents({ capability: cap });
    expect(ranked.length).toBe(3);
    expect(ranked[0].proofScore).toBeGreaterThanOrEqual(ranked[1].proofScore);
    expect(ranked[1].proofScore).toBeGreaterThanOrEqual(ranked[2].proofScore);
  });

  it("assembles a free-agent panel best-first (quorum-by-default)", () => {
    const cap = `rt-panel-${n}`;
    mk(cap, 9); // free
    mk(cap, 8); // free
    mk(cap, 4, "0.10 USDC"); // priced — excluded from a free quorum panel
    const panel = rankAgents({ capability: cap }).filter((c) => !c.agent.price).map((c) => c.agent.agentId);
    expect(panel.length).toBe(2);
  });
});
