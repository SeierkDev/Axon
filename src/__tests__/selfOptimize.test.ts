import { describe, it, expect } from "vitest";
import { createAgent, getAgentById } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import { computeOptimization, applyOptimization } from "@/lib/selfOptimize";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let n = 0;
function mk(price?: string): Agent {
  n++;
  const a: Agent = {
    agentId: `opt-${n}`,
    name: `Opt ${n}`,
    capabilities: [`opt-cap-${n}`],
    publicKey: `pk-${n}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    price,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

function seed(agentId: string, status: "completed" | "failed", count: number) {
  const db = getDb();
  for (let i = 0; i < count; i++) {
    const t = createTask({ fromAgent: "buyer", toAgent: agentId, task: "t", initialStatus: "queued", queueQueuedWebhook: true });
    db.prepare("UPDATE tasks SET status = ?, completed_at = ? WHERE task_id = ?").run(status, new Date().toISOString(), t.taskId);
  }
}

describe("self-optimization — Phase 11", () => {
  it("raises the price when proven and in demand", () => {
    const a = mk("0.10 USDC");
    seed(a.agentId, "completed", 10);
    const o = computeOptimization(a.agentId)!;
    expect(o.action).toBe("raise");
    expect(o.suggestedPrice).toBe("0.12 USDC");
    expect(o.metrics.successRate).toBe(1);
  });

  it("lowers the price when the success rate is weak", () => {
    const a = mk("0.20 USDC");
    seed(a.agentId, "completed", 3);
    seed(a.agentId, "failed", 3);
    const o = computeOptimization(a.agentId)!;
    expect(o.action).toBe("lower");
    expect(o.suggestedPrice).toBe("0.16 USDC");
  });

  it("lowers a sub-cent price DOWN, never up (no floor inversion)", () => {
    const a = mk("0.005 USDC");
    seed(a.agentId, "completed", 3);
    seed(a.agentId, "failed", 3); // weak
    const o = computeOptimization(a.agentId)!;
    expect(o.action).toBe("lower");
    expect(o.suggestedPrice).toBe("0.004 USDC"); // 0.005*0.8, NOT rounded up to 0.01
  });

  it("holds a free-lane agent with no track record", () => {
    const a = mk();
    const o = computeOptimization(a.agentId)!;
    expect(o.action).toBe("hold");
    expect(o.currentPrice).toBeNull();
  });

  it("applyOptimization commits the new price", () => {
    const a = mk("0.10 USDC");
    seed(a.agentId, "completed", 10);
    const o = computeOptimization(a.agentId)!;
    applyOptimization(a.agentId, o.suggestedPrice);
    expect(getAgentById(a.agentId)?.price).toBe("0.12 USDC");
  });
});
