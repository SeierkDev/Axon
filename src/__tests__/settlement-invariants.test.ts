// Settlement invariants — Phase 4, item 5.
// Verifies that after task completion or failure, payment status, agent reputation,
// and webhook events are all consistent with each other (no partial writes).
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { vi, describe, it, expect, afterEach } from "vitest";
import { createPayment, releasePayment, refundPayment, getAgentBalance } from "@/lib/payments";
import { getPaymentNotes } from "@/lib/paymentNotes";
import { createTask, startTask, completeTask, failTask } from "@/lib/tasks";
import { createAgent, getAgentById } from "@/lib/agents";
import * as webhooksModule from "@/lib/webhooks";
import type { Agent } from "@/sdk/types";

afterEach(() => { vi.restoreAllMocks(); });

const TEST_WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `si-${counter}`,
    name: `SI Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk-si-${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockSig(units: number, nonce: string | number): string {
  return `mockpay:USDC:${units}:${TEST_WALLET}:${TEST_WALLET}:${nonce}`;
}

// ── Complete path ─────────────────────────────────────────────────────────────

describe("settlement invariants: complete path", () => {
  it("task completed → payment settled → reputation updated → both webhooks queued", async () => {
    const webhookSpy = vi.spyOn(webhooksModule, "queueWebhookEvent");

    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "Do work" });
    startTask(task.taskId);

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, "si-complete-1"),
      priceString: "1 USDC",
    });

    const completed = completeTask(task.taskId, "Output");
    expect(completed?.status).toBe("completed");

    const payment = releasePayment(task.taskId);
    expect(payment?.status).toBe("completed");

    // Reputation must have been updated for the worker
    const updated = getAgentById(worker.agentId);
    expect(updated?.reputation).toBeGreaterThan(0);

    // Both task.completed and payment.settled webhooks must have been queued
    const events = webhookSpy.mock.calls.map((c) => c[1]);
    expect(events).toContain("task.completed");
    expect(events).toContain("payment.settled");
  });

  it("escrow clears to zero after settlement, spent balance increases", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });
    startTask(task.taskId);

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 2,
      paymentSignature: mockSig(2_000_000, "si-escrow-clear"),
      priceString: "2 USDC",
    });

    const before = getAgentBalance(sender.agentId);
    expect(before.totalEscrow).toBe(2);
    expect(before.totalSpent).toBe(0);

    completeTask(task.taskId, "done");
    releasePayment(task.taskId);

    const after = getAgentBalance(sender.agentId);
    expect(after.totalEscrow).toBe(0);
    expect(after.totalSpent).toBe(2);
  });

  it("cannot double-settle the same task", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });
    startTask(task.taskId);

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, "si-no-double"),
      priceString: "1 USDC",
    });

    completeTask(task.taskId, "done");
    releasePayment(task.taskId);

    expect(releasePayment(task.taskId)).toBeNull();
  });
});

// ── Refund path ───────────────────────────────────────────────────────────────

describe("settlement invariants: refund path", () => {
  it("task failed → payment refunded → payment.refunded webhook queued", async () => {
    const webhookSpy = vi.spyOn(webhooksModule, "queueWebhookEvent");

    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });
    startTask(task.taskId);

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, "si-refund-1"),
      priceString: "1 USDC",
    });

    failTask(task.taskId, "Provider error");
    const refunded = refundPayment(task.taskId);
    expect(refunded?.status).toBe("refunded");

    const events = webhookSpy.mock.calls.map((c) => c[1]);
    expect(events).toContain("payment.refunded");
  });

  it("a refund attaches a refund note carrying the task's failure reason", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });
    startTask(task.taskId);
    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, "si-refund-note"),
      priceString: "1 USDC",
    });

    failTask(task.taskId, "Provider exploded");
    refundPayment(task.taskId);

    const notes = getPaymentNotes(task.taskId);
    expect(notes.some((nt) => nt.kind === "refund" && nt.note.includes("Provider exploded"))).toBe(true);
    expect(notes.every((nt) => nt.author === null)).toBe(true); // system-generated
  });

  it("cannot double-refund the same task", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });
    startTask(task.taskId);

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, "si-no-double-refund"),
      priceString: "1 USDC",
    });

    failTask(task.taskId, "Error");
    refundPayment(task.taskId);

    expect(refundPayment(task.taskId)).toBeNull();
  });
});

// ── Escrow consistency ────────────────────────────────────────────────────────

describe("settlement invariants: escrow balance consistency", () => {
  it("total escrow equals sum of all pending payments", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task1 = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "a" });
    const task2 = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "b" });

    await createPayment({
      taskId: task1.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, "si-escrow-sum-1"),
      priceString: "1 USDC",
    });
    await createPayment({
      taskId: task2.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 3,
      paymentSignature: mockSig(3_000_000, "si-escrow-sum-2"),
      priceString: "3 USDC",
    });

    const balance = getAgentBalance(sender.agentId);
    expect(balance.totalEscrow).toBe(4);
  });

  it("worker earned balance only increases after settlement, not before", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });
    startTask(task.taskId);

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, "si-earned-timing"),
      priceString: "1 USDC",
    });

    expect(getAgentBalance(worker.agentId).totalEarned).toBe(0);

    completeTask(task.taskId, "done");
    releasePayment(task.taskId);

    expect(getAgentBalance(worker.agentId).totalEarned).toBe(1);
  });
});
