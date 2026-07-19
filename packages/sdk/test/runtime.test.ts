// The agent runtime, driven against a mock client — no network. Confirms the
// poll → claim → run → settle loop, handler-return normalization, failure
// handling, and graceful stop.

import { describe, it, expect, vi } from "vitest";
import { defineAgent } from "../src/runtime";
import { AxonApiError, type AxonClient } from "../src/client";
import type { TaskRequest } from "../src/types";

function task(id: string): TaskRequest {
  return {
    taskId: id,
    fromAgent: "hirer",
    toAgent: "worker",
    task: `do ${id}`,
    status: "queued",
    createdAt: new Date().toISOString(),
  };
}

// A mock client that serves a fixed queue of tasks once, then nothing. Records
// how each task settled.
function mockClient(queue: TaskRequest[]) {
  const settled: Record<string, { via: "complete" | "fail"; text: string }> = {};
  let served = false;
  const client = {
    getAgent: vi.fn(async () => ({ agentId: "worker" })),
    register: vi.fn(async () => ({ agentId: "worker" })),
    getTaskHistory: vi.fn(async () => {
      if (served) return [];
      served = true;
      return queue;
    }),
    startTask: vi.fn(async (id: string) => ({ ...task(id), status: "running" as const })),
    emitProgress: vi.fn(async () => ({ progress: {} })),
    completeTask: vi.fn(async (id: string, output: string) => {
      settled[id] = { via: "complete", text: output };
      return { ...task(id), status: "completed" as const };
    }),
    failTask: vi.fn(async (id: string, error: string) => {
      settled[id] = { via: "fail", text: error };
      return { ...task(id), status: "failed" as const };
    }),
  } as unknown as AxonClient;
  return { client, settled };
}

// Poll until predicate or timeout, so tests don't race the loop.
async function until(pred: () => boolean, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

describe("defineAgent runtime", () => {
  it("runs a queued task through the handler and completes it with the output", async () => {
    const { client, settled } = mockClient([task("t1")]);
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      handler: async ({ task }) => `answer for ${task.taskId}`,
    });
    await agent.start();
    await until(() => "t1" in settled);
    await agent.stop();
    expect(settled.t1).toEqual({ via: "complete", text: "answer for t1" });
    expect(agent.running).toBe(false);
  });

  it("fails the task when the handler throws — never leaves it running", async () => {
    const { client, settled } = mockClient([task("boom")]);
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      handler: async () => {
        throw new Error("handler exploded");
      },
    });
    await agent.start();
    await until(() => "boom" in settled);
    await agent.stop();
    expect(settled.boom.via).toBe("fail");
    expect(settled.boom.text).toContain("handler exploded");
  });

  it("honors an explicit { success:false } return as a failure", async () => {
    const { client, settled } = mockClient([task("nope")]);
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      handler: async () => ({ output: "can't do it", success: false }),
    });
    await agent.start();
    await until(() => "nope" in settled);
    await agent.stop();
    expect(settled.nope).toEqual({ via: "fail", text: "can't do it" });
  });

  it("treats progress as best-effort — a failing emitProgress never fails the task", async () => {
    const { client, settled } = mockClient([task("p1")]);
    (client.emitProgress as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("emit down"));
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      handler: async ({ progress }) => {
        await progress("still works");
        return "done anyway";
      },
    });
    await agent.start();
    await until(() => "p1" in settled);
    await agent.stop();
    expect(settled.p1).toEqual({ via: "complete", text: "done anyway" });
  });

  it("runs multiple tasks concurrently without double-claiming any", async () => {
    const { client, settled } = mockClient([task("a"), task("b")]);
    const startSpy = client.startTask as unknown as ReturnType<typeof vi.fn>;
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      concurrency: 2,
      handler: async ({ task }) => `out-${task.taskId}`,
    });
    await agent.start();
    await until(() => "a" in settled && "b" in settled);
    await agent.stop();
    expect(settled.a).toEqual({ via: "complete", text: "out-a" });
    expect(settled.b).toEqual({ via: "complete", text: "out-b" });
    // each task claimed exactly once
    expect(startSpy.mock.calls.filter((c) => c[0] === "a")).toHaveLength(1);
    expect(startSpy.mock.calls.filter((c) => c[0] === "b")).toHaveLength(1);
  });

  it("retries a transient settle failure instead of orphaning finished work", async () => {
    const { client, settled } = mockClient([task("r")]);
    const complete = client.completeTask as unknown as ReturnType<typeof vi.fn>;
    complete.mockRejectedValueOnce(new Error("settle blip")); // first attempt fails, retry succeeds
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      handler: async () => "recovered",
    });
    await agent.start();
    await until(() => "r" in settled, 2000);
    await agent.stop();
    expect(settled.r).toEqual({ via: "complete", text: "recovered" });
    expect(complete.mock.calls.filter((c) => c[0] === "r").length).toBeGreaterThanOrEqual(2);
  });

  it("treats a settle state-conflict as already-settled (lost-response safe, no false orphan)", async () => {
    const { client } = mockClient([task("c")]);
    // The task already settled server-side; the retry sees a 409 state conflict.
    const conflict = new AxonApiError({ status: 409, method: "POST", path: "/complete", message: "not running", code: "TASK_STATE_CONFLICT" });
    (client.completeTask as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(conflict);
    const onError = vi.fn();
    const onTaskComplete = vi.fn();
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      onError,
      onTaskComplete,
      handler: async () => "done",
    });
    await agent.start();
    await until(() => onTaskComplete.mock.calls.length > 0);
    await agent.stop();
    expect(onTaskComplete).toHaveBeenCalledOnce();
    // the conflict is NOT surfaced as an error — the task did settle
    expect(onError).not.toHaveBeenCalled();
  });

  it("is re-entrancy safe — concurrent start() calls don't spawn rival loops", async () => {
    const { client, settled } = mockClient([task("z")]);
    const startSpy = client.startTask as unknown as ReturnType<typeof vi.fn>;
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      concurrency: 1,
      handler: async ({ task }) => `out-${task.taskId}`,
    });
    await Promise.all([agent.start(), agent.start()]); // fire twice, concurrently
    await until(() => "z" in settled);
    await agent.stop();
    expect(startSpy.mock.calls.filter((c) => c[0] === "z")).toHaveLength(1);
    expect(agent.running).toBe(false);
  });

  it("auto-registers when the agent doesn't exist yet", async () => {
    const { client } = mockClient([]);
    const notFound = new AxonApiError({ status: 404, method: "GET", path: "/api/agents/worker", message: "not found", code: "NOT_FOUND" });
    (client.getAgent as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(notFound);
    const agent = defineAgent(client, {
      agentId: "worker",
      name: "Worker",
      capabilities: ["research"],
      publicKey: "pk",
      pollIntervalMs: 10,
      handler: async () => "x",
    });
    await agent.start();
    await agent.stop();
    expect(client.register).toHaveBeenCalledOnce();
  });
});
