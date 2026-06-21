// Integration tests for the patterns used by src/workers/index.ts.
// The worker module calls main() on import and has no exports, so these tests
// exercise the DB invariants and task-lifecycle transitions it relies on.

import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import {
  createTask,
  startTask,
  completeTask,
  failTask,
  getTaskById,
  requeueTask,
} from "@/lib/tasks";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let seq = 0;
function uid() { return `wk-${++seq}`; }

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const id = uid();
  return {
    agentId: id,
    name: `Worker Agent ${id}`,
    capabilities: ["research"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── started_by tracking ───────────────────────────────────────────────────────

describe("startTask: started_by field", () => {
  it("records 'worker' as started_by when called from the worker", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "worker task" });
    const started = startTask(task.taskId, "worker");
    expect(started).not.toBeNull();
    expect(started!.startedBy).toBe("worker");
    expect(started!.status).toBe("running");
  });

  it("records 'api' as started_by when called from the API", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "api task" });
    const started = startTask(task.taskId, "api");
    expect(started!.startedBy).toBe("api");
  });

  it("returns null if the task is not in queued status", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "no double start" });
    startTask(task.taskId, "worker");
    expect(startTask(task.taskId, "worker")).toBeNull();
  });
});

// ── complete lifecycle: queued → running → completed ─────────────────────────

describe("worker task lifecycle: queued → running → completed", () => {
  it("transitions through all states correctly", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "lifecycle test" });

    expect(getTaskById(task.taskId)!.status).toBe("queued");

    startTask(task.taskId, "worker");
    expect(getTaskById(task.taskId)!.status).toBe("running");

    const completed = completeTask(task.taskId, "done output");
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");
    expect(completed!.output).toBe("done output");
    expect(completed!.completedAt).toBeTruthy();
  });
});

// ── failure lifecycle: queued → running → failed ─────────────────────────────

describe("worker task lifecycle: queued → running → failed", () => {
  it("fails a running task and records the error", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "will fail" });
    startTask(task.taskId, "worker");

    const failed = failTask(task.taskId, "Provider threw an exception");
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toBe("Provider threw an exception");
  });

  it("fails a queued task directly (worker can fail without starting)", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "direct fail" });

    const failed = failTask(task.taskId, "Fatal error before start");
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
  });
});

// ── stuck task recovery ───────────────────────────────────────────────────────
// SQL mirrors the exact re-queue pass in src/workers/index.ts.
// See worker-recovery.test.ts for dead-letter and multi-cycle coverage.

const TASK_TIMEOUT_MS = 600_000; // 10 min — matches AXON_TASK_TIMEOUT_MS default
const MAX_STUCK_RESETS = 3;

function workerStuckCutoff() {
  return new Date(Date.now() - TASK_TIMEOUT_MS).toISOString();
}

function runWorkerRequeue(cutoff: string) {
  getDb()
    .prepare(
      "UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL, stuck_count=stuck_count+1 WHERE status='running' AND started_by='worker' AND started_at < ? AND stuck_count < ?"
    )
    .run(cutoff, MAX_STUCK_RESETS);
}

describe("stuck task recovery", () => {
  it("resets running worker tasks older than the task timeout back to queued", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "stuck task" });
    startTask(task.taskId, "worker");

    getDb()
      .prepare("UPDATE tasks SET started_at = ? WHERE task_id = ?")
      .run(new Date(Date.now() - TASK_TIMEOUT_MS - 60_000).toISOString(), task.taskId);

    runWorkerRequeue(workerStuckCutoff());

    const recovered = getTaskById(task.taskId)!;
    expect(recovered.status).toBe("queued");
    expect(recovered.startedAt).toBeUndefined();
    expect(recovered.startedBy).toBeUndefined();
    expect(recovered.stuckCount).toBe(1);
  });

  it("does NOT reset tasks started by the API — only worker-claimed tasks are recovered", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "api-started running" });
    startTask(task.taskId, "api");

    getDb()
      .prepare("UPDATE tasks SET started_at = ? WHERE task_id = ?")
      .run(new Date(Date.now() - TASK_TIMEOUT_MS - 60_000).toISOString(), task.taskId);

    runWorkerRequeue(workerStuckCutoff());

    const unchanged = getTaskById(task.taskId)!;
    expect(unchanged.status).toBe("running");
    expect(unchanged.startedBy).toBe("api");
  });
});

// ── requeueTask ───────────────────────────────────────────────────────────────

describe("requeueTask: failed task recovery", () => {
  it("resets a failed task to queued so the worker can retry it", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "retry after fail" });
    startTask(task.taskId, "worker");
    failTask(task.taskId, "transient error");

    const requeued = requeueTask(task.taskId);
    expect(requeued).not.toBeNull();
    expect(requeued!.status).toBe("queued");
  });

  it("returns null if the task is not in failed state", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "not failed" });
    expect(requeueTask(task.taskId)).toBeNull();
  });
});

// ── stuck task recovery edge cases ───────────────────────────────────────────

describe("stuck task recovery: task under the timeout threshold is NOT reset", () => {
  it("leaves a running task untouched when it started less than the timeout ago", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "recent task" });
    startTask(task.taskId, "worker");

    // Backdate by half the timeout — still within the recovery window
    getDb()
      .prepare("UPDATE tasks SET started_at = ? WHERE task_id = ?")
      .run(new Date(Date.now() - TASK_TIMEOUT_MS / 2).toISOString(), task.taskId);

    runWorkerRequeue(workerStuckCutoff());

    const unchanged = getTaskById(task.taskId)!;
    expect(unchanged.status).toBe("running");
    expect(unchanged.startedBy).toBe("worker");
  });
});

describe("stuck task recovery: payment_pending tasks are immune to recovery SQL", () => {
  it("leaves a payment_pending task untouched by the worker stuck-recovery SQL", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({
      fromAgent: a.agentId,
      toAgent: a.agentId,
      task: "pending payment",
      initialStatus: "payment_pending",
    });

    runWorkerRequeue(workerStuckCutoff());

    expect(getTaskById(task.taskId)!.status).toBe("payment_pending");
  });
});

describe("stuck task recovery: completed and failed tasks are never reset", () => {
  it("leaves a completed task with an old started_at completely untouched", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "done" });
    startTask(task.taskId, "worker");
    completeTask(task.taskId, "result");

    getDb()
      .prepare("UPDATE tasks SET started_at = ? WHERE task_id = ?")
      .run(new Date(Date.now() - TASK_TIMEOUT_MS * 2).toISOString(), task.taskId);

    runWorkerRequeue(workerStuckCutoff());

    expect(getTaskById(task.taskId)!.status).toBe("completed");
  });

  it("leaves a failed task with an old started_at completely untouched", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "failed" });
    startTask(task.taskId, "worker");
    failTask(task.taskId, "crashed");

    getDb()
      .prepare("UPDATE tasks SET started_at = ? WHERE task_id = ?")
      .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), task.taskId);

    const stuckCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    getDb()
      .prepare(
        "UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL WHERE status='running' AND started_by='worker' AND started_at < ?"
      )
      .run(stuckCutoff);

    expect(getTaskById(task.taskId)!.status).toBe("failed");
  });
});

// ── gateway task exclusion ────────────────────────────────────────────────────

describe("gateway provider exclusion", () => {
  it("gateway provider IDs are in the gateway_providers table and can be queried", () => {
    const a = makeAgent();
    createAgent(a);

    // Insert a gateway provider directly (simulating createGatewayProvider without importing gateway.ts)
    const providerId = `gw-${uid()}`;
    getDb().prepare(`
      INSERT INTO gateway_providers
        (provider_id, name, endpoint, method, forward_headers, inject_headers,
         price_per_call, timeout_ms, status, created_at)
      VALUES (?, 'Test GW', 'https://gw.example.com/', 'POST', '[]', '{}', '0.10 USDC', 30000, 'active', ?)
    `).run(providerId, new Date().toISOString());

    // The worker excludes gateway provider IDs using this query
    const gatewayIds = new Set(
      (getDb().prepare("SELECT provider_id FROM gateway_providers").all() as { provider_id: string }[])
        .map((r) => r.provider_id)
    );

    expect(gatewayIds.has(providerId)).toBe(true);
  });
});
