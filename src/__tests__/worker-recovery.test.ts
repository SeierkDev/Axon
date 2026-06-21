// Worker recovery tests — Phase 5 step 5.
//
// Simulates what happens when the worker restarts mid-task: running tasks left
// behind get stuck, and the worker's poll loop must recover them. Covers the
// dead-letter path (stuck_count reaches MAX_STUCK_RESETS) and the normal
// re-queue path (stuck_count still under the limit).

import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import {
  createTask,
  startTask,
  failTask,
  getTaskById,
  requeueTask,
} from "@/lib/tasks";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let seq = 0;
function uid() { return `wr-${++seq}`; }

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const id = uid();
  return {
    agentId: id,
    name: `Recovery Agent ${id}`,
    capabilities: ["research"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const MAX_STUCK_RESETS = 3;
const TASK_TIMEOUT_MS = 600_000; // 10 min — matches AXON_TASK_TIMEOUT_MS default

// Backdate started_at so the task appears stuck past the timeout
function makeStuck(taskId: string, msAgo = TASK_TIMEOUT_MS + 60_000) {
  getDb()
    .prepare("UPDATE tasks SET started_at = ? WHERE task_id = ?")
    .run(new Date(Date.now() - msAgo).toISOString(), taskId);
}

// The two SQL statements the worker runs each poll cycle
function runDeadLetterPass(stuckCutoff: string) {
  return getDb()
    .prepare(
      "SELECT task_id FROM tasks WHERE status='running' AND started_by='worker' AND started_at < ? AND stuck_count >= ?"
    )
    .all(stuckCutoff, MAX_STUCK_RESETS) as { task_id: string }[];
}

function runRequeuePass(stuckCutoff: string) {
  return getDb()
    .prepare(
      "UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL, stuck_count=stuck_count+1 WHERE status='running' AND started_by='worker' AND started_at < ? AND stuck_count < ?"
    )
    .run(stuckCutoff, MAX_STUCK_RESETS).changes;
}

function stuckCutoff() {
  return new Date(Date.now() - TASK_TIMEOUT_MS).toISOString();
}

// ── Basic stuck reset ─────────────────────────────────────────────────────────

describe("worker recovery: basic stuck reset", () => {
  it("re-queues a stuck worker task and increments stuck_count to 1", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "stuck once" });
    startTask(task.taskId, "worker");
    makeStuck(task.taskId);

    const dead = runDeadLetterPass(stuckCutoff());
    expect(dead.map(r => r.task_id)).not.toContain(task.taskId); // not at limit yet

    runRequeuePass(stuckCutoff());

    const recovered = getTaskById(task.taskId)!;
    expect(recovered.status).toBe("queued");
    expect(recovered.startedAt).toBeUndefined();
    expect(recovered.startedBy).toBeUndefined();
    expect(recovered.stuckCount).toBe(1);
  });

  it("does not reset api-started tasks — only worker-claimed tasks are recovered", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "api started" });
    startTask(task.taskId, "api");
    makeStuck(task.taskId);

    runRequeuePass(stuckCutoff());

    const unchanged = getTaskById(task.taskId)!;
    expect(unchanged.status).toBe("running");
    expect(unchanged.startedBy).toBe("api");
    expect(unchanged.stuckCount).toBe(0);
  });

  it("does not reset a running task that has not yet timed out", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "fresh task" });
    startTask(task.taskId, "worker");
    // started_at is fresh — do NOT backdate

    runRequeuePass(stuckCutoff());

    expect(getTaskById(task.taskId)!.status).toBe("running");
    expect(getTaskById(task.taskId)!.stuckCount).toBe(0);
  });
});

// ── Incremental stuck_count across multiple crashes ───────────────────────────

describe("worker recovery: stuck_count increments across multiple restarts", () => {
  it("increments stuck_count on each recovery cycle", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "multi-stuck" });
    startTask(task.taskId, "worker");

    for (let i = 1; i < MAX_STUCK_RESETS; i++) {
      makeStuck(task.taskId);
      runRequeuePass(stuckCutoff());

      const t = getTaskById(task.taskId)!;
      expect(t.status).toBe("queued");
      expect(t.stuckCount).toBe(i);

      // Worker picks it up again for the next cycle
      startTask(task.taskId, "worker");
    }

    // stuck_count is now MAX_STUCK_RESETS - 1, one more cycle should dead-letter
    expect(getTaskById(task.taskId)!.stuckCount).toBe(MAX_STUCK_RESETS - 1);
  });
});

// ── Dead-letter path ──────────────────────────────────────────────────────────

describe("worker recovery: dead-letter after max resets", () => {
  it("selects a task for dead-lettering once stuck_count reaches MAX_STUCK_RESETS", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "will dead-letter" });
    startTask(task.taskId, "worker");

    // Set stuck_count to MAX_STUCK_RESETS directly (simulates N prior recoveries)
    getDb()
      .prepare("UPDATE tasks SET stuck_count = ? WHERE task_id = ?")
      .run(MAX_STUCK_RESETS, task.taskId);
    makeStuck(task.taskId);

    const dead = runDeadLetterPass(stuckCutoff());
    expect(dead.map(r => r.task_id)).toContain(task.taskId);
  });

  it("does NOT re-queue a task that is already at the dead-letter limit", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "no more retries" });
    startTask(task.taskId, "worker");

    getDb()
      .prepare("UPDATE tasks SET stuck_count = ? WHERE task_id = ?")
      .run(MAX_STUCK_RESETS, task.taskId);
    makeStuck(task.taskId);

    // re-queue pass must skip this task (stuck_count >= limit)
    const changes = runRequeuePass(stuckCutoff());
    expect(changes).toBe(0);
    expect(getTaskById(task.taskId)!.status).toBe("running"); // still running until failTask
  });

  it("full cycle: task reaches dead-letter limit and is failed via failTask", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "full dead-letter" });
    startTask(task.taskId, "worker");

    getDb()
      .prepare("UPDATE tasks SET stuck_count = ? WHERE task_id = ?")
      .run(MAX_STUCK_RESETS, task.taskId);
    makeStuck(task.taskId);

    const dead = runDeadLetterPass(stuckCutoff());
    expect(dead.map(r => r.task_id)).toContain(task.taskId);

    failTask(task.taskId, `Task dead-lettered after ${MAX_STUCK_RESETS} stuck resets`);

    const t = getTaskById(task.taskId)!;
    expect(t.status).toBe("failed");
    expect(t.error).toContain("dead-lettered");
  });
});

// ── requeueTask resets stuck_count ────────────────────────────────────────────

describe("requeueTask: resets stuck_count so recovered tasks start fresh", () => {
  it("resets stuck_count to 0 when an operator manually requeues a dead-lettered task", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "manual requeue" });
    startTask(task.taskId, "worker");

    getDb()
      .prepare("UPDATE tasks SET stuck_count = ? WHERE task_id = ?")
      .run(MAX_STUCK_RESETS, task.taskId);
    makeStuck(task.taskId);
    failTask(task.taskId, `Task dead-lettered after ${MAX_STUCK_RESETS} stuck resets`);

    const requeued = requeueTask(task.taskId);
    expect(requeued).not.toBeNull();
    expect(requeued!.status).toBe("queued");
    expect(requeued!.stuckCount).toBe(0);
  });

  it("a requeued task with stuck_count=0 will not be immediately dead-lettered", () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "fresh after requeue" });
    startTask(task.taskId, "worker");
    failTask(task.taskId, "manual fail");
    requeueTask(task.taskId);

    // Re-start it and make it look stuck
    startTask(task.taskId, "worker");
    makeStuck(task.taskId);

    // Dead-letter pass should NOT select it — stuck_count is 0, below the limit
    const dead = runDeadLetterPass(stuckCutoff());
    expect(dead.map(r => r.task_id)).not.toContain(task.taskId);

    // Re-queue pass should pick it up and increment to 1
    runRequeuePass(stuckCutoff());
    expect(getTaskById(task.taskId)!.stuckCount).toBe(1);
  });
});
