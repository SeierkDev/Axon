// Tests for src/lib/analytics.ts
// Covers both the zero-activity path and the active-network path (successRate > 0 branch).

import { describe, it, expect } from "vitest";
import { getNetworkStats, getDailyStats, getAllTimeLeaders } from "@/lib/analytics";
import { createAgent } from "@/lib/agents";
import { createTask, startTask, completeTask, failTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
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
    expect(stats[0]).toHaveProperty("usdcTransacted");
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
