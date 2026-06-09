import { describe, it, expect } from "vitest";
import {
  createQuorumRecord,
  getQuorumTask,
  getQuorumResults,
  onChildTaskCompleted,
  onChildTaskFailed,
} from "@/lib/quorum";
import { createAgent } from "@/lib/agents";
import { createTask, completeTask, failTask } from "@/lib/tasks";
import { getDb } from "@/lib/db";

const WALLET = "11111111111111111111111111111111";
let seq = 0;
function uid() { return `qt-${++seq}`; }

function makeAgent(id: string, reputation = 0) {
  createAgent({
    agentId: id,
    name: `Agent ${id}`,
    capabilities: ["test"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation,
    createdAt: new Date().toISOString(),
  });
}

function makeQuorum(threshold: number, agentCount: number) {
  return createQuorumRecord({
    fromAgent: "anon",
    taskContent: "test task content",
    threshold,
    agentCount,
  });
}

function seedTask(quorumId: string, toAgent: string) {
  return createTask({ fromAgent: "anon", toAgent, task: "do it", quorumId, queueQueuedWebhook: false });
}

function dbComplete(taskId: string, output: string, completedAt: string) {
  getDb()
    .prepare("UPDATE tasks SET status='completed', output=?, completed_at=? WHERE task_id=?")
    .run(output, completedAt, taskId);
}

function dbFail(taskId: string) {
  getDb()
    .prepare("UPDATE tasks SET status='failed', completed_at=? WHERE task_id=?")
    .run(new Date().toISOString(), taskId);
}

function dbRun(taskId: string) {
  getDb()
    .prepare("UPDATE tasks SET status='running', started_at=? WHERE task_id=?")
    .run(new Date().toISOString(), taskId);
}

// ── createQuorumRecord ────────────────────────────────────────────────────────

describe("createQuorumRecord", () => {
  it("creates a pending quorum with all fields set", () => {
    const q = makeQuorum(2, 3);
    expect(q.quorumId).toMatch(/^[0-9a-f-]{36}$/);
    expect(q.fromAgent).toBe("anon");
    expect(q.taskContent).toBe("test task content");
    expect(q.threshold).toBe(2);
    expect(q.agentCount).toBe(3);
    expect(q.status).toBe("pending");
    expect(q.acceptedResult).toBeUndefined();
    expect(q.acceptedAgent).toBeUndefined();
    expect(q.completedAt).toBeUndefined();
    expect(q.createdAt).toBeTruthy();
  });
});

// ── getQuorumTask ─────────────────────────────────────────────────────────────

describe("getQuorumTask", () => {
  it("returns null for unknown quorumId", () => {
    expect(getQuorumTask("no-such-id")).toBeNull();
  });

  it("returns the quorum for a known id", () => {
    const q = makeQuorum(1, 2);
    const fetched = getQuorumTask(q.quorumId);
    expect(fetched?.quorumId).toBe(q.quorumId);
    expect(fetched?.status).toBe("pending");
  });
});

// ── getQuorumResults ──────────────────────────────────────────────────────────

describe("getQuorumResults", () => {
  it("returns empty array when no child tasks", () => {
    const q = makeQuorum(1, 2);
    expect(getQuorumResults(q.quorumId)).toEqual([]);
  });

  it("returns results for all child tasks in created order", () => {
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const q = makeQuorum(1, 2);
    seedTask(q.quorumId, id1);
    seedTask(q.quorumId, id2);
    const results = getQuorumResults(q.quorumId);
    expect(results).toHaveLength(2);
    const agentIds = results.map((r) => r.agentId);
    expect(agentIds).toContain(id1);
    expect(agentIds).toContain(id2);
    results.forEach((r) => expect(r.status).toBe("queued"));
  });

  it("reflects completed status and result after a task completes", () => {
    const id = uid(); makeAgent(id);
    const q = makeQuorum(1, 1);
    const t = seedTask(q.quorumId, id);
    dbComplete(t.taskId, "my-output", new Date().toISOString());
    const [result] = getQuorumResults(q.quorumId);
    expect(result.status).toBe("completed");
    expect(result.result).toBe("my-output");
  });
});

// ── onChildTaskCompleted — threshold logic ────────────────────────────────────

describe("onChildTaskCompleted — threshold logic", () => {
  it("keeps quorum pending while below threshold", () => {
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const q = makeQuorum(2, 2);
    const t1 = seedTask(q.quorumId, id1);
    seedTask(q.quorumId, id2);
    dbComplete(t1.taskId, "result", "2026-01-01T00:00:01Z");

    onChildTaskCompleted(q.quorumId);

    expect(getQuorumTask(q.quorumId)?.status).toBe("pending");
  });

  it("marks quorum completed when threshold is exactly reached", () => {
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const q = makeQuorum(2, 2);
    const t1 = seedTask(q.quorumId, id1);
    const t2 = seedTask(q.quorumId, id2);
    dbComplete(t1.taskId, "result-a", "2026-01-01T00:00:01Z");
    dbComplete(t2.taskId, "result-b", "2026-01-01T00:00:02Z");

    onChildTaskCompleted(q.quorumId);

    const updated = getQuorumTask(q.quorumId)!;
    expect(updated.status).toBe("completed");
    expect(updated.acceptedResult).toBeDefined();
    expect(updated.acceptedAgent).toBeDefined();
    expect(updated.completedAt).toBeDefined();
  });

  it("picks the highest-reputation agent as winner", () => {
    const lowId = uid(); makeAgent(lowId, 2);
    const highId = uid(); makeAgent(highId, 8);
    const q = makeQuorum(2, 2);
    const tLow = seedTask(q.quorumId, lowId);
    const tHigh = seedTask(q.quorumId, highId);
    // Same timestamp so reputation is the deciding factor
    const ts = "2026-01-01T00:00:01Z";
    dbComplete(tLow.taskId, "low-output", ts);
    dbComplete(tHigh.taskId, "high-output", ts);

    onChildTaskCompleted(q.quorumId);

    const updated = getQuorumTask(q.quorumId)!;
    expect(updated.acceptedResult).toBe("high-output");
    expect(updated.acceptedAgent).toBe(highId);
  });

  it("breaks reputation ties by earliest completed_at", () => {
    const id1 = uid(); makeAgent(id1, 5);
    const id2 = uid(); makeAgent(id2, 5);
    const q = makeQuorum(2, 2);
    const t1 = seedTask(q.quorumId, id1);
    const t2 = seedTask(q.quorumId, id2);
    dbComplete(t1.taskId, "early-output", "2026-01-01T00:00:01Z");
    dbComplete(t2.taskId, "late-output",  "2026-01-01T00:00:02Z");

    onChildTaskCompleted(q.quorumId);

    const updated = getQuorumTask(q.quorumId)!;
    expect(updated.acceptedResult).toBe("early-output");
    expect(updated.acceptedAgent).toBe(id1);
  });

  it("defaults unregistered agent reputation to 0 via COALESCE", () => {
    const q = makeQuorum(1, 1);
    const t = seedTask(q.quorumId, "ghost-not-in-db");
    dbComplete(t.taskId, "ghost-output", "2026-01-01T00:00:01Z");

    onChildTaskCompleted(q.quorumId);

    const updated = getQuorumTask(q.quorumId)!;
    expect(updated.status).toBe("completed");
    expect(updated.acceptedResult).toBe("ghost-output");
    expect(updated.acceptedAgent).toBe("ghost-not-in-db");
  });

  it("is idempotent — second call after completion leaves completedAt unchanged", () => {
    const id = uid(); makeAgent(id);
    const q = makeQuorum(1, 1);
    const t = seedTask(q.quorumId, id);
    dbComplete(t.taskId, "result", "2026-01-01T00:00:01Z");

    onChildTaskCompleted(q.quorumId);
    const firstCompletedAt = getQuorumTask(q.quorumId)!.completedAt;

    onChildTaskCompleted(q.quorumId);
    expect(getQuorumTask(q.quorumId)!.completedAt).toBe(firstCompletedAt);
  });

  it("threshold=1 of 3 — completes on the first completion", () => {
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const id3 = uid(); makeAgent(id3);
    const q = makeQuorum(1, 3);
    const t1 = seedTask(q.quorumId, id1);
    seedTask(q.quorumId, id2);
    seedTask(q.quorumId, id3);
    dbComplete(t1.taskId, "first-done", "2026-01-01T00:00:01Z");

    onChildTaskCompleted(q.quorumId);

    expect(getQuorumTask(q.quorumId)!.status).toBe("completed");
  });
});

// ── onChildTaskFailed — failure propagation ───────────────────────────────────

describe("onChildTaskFailed — failure propagation", () => {
  it("keeps quorum pending when threshold is still achievable", () => {
    // threshold=1, agentCount=2: after 1 failure maxPossible=1 >= threshold=1
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const q = makeQuorum(1, 2);
    const t1 = seedTask(q.quorumId, id1);
    seedTask(q.quorumId, id2);
    dbFail(t1.taskId);

    onChildTaskFailed(q.quorumId);

    expect(getQuorumTask(q.quorumId)?.status).toBe("pending");
  });

  it("marks quorum failed when threshold becomes unreachable", () => {
    // threshold=2, agentCount=2: after 1 failure maxPossible=1 < threshold=2
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const q = makeQuorum(2, 2);
    const t1 = seedTask(q.quorumId, id1);
    seedTask(q.quorumId, id2);
    dbFail(t1.taskId);

    onChildTaskFailed(q.quorumId);

    const updated = getQuorumTask(q.quorumId)!;
    expect(updated.status).toBe("failed");
    expect(updated.completedAt).toBeDefined();
  });

  it("requires all agents to fail when threshold equals agentCount", () => {
    // threshold=2, agentCount=3: after 1 failure maxPossible=2 >= 2 → still achievable
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const id3 = uid(); makeAgent(id3);
    const q = makeQuorum(2, 3);
    const t1 = seedTask(q.quorumId, id1);
    const t2 = seedTask(q.quorumId, id2);
    seedTask(q.quorumId, id3);
    dbFail(t1.taskId);
    onChildTaskFailed(q.quorumId);
    expect(getQuorumTask(q.quorumId)!.status).toBe("pending");

    // After 2nd failure: maxPossible=1 < threshold=2 → fail
    dbFail(t2.taskId);
    onChildTaskFailed(q.quorumId);
    expect(getQuorumTask(q.quorumId)!.status).toBe("failed");
  });

  it("is idempotent — second call after failure leaves completedAt unchanged", () => {
    const id1 = uid(); makeAgent(id1);
    const q = makeQuorum(1, 1);
    const t1 = seedTask(q.quorumId, id1);
    dbFail(t1.taskId);

    onChildTaskFailed(q.quorumId);
    const firstCompletedAt = getQuorumTask(q.quorumId)!.completedAt;

    onChildTaskFailed(q.quorumId);
    expect(getQuorumTask(q.quorumId)!.completedAt).toBe(firstCompletedAt);
  });

  it("does not override a completed quorum", () => {
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const q = makeQuorum(1, 2);
    const t1 = seedTask(q.quorumId, id1);
    const t2 = seedTask(q.quorumId, id2);
    // Complete via first task
    dbComplete(t1.taskId, "good-output", "2026-01-01T00:00:01Z");
    onChildTaskCompleted(q.quorumId);
    expect(getQuorumTask(q.quorumId)!.status).toBe("completed");

    // Fail the second task in a way that would trigger failure if quorum were pending
    dbFail(t2.taskId);
    // Shrink agentCount so maxPossible would be 0 (normally would fail the quorum)
    getDb().prepare("UPDATE quorum_tasks SET agent_count=1 WHERE quorum_id=?").run(q.quorumId);
    onChildTaskFailed(q.quorumId);

    // Status must remain completed
    expect(getQuorumTask(q.quorumId)!.status).toBe("completed");
  });
});

// ── Full pipeline via tasks.ts hooks ──────────────────────────────────────────

describe("full pipeline — tasks.ts → quorum hooks", () => {
  it("completeTask triggers quorum completion when threshold is reached", async () => {
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    const q = makeQuorum(2, 2);
    const t1 = seedTask(q.quorumId, id1);
    const t2 = seedTask(q.quorumId, id2);
    dbRun(t1.taskId); dbRun(t2.taskId);

    await completeTask(t1.taskId, "out-1");
    expect(getQuorumTask(q.quorumId)!.status).toBe("pending"); // 1/2 done

    await completeTask(t2.taskId, "out-2");
    expect(getQuorumTask(q.quorumId)!.status).toBe("completed");
  });

  it("failTask triggers quorum failure when threshold becomes unreachable", async () => {
    const id1 = uid(); makeAgent(id1);
    const id2 = uid(); makeAgent(id2);
    // threshold=1, agentCount=2: first fail → maxPossible=1≥1 → pending
    //                             second fail → maxPossible=0<1 → failed
    const q = makeQuorum(1, 2);
    const t1 = seedTask(q.quorumId, id1);
    const t2 = seedTask(q.quorumId, id2);
    dbRun(t1.taskId); dbRun(t2.taskId);

    await failTask(t1.taskId, "err-1");
    expect(getQuorumTask(q.quorumId)!.status).toBe("pending");

    await failTask(t2.taskId, "err-2");
    expect(getQuorumTask(q.quorumId)!.status).toBe("failed");
  });
});
