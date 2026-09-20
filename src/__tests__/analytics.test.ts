// Tests for src/lib/analytics.ts
// Covers both the zero-activity path and the active-network path (successRate > 0 branch).

import { describe, it, expect } from "vitest";
import { getNetworkStats, getDailyStats, getAllTimeLeaders } from "@/lib/analytics";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { createTask, startTask, completeTask, failTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
let seq = 0;
function uid() { return `ana-${++seq}`; }

function makeAgent(): Agent {
  const id = uid();
  return {
    agentId: id, name: `Analytics Agent ${id}`,
    capabilities: ["research"], publicKey: `pk-${id}`,
    walletAddress: WALLET, provider: "anthropic",
    reputation: 0, createdAt: new Date().toISOString(),
  };
}

// ── getNetworkStats ───────────────────────────────────────────────────────────

describe("getNetworkStats: structure", () => {
  it("returns the expected top-level keys", () => {
    const stats = getNetworkStats();
    expect(stats).toHaveProperty("agents");
    expect(stats).toHaveProperty("tasks");
    expect(stats).toHaveProperty("payments");
    expect(stats).toHaveProperty("topAgents");
    expect(stats).toHaveProperty("topCapabilities");
    expect(stats).toHaveProperty("activityByDay");
  });

  it("activityByDay contains 7 entries covering the last 7 days", () => {
    const stats = getNetworkStats();
    expect(stats.activityByDay).toHaveLength(7);
  });
});

describe("getNetworkStats: successRate > 0 branch", () => {
  it("computes successRate > 0 when there are completed and failed tasks", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    // 2 completed tasks
    for (let i = 0; i < 2; i++) {
      const t = createTask({ fromAgent: a.agentId, toAgent: b.agentId, task: "work" });
      startTask(t.taskId);
      completeTask(t.taskId, "done");
    }
    // 1 failed task
    const ft = createTask({ fromAgent: a.agentId, toAgent: b.agentId, task: "fail" });
    startTask(ft.taskId);
    failTask(ft.taskId, "error");

    const stats = getNetworkStats();
    // settled = 3, completed = 2 → successRate = 2/3 ≈ 0.667
    expect(stats.tasks.successRate).toBeGreaterThan(0);
    expect(stats.tasks.successRate).toBeLessThanOrEqual(1);
    expect(stats.tasks.completed).toBeGreaterThanOrEqual(2);
    expect(stats.tasks.failed).toBeGreaterThanOrEqual(1);
  });
});

// ── getDailyStats ─────────────────────────────────────────────────────────────

describe("getDailyStats", () => {
  it("returns N entries for the requested number of days", () => {
    const stats = getDailyStats(7);
    expect(stats).toHaveLength(7);
    expect(stats[0]).toHaveProperty("date");
    expect(stats[0]).toHaveProperty("tasksCompleted");
    expect(stats[0]).toHaveProperty("tasksFailed");
    expect(stats[0]).toHaveProperty("ethTransacted");
    expect(stats[0]).toHaveProperty("newAgents");
  });

  it("returns 30 entries by default", () => {
    expect(getDailyStats()).toHaveLength(30);
  });
});

// ── getAllTimeLeaders ─────────────────────────────────────────────────────────

describe("getAllTimeLeaders", () => {
  it("returns topEarners and topWorkers arrays", () => {
    const leaders = getAllTimeLeaders();
    expect(Array.isArray(leaders.topEarners)).toBe(true);
    expect(Array.isArray(leaders.topWorkers)).toBe(true);
  });
});

// ── Reporting denomination ────────────────────────────────────────────────────
//
// The ledger reaches back past the move to this chain, and the rows from before it sit in the
// same amount column as everything since. Summed without a currency filter, an old amount is
// restated as ETH: at the time this test was written that turned a handful of pre-move rows into
// a headline "21 ETH transacted" on the public homepage. Nothing about that number was true.
//
// So: a row in another denomination is left out of the ETH figures entirely. Not converted —
// there is no honest rate to convert it at.

describe("ETH totals only count ETH", () => {
  const settled = (currency: string, amount: number) => {
    const id = `cur-${++seq}`;
    getDb()
      .prepare(
        `INSERT INTO transactions
           (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature,
            fee_amount, currency, created_at, settled_at)
         VALUES (?, NULL, ?, ?, ?, 'completed', NULL, 0, ?, ?, ?)`,
      )
      .run(id, `${id}-from`, `${id}-to`, amount, currency, new Date().toISOString(), new Date().toISOString());
  };

  it("leaves a pre-move row out of the transacted total instead of restating it as ETH", () => {
    const before = getNetworkStats().payments.totalEthTransacted;

    settled("USDC", 21);
    expect(getNetworkStats().payments.totalEthTransacted).toBeCloseTo(before, 9);

    settled("ETH", 0.0002);
    expect(getNetworkStats().payments.totalEthTransacted).toBeCloseTo(before + 0.0002, 9);
  });

  it("keeps the same rule on the all-time earnings leaderboard", () => {
    const agent = makeAgent();
    createAgent(agent);
    const db = getDb();
    const row = (currency: string, amount: number) =>
      db
        .prepare(
          `INSERT INTO transactions
             (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature,
              fee_amount, currency, created_at, settled_at)
           VALUES (?, NULL, 'someone', ?, ?, 'completed', NULL, 0, ?, ?, ?)`,
        )
        .run(`lead-${++seq}`, agent.agentId, amount, currency, new Date().toISOString(), new Date().toISOString());

    row("USDC", 500);
    row("ETH", 0.0003);

    const earned = getAllTimeLeaders().topEarners.find((e) => e.agentId === agent.agentId);
    // A 500-unit pre-move row would have put this agent at the top of the board. Either it is
    // absent (outranked by ETH earners) or it is present at its ETH total — never at 500.
    if (earned) expect(earned.totalEarnedEth).toBeCloseTo(0.0003, 9);
    expect(getAllTimeLeaders().topEarners.every((e) => e.totalEarnedEth < 500)).toBe(true);
  });
});

// ── Which rate is which ───────────────────────────────────────────────────────
//
// The headline rate became a rolling window, and the all-time figure stayed in the payload
// beside it. A page that reaches for the wrong one prints a number that contradicts the counts
// printed directly above it: the analytics page showed "all-time success rate 99%" over a table
// reading 19,145 completed of 25,996.

describe("the two success rates stay distinct", () => {
  it("reports all-time from all of history, whatever the window says", () => {
    const db = getDb();
    db.prepare("DELETE FROM tasks").run();
    const at = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    const add = (status: string, hoursAgo: number, n: number) => {
      const ins = db.prepare(
        `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, completed_at, created_at)
         VALUES (?, 'a', 'b', 't', ?, ?, ?)`,
      );
      for (let i = 0; i < n; i++) ins.run(`rate-${++seq}`, status, at(hoursAgo), at(hoursAgo));
    };

    add("failed", 400, 700); // a bad stretch, long ago and outside any window
    add("completed", 400, 300);
    add("completed", 2, 40); // a good present, inside the window

    const t = getNetworkStats().tasks;
    expect(t.successRate).toBeGreaterThan(0.9); // the window: healthy
    expect(t.allTimeSuccessRate).toBeCloseTo(340 / 1040, 2); // all of it: not
    expect(t.allTimeSuccessRate).toBeLessThan(t.successRate);
  });
});
