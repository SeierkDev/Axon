import { describe, it, expect } from "vitest";
import { computeReputation, recomputeAllReputations } from "@/lib/reputation";
import { createAgent } from "@/lib/agents";
import { createTask, startTask, completeTask, failTask } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";
import type { Agent } from "@/sdk/types";

const TEST_WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `rep-${counter}`,
    name: `Rep Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Create a completed task and set the started_at timestamp to make it appear
// as if it took `seconds` to complete.
function createTimedTask(worker: Agent, seconds: number) {
  const sender = makeAgent();
  createAgent(sender);
  const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "timed work" });
  startTask(task.taskId);
  completeTask(task.taskId, "done");
  getDb()
    .prepare("UPDATE tasks SET started_at = datetime(completed_at, ? || ' seconds') WHERE task_id = ?")
    .run(`-${seconds}`, task.taskId);
  return task;
}

// ── responseTimeScore branches ─────────────────────────────────────────────────

describe("computeReputation: response time score", () => {
  it("scores 0 for very slow response time (>= 120s)", () => {
    const worker = makeAgent();
    createAgent(worker);
    createTimedTask(worker, 125); // 125 second response — exceeds RESPONSE_SLOW_SEC

    const metrics = computeReputation(worker.agentId);
    expect(metrics.responseTimeScore).toBe(0);
    expect(metrics.avgResponseTimeSec).toBeGreaterThanOrEqual(120);
  });

  it("scores between 0 and 1 for medium response time (5s < t < 120s)", () => {
    const worker = makeAgent();
    createAgent(worker);
    createTimedTask(worker, 60); // 60 seconds — between fast and slow

    const metrics = computeReputation(worker.agentId);
    expect(metrics.responseTimeScore).toBeGreaterThan(0);
    expect(metrics.responseTimeScore).toBeLessThan(1);
    expect(metrics.avgResponseTimeSec).toBeGreaterThan(5);
    expect(metrics.avgResponseTimeSec).toBeLessThan(120);
  });
});

// ── successRate branches ───────────────────────────────────────────────────────

describe("computeReputation: successRate", () => {
  it("returns successRate=0 and totalTasks=0 for a fresh agent with no tasks", () => {
    const worker = makeAgent();
    createAgent(worker);
    // No tasks created — covers the totalTasks > 0 false branch (successRate = 0)
    const metrics = computeReputation(worker.agentId);
    expect(metrics.successRate).toBe(0);
    expect(metrics.totalTasks).toBe(0);
    expect(metrics.totalTasksCompleted).toBe(0);
    expect(metrics.totalTasksFailed).toBe(0);
  });

  it("computes successRate < 1 when the agent has both completed and failed tasks", () => {
    const worker = makeAgent();
    const sender = makeAgent();
    createAgent(worker);
    createAgent(sender);

    // One completed task
    const t1 = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "pass" });
    startTask(t1.taskId);
    completeTask(t1.taskId, "done");

    // One failed task
    const t2 = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "fail" });
    startTask(t2.taskId);
    failTask(t2.taskId, "error");

    const metrics = computeReputation(worker.agentId);
    expect(metrics.totalTasks).toBe(2);
    expect(metrics.totalTasksCompleted).toBe(1);
    expect(metrics.totalTasksFailed).toBe(1);
    expect(metrics.successRate).toBe(0.5);
  });
});

// ── paymentReliability branches ───────────────────────────────────────────────

describe("computeReputation: paymentReliability with paid tasks", () => {
  it("uses paidCompleted/paidTotal when a task has an associated transaction", () => {
    const worker = makeAgent();
    const sender = makeAgent();
    createAgent(worker);
    createAgent(sender);

    // Create a completed task
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "paid work" });
    startTask(task.taskId);
    completeTask(task.taskId, "result");

    // Link a transaction to this task (simulates a payment flow)
    getDb().prepare(`
      INSERT INTO transactions
        (tx_id, task_id, from_agent, to_agent, amount_sol, fee_amount, currency, status, incoming_signature, created_at)
      VALUES (?, ?, ?, ?, 1.0, 0, 'USDC', 'completed', NULL, ?)
    `).run(randomUUID(), task.taskId, sender.agentId, worker.agentId, new Date().toISOString());

    const metrics = computeReputation(worker.agentId);
    // paidTotal = 1, paidCompleted = 1 → paymentReliability = 1.0
    expect(metrics.paymentReliability).toBe(1.0);
  });
});

// ── reviewScore branch ─────────────────────────────────────────────────────────

describe("computeReputation: reviewScore with a review", () => {
  it("incorporates a star rating into the reputation score when reviews exist", () => {
    const worker = makeAgent();
    const reviewer = makeAgent();
    createAgent(worker);
    createAgent(reviewer);

    // Insert a 5-star review directly — covers reviewRow.avg_rating !== null branch
    getDb().prepare(`
      INSERT INTO reviews (review_id, agent_id, reviewer_id, rating, comment, created_at)
      VALUES (?, ?, ?, 5, 'excellent', ?)
    `).run(randomUUID(), worker.agentId, reviewer.agentId, new Date().toISOString());

    const metrics = computeReputation(worker.agentId);
    // reviewScore = (5 - 1) / 4 = 1.0 → contributes to reputation
    expect(metrics.reputation).toBeGreaterThan(0);
  });
});

// ── staleness decay (Phase 6: Marketplace Trust Layer) ──────────────────────────

describe("computeReputation: staleness decay", () => {
  it("does not decay a recently active agent (within the grace window)", () => {
    const worker = makeAgent();
    createAgent(worker);
    createTimedTask(worker, 10); // completed just now

    const metrics = computeReputation(worker.agentId);
    expect(metrics.decayFactor).toBe(1);
    expect(metrics.staleDays).not.toBeNull();
    expect(metrics.staleDays as number).toBeLessThanOrEqual(1);
  });

  it("applies no decay to an agent with no completed tasks", () => {
    const worker = makeAgent();
    createAgent(worker);

    const metrics = computeReputation(worker.agentId);
    expect(metrics.staleDays).toBeNull();
    expect(metrics.decayFactor).toBe(1);
  });

  it("decays a long-stale agent to the floor, below an identical fresh agent", () => {
    const fresh = makeAgent();
    createAgent(fresh);
    createTimedTask(fresh, 10);
    const freshRep = computeReputation(fresh.agentId).reputation;

    const stale = makeAgent();
    createAgent(stale);
    const task = createTimedTask(stale, 10);
    // Backdate the completed task ~200 days into the past (well past grace+span).
    getDb()
      .prepare(
        "UPDATE tasks SET completed_at = datetime('now', '-200 days'), started_at = datetime('now', '-200 days', '-10 seconds') WHERE task_id = ?",
      )
      .run(task.taskId);

    const metrics = computeReputation(stale.agentId);
    expect(metrics.staleDays as number).toBeGreaterThan(120);
    expect(metrics.decayFactor).toBeCloseTo(0.6, 3); // DECAY_FLOOR
    // Same underlying stats, but decayed → strictly lower than the fresh agent.
    expect(metrics.reputation).toBeLessThan(freshRep);
  });

  it("recomputeAllReputations persists decay into the cached ranking column", () => {
    const stale = makeAgent();
    createAgent(stale);
    const task = createTimedTask(stale, 10);
    getDb()
      .prepare(
        "UPDATE tasks SET completed_at = datetime('now', '-200 days'), started_at = datetime('now', '-200 days', '-10 seconds') WHERE task_id = ?",
      )
      .run(task.taskId);
    // Simulate a stale cached score from when the agent was last active.
    getDb().prepare("UPDATE agents SET reputation = 9 WHERE agent_id = ?").run(stale.agentId);

    recomputeAllReputations();

    const row = getDb()
      .prepare("SELECT reputation FROM agents WHERE agent_id = ?")
      .get(stale.agentId) as { reputation: number };
    // Discovery ranks by this column — it now reflects the decayed value, not the
    // stale 9 it would otherwise have kept while the agent sat idle.
    expect(row.reputation).toBe(computeReputation(stale.agentId).reputation);
    expect(row.reputation).toBeLessThan(9);
  });
});
