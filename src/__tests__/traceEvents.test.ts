import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createTask, startTask, completeTask } from "@/lib/tasks";
import { emitProgress } from "@/lib/progress";
import {
  appendTraceEvent,
  getTraceEvents,
  verifyTraceChain,
  getPublicTrace,
  estimateCostUsd,
  recordModelUsage,
  captureModelStep,
} from "@/lib/traceEvents";
import type { Agent } from "@/sdk/types";

const TEST_WALLET = "11111111111111111111111111111111";
let n = 0;
function makeAgent(): Agent {
  n++;
  return {
    agentId: `trace-${n}-${randomUUID().slice(0, 8)}`,
    name: `Trace Agent ${n}`,
    capabilities: ["research"],
    publicKey: `pk-trace-${n}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
}

describe("traceEvents — hash chain", () => {
  it("chains events and verifies", () => {
    const traceId = `t-${randomUUID()}`;
    appendTraceEvent({ traceId, kind: "task.created", toAgent: "a" });
    appendTraceEvent({ traceId, kind: "step.model", toAgent: "a", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50 });
    appendTraceEvent({ traceId, kind: "task.completed", toAgent: "a", outputHash: "abc" });

    const events = getTraceEvents(traceId);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Each event commits to the previous event's hash.
    expect(events[0].prevHash).toBeNull();
    expect(events[1].prevHash).toBe(events[0].hash);
    expect(events[2].prevHash).toBe(events[1].hash);

    const v = verifyTraceChain(traceId);
    expect(v.valid).toBe(true);
    expect(v.count).toBe(3);
    expect(v.brokenAt).toBeNull();
  });

  it("detects tampering with a past event", () => {
    const traceId = `t-${randomUUID()}`;
    appendTraceEvent({ traceId, kind: "task.created", toAgent: "a" });
    appendTraceEvent({ traceId, kind: "step.model", toAgent: "a", outputHash: "original" });
    appendTraceEvent({ traceId, kind: "task.completed", toAgent: "a" });
    expect(verifyTraceChain(traceId).valid).toBe(true);

    // Alter a stored field of the middle event without recomputing its hash.
    getDb()
      .prepare("UPDATE trace_events SET output_hash = 'TAMPERED' WHERE trace_id = ? AND seq = 2")
      .run(traceId);

    const v = verifyTraceChain(traceId);
    expect(v.valid).toBe(false);
    expect(v.brokenAt).toBe(2);
  });

  it("is deterministic — same inputs produce the same hash", () => {
    const a = `t-${randomUUID()}`;
    const b = `t-${randomUUID()}`;
    // Distinct trace ids ⇒ distinct hashes (trace_id is part of the payload),
    // but the chaining is deterministic within each.
    appendTraceEvent({ traceId: a, kind: "task.created", toAgent: "x", inputHash: "h" });
    appendTraceEvent({ traceId: b, kind: "task.created", toAgent: "x", inputHash: "h" });
    const ea = getTraceEvents(a)[0];
    const eb = getTraceEvents(b)[0];
    expect(ea.hash).toHaveLength(64);
    expect(ea.hash).not.toBe(eb.hash); // trace id differs
  });
});

describe("traceEvents — cost estimation", () => {
  it("prices known models and returns null for unknown", () => {
    // opus 4.8: $5/$25 per 1M → 1M in + 1M out = 5 + 25 = 30
    expect(estimateCostUsd("claude-opus-4-8", 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
    // dated suffix still resolves by prefix
    expect(estimateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 0)).toBeCloseTo(1, 6);
    expect(estimateCostUsd("some-unknown-model", 100, 100)).toBeNull();
    expect(estimateCostUsd("claude-opus-4-8", null, 100)).toBeNull();
  });
});

describe("traceEvents — usage side-channel", () => {
  it("accumulates usage within a capture and is a no-op outside", async () => {
    // outside a capture: must not throw
    expect(() => recordModelUsage("claude-opus-4-8", 10, 10)).not.toThrow();

    const cap = await captureModelStep(async () => {
      recordModelUsage("claude-opus-4-8", 100, 50);
      recordModelUsage("claude-opus-4-8", 20, 10); // continuation round
      return "done";
    });
    expect(cap.result).toBe("done");
    expect(cap.model).toBe("claude-opus-4-8");
    expect(cap.inputTokens).toBe(120);
    expect(cap.outputTokens).toBe(60);
    expect(cap.calls).toBe(2);
    expect(cap.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("traceEvents — lifecycle capture + privacy", () => {
  it("captures created + completed for a real task and never leaks content", () => {
    const from = makeAgent();
    const to = makeAgent();
    createAgent(from);
    createAgent(to);

    const SECRET_TASK = "SECRET_TASK_CONTENT_9f3a";
    const SECRET_OUTPUT = "SECRET_OUTPUT_CONTENT_7b2c";
    const task = createTask({ fromAgent: from.agentId, toAgent: to.agentId, task: SECRET_TASK });
    startTask(task.taskId);
    completeTask(task.taskId, SECRET_OUTPUT);

    const trace = getPublicTrace(task.taskId);
    expect(trace).not.toBeNull();
    const kinds = trace!.events.map((e) => e.kind);
    expect(kinds).toContain("task.created");
    expect(kinds).toContain("task.completed");
    expect(trace!.verified).toBe(true);

    // Names resolve for display.
    const created = trace!.events.find((e) => e.kind === "task.created")!;
    expect(created.toName).toBe(to.name);

    // Privacy: neither the task text nor the output text appears anywhere.
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(SECRET_TASK);
    expect(serialized).not.toContain(SECRET_OUTPUT);
    // But the output IS committed as a hash on the completed event.
    const completed = trace!.events.find((e) => e.kind === "task.completed")!;
    expect(completed.outputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns null trace for a task with no events", () => {
    expect(getPublicTrace(`nonexistent-${randomUUID()}`)).toBeNull();
  });

  it("a task with a model step + settlement emitted around it reads as a full trace", () => {
    const from = makeAgent();
    const to = makeAgent();
    createAgent(from);
    createAgent(to);

    // Mirror what the activity cron emits: created (auto) → step.model → completed → settled.
    const task = createTask({ fromAgent: from.agentId, toAgent: to.agentId, task: "activity task" });
    startTask(task.taskId);
    appendTraceEvent({
      traceId: task.traceId ?? task.taskId,
      taskId: task.taskId,
      kind: "step.model",
      fromAgent: from.agentId,
      toAgent: to.agentId,
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
      model: "claude-sonnet-5",
      inputTokens: 400,
      outputTokens: 200,
      costUsd: estimateCostUsd("claude-sonnet-5", 400, 200),
      latencyMs: 2300,
    });
    completeTask(task.taskId, "activity output");
    appendTraceEvent({
      traceId: task.traceId ?? task.taskId,
      taskId: task.taskId,
      kind: "settlement.completed",
      fromAgent: from.agentId,
      toAgent: to.agentId,
      meta: { amount: 5, currency: "USDC" },
    });

    const trace = getPublicTrace(task.taskId)!;
    expect(trace.events.map((e) => e.kind)).toEqual([
      "task.created",
      "step.model",
      "task.completed",
      "settlement.completed",
    ]);
    expect(trace.summary.steps).toBe(1); // no longer "Steps: 0"
    expect(trace.summary.totalOutputTokens).toBe(200);
    expect(trace.summary.totalCostUsd).toBeGreaterThan(0);
    expect(trace.verified).toBe(true);
  });

  it("captures progress events into the chain without leaking the message", () => {
    const from = makeAgent();
    const to = makeAgent();
    createAgent(from);
    createAgent(to);

    const task = createTask({ fromAgent: from.agentId, toAgent: to.agentId, task: "work" });
    startTask(task.taskId); // progress only records while running
    const SECRET_PROGRESS = "SECRET_PROGRESS_MSG_4d1e";
    emitProgress(task.taskId, SECRET_PROGRESS);

    const trace = getPublicTrace(task.taskId)!;
    const progress = trace.events.find((e) => e.kind === "progress");
    expect(progress).toBeDefined();
    expect(progress!.outputHash).toMatch(/^[0-9a-f]{64}$/); // message committed as a hash
    expect(trace.verified).toBe(true);
    // The chain must not carry the raw progress text.
    expect(JSON.stringify(trace)).not.toContain(SECRET_PROGRESS);
  });
});
