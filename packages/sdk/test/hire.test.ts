// The one-shot hire orchestrator, driven against a mock client — no network.
// Covers the free lane, the paid (x402) lane, the paid-without-pay guard, and
// polling to completion.

import { describe, it, expect, vi } from "vitest";
import { hire } from "../src/hire";
import type { AxonClient } from "../src/client";
import type { TaskRequest, X402Requirements } from "../src/types";

const REQUIREMENTS: X402Requirements = {
  version: "x402/1",
  accepts: [
    {
      scheme: "exact",
      network: "solana-mainnet",
      maxAmountRequired: "250000",
      resource: "https://axon-agents.com/api/agents/code-agent/x402",
      description: "0.25 USDC",
      mimeType: "application/json",
      payToAddress: "TREASURY",
    } as X402Requirements["accepts"][number],
  ],
};

function baseTask(over: Partial<TaskRequest> = {}): TaskRequest {
  return {
    taskId: "task-1",
    fromAgent: "anonymous",
    toAgent: "agent",
    task: "do the thing",
    status: "queued",
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("hire()", () => {
  it("hires a free-lane agent and polls to completion", async () => {
    const getTask = vi
      .fn()
      .mockResolvedValueOnce(baseTask({ status: "running" }))
      .mockResolvedValueOnce(baseTask({ status: "completed", output: "the answer" }));
    const client = {
      getX402Requirements: vi.fn(async () => null), // free
      sendTask: vi.fn(async () => baseTask()),
      submitTaskX402: vi.fn(),
      getTask,
      getReceipt: vi.fn(async () => ({ receipt: { taskId: "task-1" } })),
    } as unknown as AxonClient;

    const r = await hire(client, { to: "agent", task: "do the thing", pollIntervalMs: 1 });
    expect(r.paid).toBe(false);
    expect(r.status).toBe("completed");
    expect(r.output).toBe("the answer");
    expect(r.receipt).toBeTruthy();
    expect((client.submitTaskX402 as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("pays and hires a priced agent via x402", async () => {
    const pay = vi.fn(async () => ({ signature: "sig", from: "PAYER" }));
    const client = {
      getX402Requirements: vi.fn(async () => REQUIREMENTS), // paid
      sendTask: vi.fn(),
      submitTaskX402: vi.fn(async () => baseTask({ taskId: "paid-1" })),
      getTask: vi.fn(async () => baseTask({ taskId: "paid-1", status: "completed", output: "done" })),
      getReceipt: vi.fn(async () => ({ receipt: { taskId: "paid-1" } })),
    } as unknown as AxonClient;

    const r = await hire(client, { to: "code-agent", task: "audit", pay, pollIntervalMs: 1 });
    expect(r.paid).toBe(true);
    expect(r.status).toBe("completed");
    expect(r.output).toBe("done");
    expect(client.submitTaskX402 as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
    expect(client.sendTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses to hire a priced agent without a pay function", async () => {
    const client = {
      getX402Requirements: vi.fn(async () => REQUIREMENTS),
      sendTask: vi.fn(),
      submitTaskX402: vi.fn(),
      getTask: vi.fn(),
      getReceipt: vi.fn(),
    } as unknown as AxonClient;

    await expect(hire(client, { to: "code-agent", task: "audit" })).rejects.toThrow(/priced|pay/i);
    expect(client.submitTaskX402 as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("returns timedOut when the task never reaches a terminal state", async () => {
    const client = {
      getX402Requirements: vi.fn(async () => null),
      sendTask: vi.fn(async () => baseTask()),
      submitTaskX402: vi.fn(),
      getTask: vi.fn(async () => baseTask({ status: "running" })), // never completes
      getReceipt: vi.fn(),
    } as unknown as AxonClient;

    const r = await hire(client, { to: "agent", task: "x", pollIntervalMs: 1, timeoutMs: 5 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe("running");
    expect(r.receipt).toBeUndefined();
  });

  it("surfaces a failed task's error", async () => {
    const client = {
      getX402Requirements: vi.fn(async () => null),
      sendTask: vi.fn(async () => baseTask()),
      submitTaskX402: vi.fn(),
      getTask: vi.fn(async () => baseTask({ status: "failed", error: "agent could not comply" })),
      getReceipt: vi.fn(),
    } as unknown as AxonClient;

    const r = await hire(client, { to: "agent", task: "x", pollIntervalMs: 1 });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("agent could not comply");
  });
});
