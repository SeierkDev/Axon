import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getRecentTasks, getRecentSettlements, getExplorerFeed } from "@/lib/explorer";
import { createTask } from "@/lib/tasks";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let counter = 0;
function makeAgent(): Agent {
  counter++;
  const a: Agent = {
    agentId: `exp-${counter}`,
    name: `Explorer Agent ${counter}`,
    capabilities: ["x"],
    publicKey: `pk-exp-${counter}`,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

function settlement(from: string, to: string, amount: number): string {
  const txId = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at)
       VALUES (?, NULL, ?, ?, ?, 'completed', NULL, 0, 'USDC', ?, ?)`
    )
    .run(txId, from, to, amount, new Date().toISOString(), new Date().toISOString());
  return txId;
}

describe("network explorer", () => {
  it("returns recent tasks as metadata only (no task text or output)", () => {
    const a = makeAgent();
    const b = makeAgent();
    const task = createTask({ fromAgent: a.agentId, toAgent: b.agentId, task: "SECRET private task body" });

    const recent = getRecentTasks(10);
    const found = recent.find((t) => t.taskId === task.taskId);
    expect(found).toBeTruthy();
    expect(found!.fromAgent).toBe(a.agentId);
    expect(found!.toAgent).toBe(b.agentId);
    // Must NOT leak the task content/output.
    expect(JSON.stringify(found)).not.toContain("SECRET");
    expect(found).not.toHaveProperty("task");
    expect(found).not.toHaveProperty("output");
  });

  it("returns recent settlements with amount/status/currency", () => {
    const a = makeAgent();
    const b = makeAgent();
    const txId = settlement(a.agentId, b.agentId, 0.25);
    const recent = getRecentSettlements(10);
    const found = recent.find((s) => s.txId === txId);
    expect(found).toBeTruthy();
    expect(found!.amount).toBe(0.25);
    expect(found!.currency).toBe("USDC");
    expect(found!.status).toBe("completed");
  });

  it("excludes 'split' bookkeeping rows from the settlements feed", () => {
    const a = makeAgent();
    const b = makeAgent();
    const taskId = randomUUID();
    // A split settlement: the escrow parent kept as 'split' + a 'completed' payout child.
    getDb()
      .prepare(
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at)
         VALUES (?, ?, ?, ?, 1.0, 'split', 'sig-x', 0, 'USDC', ?, ?)`
      )
      .run(randomUUID(), taskId, a.agentId, b.agentId, new Date().toISOString(), new Date().toISOString());
    const childTx = settlement(a.agentId, b.agentId, 1.0);

    const recent = getRecentSettlements(50);
    expect(recent.some((s) => s.txId === childTx)).toBe(true); // the actual payout shows
    expect(recent.some((s) => s.status === "split")).toBe(false); // the bookkeeping parent does not
  });

  it("clamps the limit and never throws on bad input", () => {
    expect(() => getRecentTasks(NaN)).not.toThrow();
    expect(getRecentTasks(-5).length).toBeLessThanOrEqual(1);
    expect(getRecentTasks(1000).length).toBeLessThanOrEqual(100);
  });

  it("assembles a feed with totals + recent activity", () => {
    const feed = getExplorerFeed(5);
    expect(feed.totals).toHaveProperty("agents");
    expect(feed.totals).toHaveProperty("usdcTransacted");
    expect(Array.isArray(feed.recentTasks)).toBe(true);
    expect(Array.isArray(feed.recentSettlements)).toBe(true);
    expect(feed.recentTasks.length).toBeLessThanOrEqual(5);
  });
});
