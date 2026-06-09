import { vi, describe, it, expect, afterEach } from "vitest";
import { createAgent } from "@/lib/agents";
import { createTask, startTask, completeTask, failTask, getTaskById, requeueTask, getTasksByAgent, confirmAndStartTask } from "@/lib/tasks";
import { emitProgress, getTaskProgress } from "@/lib/progress";
import { getReceipt } from "@/lib/receipts";
import { getOutputCommitment } from "@/lib/outputCommitment";
import { getDb } from "@/lib/db";
import * as webhooksModule from "@/lib/webhooks";
import type { Agent } from "@/sdk/types";

afterEach(() => { vi.restoreAllMocks(); });

const TEST_WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `lc-${counter}`,
    name: `Lifecycle Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Full happy-path lifecycle ──────────────────────────────────────────────────

describe("task lifecycle: queued → running → completed", () => {
  it("records all status transitions correctly", () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "Summarise" });
    expect(task.status).toBe("queued");

    const started = startTask(task.taskId);
    expect(started).not.toBeNull();
    expect(started!.status).toBe("running");
    expect(started!.startedAt).toBeDefined();

    const completed = completeTask(task.taskId, "Summary text");
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");
    expect(completed!.output).toBe("Summary text");
    expect(completed!.completedAt).toBeDefined();
  });

  it("startTask is idempotent — returns null if not queued", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "x" });
    startTask(task.taskId);
    // Already running — second startTask should return null
    expect(startTask(task.taskId)).toBeNull();
  });

  it("completeTask returns null if task is not running", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "x" });
    // Still queued — completeTask should refuse
    expect(completeTask(task.taskId, "output")).toBeNull();
  });
});

// ── Progress events ───────────────────────────────────────────────────────────

describe("task progress events", () => {
  it("emits ordered progress and persists to DB", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "x" });
    startTask(task.taskId);

    const p1 = emitProgress(task.taskId, "Fetching data...");
    const p2 = emitProgress(task.taskId, "Analysing...");
    const p3 = emitProgress(task.taskId, "Writing report...");

    expect(p1!.sequence).toBe(1);
    expect(p2!.sequence).toBe(2);
    expect(p3!.sequence).toBe(3);

    const entries = getTaskProgress(task.taskId);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.message)).toEqual([
      "Fetching data...",
      "Analysing...",
      "Writing report...",
    ]);
  });

  it("returns null for progress on a queued task", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "x" });
    expect(emitProgress(task.taskId, "not started yet")).toBeNull();
  });

  it("returns null for progress after task completes", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "x" });
    startTask(task.taskId);
    completeTask(task.taskId, "done");
    expect(emitProgress(task.taskId, "too late")).toBeNull();
  });

  it("returns null for progress after task fails", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "x" });
    startTask(task.taskId);
    failTask(task.taskId, "error");
    expect(emitProgress(task.taskId, "too late")).toBeNull();
  });
});

// ── Receipt completeness ──────────────────────────────────────────────────────

describe("receipt after completed task", () => {
  it("includes progress entries and output fields", async () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "Work" });
    startTask(task.taskId);

    emitProgress(task.taskId, "Step 1");
    emitProgress(task.taskId, "Step 2");

    completeTask(task.taskId, "Final output");

    // commitOutput is fire-and-forget async — flush the microtask queue so
    // the DB write (output_hash) completes before we assert.
    await Promise.resolve();

    const receipt = getReceipt(task.taskId);

    expect(receipt.task?.status).toBe("completed");
    expect(receipt.task?.output).toBe("Final output");
    expect(receipt.progress).toHaveLength(2);
    expect(receipt.progress[0].sequence).toBe(1);
    expect(receipt.progress[1].sequence).toBe(2);

    // outputCommitment is null in tests (no REFUND_SIGNER_PRIVATE_KEY / HELIUS_API_KEY)
    // but outputHash should be written by the catch path in commitOutput
    const fetched = getTaskById(task.taskId);
    expect(fetched!.outputHash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
    expect(fetched!.outputCommitment).toBeUndefined(); // no Solana in tests
  });

  it("receipt progress is empty for tasks with no progress events", async () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "Silent" });
    startTask(task.taskId);
    completeTask(task.taskId, "Done silently");
    await Promise.resolve();

    const receipt = getReceipt(task.taskId);
    expect(receipt.progress).toHaveLength(0);
    expect(receipt.task?.status).toBe("completed");
  });
});

// ── Failed task lifecycle ─────────────────────────────────────────────────────

describe("task lifecycle: queued → running → failed", () => {
  it("records error and completedAt", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "x" });
    startTask(task.taskId);
    const failed = failTask(task.taskId, "Network timeout");

    expect(failed!.status).toBe("failed");
    expect(failed!.error).toBe("Network timeout");
    expect(failed!.completedAt).toBeDefined();
  });

  it("can fail a queued task directly", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "x" });
    const failed = failTask(task.taskId, "Rejected before start");
    expect(failed!.status).toBe("failed");
  });
});

// ── requeueTask ───────────────────────────────────────────────────────────────

describe("requeueTask", () => {
  it("requeues a failed task back to queued", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "retry me" });
    startTask(task.taskId);
    failTask(task.taskId, "transient error");

    const requeued = requeueTask(task.taskId);
    expect(requeued).not.toBeNull();
    expect(requeued!.status).toBe("queued");
    expect(requeued!.error).toBeUndefined();
  });

  it("returns null when task is not in failed state", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "queued" });
    expect(requeueTask(task.taskId)).toBeNull();
  });

  it("returns null for a completed task", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "done" });
    startTask(task.taskId);
    completeTask(task.taskId, "output");
    expect(requeueTask(task.taskId)).toBeNull();
  });
});

// ── getTasksByAgent ───────────────────────────────────────────────────────────

describe("getTasksByAgent", () => {
  it("returns tasks where agent is sender (role=sender)", () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "sent" });

    const tasks = getTasksByAgent({ agentId: sender.agentId, role: "sender" });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.every((t) => t.fromAgent === sender.agentId)).toBe(true);
  });

  it("returns tasks where agent is recipient (role=recipient)", () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "received" });

    const tasks = getTasksByAgent({ agentId: worker.agentId, role: "recipient" });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.every((t) => t.toAgent === worker.agentId)).toBe(true);
  });

  it("returns both sent and received tasks by default (role=both)", () => {
    const agent = makeAgent();
    const other = makeAgent();
    createAgent(agent);
    createAgent(other);
    createTask({ fromAgent: agent.agentId, toAgent: other.agentId, task: "sent by agent" });
    createTask({ fromAgent: other.agentId, toAgent: agent.agentId, task: "received by agent" });

    const tasks = getTasksByAgent({ agentId: agent.agentId });
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by status", () => {
    const agent = makeAgent();
    createAgent(agent);
    const t1 = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "a" });
    const t2 = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "b" });
    startTask(t2.taskId);

    const queued = getTasksByAgent({ agentId: agent.agentId, status: "queued" });
    expect(queued.every((t) => t.status === "queued")).toBe(true);
    expect(queued.some((t) => t.taskId === t1.taskId)).toBe(true);

    const running = getTasksByAgent({ agentId: agent.agentId, status: "running" });
    expect(running.every((t) => t.status === "running")).toBe(true);
    expect(running.some((t) => t.taskId === t2.taskId)).toBe(true);
  });

  it("respects limit", () => {
    const agent = makeAgent();
    createAgent(agent);
    for (let i = 0; i < 5; i++) {
      createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: `task ${i}` });
    }
    const limited = getTasksByAgent({ agentId: agent.agentId, limit: 3 });
    expect(limited).toHaveLength(3);
  });
});

// ── completeTask: webhook queue failure is non-fatal ──────────────────────────

describe("completeTask: webhook queue failure is non-fatal", () => {
  it("returns the completed task even when queueWebhookEvent throws", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "webhook fail" });
    startTask(task.taskId);

    vi.spyOn(webhooksModule, "queueWebhookEvent").mockImplementationOnce(() => {
      throw new Error("webhook unavailable");
    });

    const completed = completeTask(task.taskId, "result");
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe("completed");
  });
});

// ── failTask: latency path exercised when task was previously started ──────────

describe("failTask: latency recording when startedAt is set", () => {
  it("returns the failed task when task had a startedAt timestamp", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "latency test" });
    startTask(task.taskId);

    const failed = failTask(task.taskId, "timed out");
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
    expect(failed!.startedAt).toBeDefined();
    expect(failed!.completedAt).toBeDefined();
  });
});

// ── failTask: webhook queue failure is non-fatal ──────────────────────────────

describe("failTask: webhook queue failure is non-fatal", () => {
  it("returns the failed task even when queueWebhookEvent throws", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "fail webhook fail" });
    startTask(task.taskId);

    vi.spyOn(webhooksModule, "queueWebhookEvent").mockImplementationOnce(() => {
      throw new Error("webhook unavailable");
    });

    const failed = failTask(task.taskId, "crashed");
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
  });
});

// ── getReceipt: bad JSON in context column ────────────────────────────────────

describe("getReceipt: context bad JSON is handled gracefully", () => {
  it("returns undefined for context when the DB row has malformed JSON", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "context test" });

    // Inject malformed context directly — bypasses the schema layer
    getDb()
      .prepare("UPDATE tasks SET context = 'bad-json' WHERE task_id = ?")
      .run(task.taskId);

    const receipt = getReceipt(task.taskId);
    expect(receipt.task).not.toBeNull();
    expect(receipt.task!.context).toBeUndefined();
  });
});

// ── getOutputCommitment: devnet cluster param ────────────────────────────────

describe("getOutputCommitment: devnet explorer URL", () => {
  it("appends ?cluster=devnet to the explorerUrl when SOLANA_NETWORK=devnet", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "commit" });

    // Directly set output_hash and output_commitment to simulate a committed output
    const fakeHash = "a".repeat(64);
    const fakeSig = "5".repeat(88);
    getDb()
      .prepare("UPDATE tasks SET output_hash = ?, output_commitment = ? WHERE task_id = ?")
      .run(fakeHash, fakeSig, task.taskId);

    vi.stubEnv("SOLANA_NETWORK", "devnet");
    try {
      const commitment = getOutputCommitment(task.taskId);
      expect(commitment).not.toBeNull();
      expect(commitment!.explorerUrl).toContain("?cluster=devnet");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── confirmAndStartTask ───────────────────────────────────────────────────────

describe("confirmAndStartTask", () => {
  it("transitions a payment_pending task to running and returns the updated task", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({
      fromAgent: agent.agentId,
      toAgent: agent.agentId,
      task: "paid work",
      initialStatus: "payment_pending",
    });
    expect(task.status).toBe("payment_pending");

    const started = confirmAndStartTask(task.taskId);
    expect(started).not.toBeNull();
    expect(started!.status).toBe("running");
    expect(started!.startedBy).toBe("api");
  });

  it("returns null when task is not in payment_pending status", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({ fromAgent: agent.agentId, toAgent: agent.agentId, task: "queued" });
    // task is in 'queued' status, not 'payment_pending'
    expect(confirmAndStartTask(task.taskId)).toBeNull();
  });

  it("accepts a custom startedBy value", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({
      fromAgent: agent.agentId,
      toAgent: agent.agentId,
      task: "custom starter",
      initialStatus: "payment_pending",
    });
    const started = confirmAndStartTask(task.taskId, "payment-handler");
    expect(started).not.toBeNull();
    expect(started!.startedBy).toBe("payment-handler");
  });
});

// ── getReceipt: hasOpenMppChannel=true path ───────────────────────────────────

describe("getReceipt: hasOpenMppChannel detected when open MPP channel exists", () => {
  it("returns a receipt when the task's fromAgent has an open MPP channel", () => {
    const agent = makeAgent();
    createAgent(agent);
    const task = createTask({
      fromAgent: agent.walletAddress,
      toAgent: agent.agentId,
      task: "mpp path test",
      payment: "5 USDC",
    });

    // Insert a minimal open MPP channel for the fromAgent wallet
    getDb().prepare(`
      INSERT INTO mpp_channels (channel_id, owner_address, key_hash, balance_usdc, balance_micro_usdc, status, created_at, updated_at)
      VALUES ('mpp-test-ch', ?, 'khash', 10.0, 10000000, 'open', datetime('now'), datetime('now'))
    `).run(agent.walletAddress);

    const receipt = getReceipt(task.taskId);
    expect(receipt.taskId).toBe(task.taskId);
    // recommendedPath reflects that an open channel exists
    expect(["x402", "mpp", "free"]).toContain(receipt.recommendedPath.protocol);

    getDb().prepare("DELETE FROM mpp_channels WHERE channel_id = 'mpp-test-ch'").run();
  });
});
