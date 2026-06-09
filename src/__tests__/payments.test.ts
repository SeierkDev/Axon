// Mock payment verifier — must be set before any imports that evaluate AXON_PAYMENT_VERIFIER
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { vi, describe, it, expect, afterEach } from "vitest";
import {
  createPayment,
  releasePayment,
  refundPayment,
  getPaymentById,
  getPaymentByTaskId,
  getPaymentByIncomingSignature,
  getPaymentsByAgent,
  getAgentBalance,
  parsePriceToSol,
} from "@/lib/payments";
import * as webhooksModule from "@/lib/webhooks";
import { createAgent } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

afterEach(() => { vi.restoreAllMocks(); });

// system program address — valid Solana pubkey, used as test wallet
const TEST_WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `pay-${counter}`,
    name: `Pay Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Mock signature: mockpay:CURRENCY:UNITS:SIGNER:RECEIVER:NONCE
// PAYMENT_RECEIVER_WALLET_ADDRESS is set to TEST_WALLET in setup.ts
function mockSig(units: number, nonce: string | number, currency = "USDC"): string {
  return `mockpay:${currency}:${units}:${TEST_WALLET}:${TEST_WALLET}:${nonce}`;
}

// ── parsePriceToSol ───────────────────────────────────────────────────────────

describe("parsePriceToSol", () => {
  it("parses SOL price string", () => {
    expect(parsePriceToSol("0.05 SOL")).toBe(0.05);
  });
  it("parses USDC price string", () => {
    expect(parsePriceToSol("5 USDC")).toBe(5);
  });
  it("returns null for undefined", () => {
    expect(parsePriceToSol(undefined)).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(parsePriceToSol("")).toBeNull();
  });
  it("returns null for invalid string", () => {
    expect(parsePriceToSol("not-a-price")).toBeNull();
  });
});

// ── createPayment ─────────────────────────────────────────────────────────────

describe("createPayment (mock verifier)", () => {
  it("creates a payment in escrow status", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "Work" });

    const payment = await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, 1),
      priceString: "1 USDC",
    });

    expect(payment.txId).toBeDefined();
    expect(payment.status).toBe("escrow");
    expect(payment.fromAgent).toBe(sender.agentId);
    expect(payment.toAgent).toBe(worker.agentId);
    expect(payment.taskId).toBe(task.taskId);
    expect(payment.currency).toBe("USDC");
    expect(payment.incomingSignature).toBe(mockSig(1_000_000, 1));
  });

  it("rejects duplicate payment signature", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const sig = mockSig(1_000_000, 2);

    await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: sig,
      priceString: "1 USDC",
    });

    await expect(
      createPayment({
        fromAgent: sender.agentId,
        toAgent: worker.agentId,
        amountSol: 1,
        paymentSignature: sig,
        priceString: "1 USDC",
      })
    ).rejects.toThrow("Payment signature already used");
  });

  it("rejects when payer wallet cannot be resolved", async () => {
    await expect(
      createPayment({
        fromAgent: "unknown-agent-id",
        toAgent: "another-agent",
        amountSol: 1,
        paymentSignature: mockSig(1_000_000, 99),
        priceString: "1 USDC",
      })
    ).rejects.toThrow("Payment payer must be a wallet address");
  });

  it("rejects invalid price string", async () => {
    const sender = makeAgent();
    createAgent(sender);
    await expect(
      createPayment({
        fromAgent: sender.agentId,
        toAgent: "to",
        amountSol: 0,
        paymentSignature: mockSig(0, 3),
        priceString: "not-a-price",
      })
    ).rejects.toThrow("Payment amount must be a positive");
  });
});

// ── releasePayment / refundPayment ────────────────────────────────────────────

describe("releasePayment", () => {
  it("transitions payment from escrow to completed", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, 10),
      priceString: "1 USDC",
    });

    const released = releasePayment(task.taskId);
    expect(released).not.toBeNull();
    expect(released!.status).toBe("completed");
    expect(released!.settledAt).toBeDefined();
  });

  it("returns null when no escrow payment exists for task", () => {
    expect(releasePayment("no-such-task")).toBeNull();
  });
});

describe("refundPayment", () => {
  it("transitions payment from escrow to refunded", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, 20),
      priceString: "1 USDC",
    });

    const refunded = refundPayment(task.taskId);
    expect(refunded).not.toBeNull();
    expect(refunded!.status).toBe("refunded");
    expect(refunded!.settledAt).toBeDefined();
  });

  it("returns null when no escrow payment exists", () => {
    expect(refundPayment("no-such-task")).toBeNull();
  });
});

// ── Queries ───────────────────────────────────────────────────────────────────

describe("getPaymentById / getPaymentByTaskId / getPaymentByIncomingSignature", () => {
  it("retrieves payment by txId", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const sig = mockSig(1_000_000, 30);
    const p = await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: sig,
      priceString: "1 USDC",
    });

    const found = getPaymentById(p.txId);
    expect(found).not.toBeNull();
    expect(found!.txId).toBe(p.txId);
  });

  it("returns null for unknown txId", () => {
    expect(getPaymentById("nonexistent")).toBeNull();
  });

  it("retrieves payment by taskId", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, 31),
      priceString: "1 USDC",
    });

    const found = getPaymentByTaskId(task.taskId);
    expect(found).not.toBeNull();
    expect(found!.taskId).toBe(task.taskId);
  });

  it("retrieves payment by incoming signature", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const sig = mockSig(1_000_000, 32);

    await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: sig,
      priceString: "1 USDC",
    });

    const found = getPaymentByIncomingSignature(sig);
    expect(found).not.toBeNull();
    expect(found!.incomingSignature).toBe(sig);
  });
});

describe("getPaymentsByAgent", () => {
  it("returns payments where agent is sender or receiver", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, 40),
      priceString: "1 USDC",
    });

    expect(getPaymentsByAgent(sender.agentId)).toHaveLength(1);
    expect(getPaymentsByAgent(worker.agentId)).toHaveLength(1);
    expect(getPaymentsByAgent("unknown-agent")).toHaveLength(0);
  });
});

// ── getAgentBalance ───────────────────────────────────────────────────────────

describe("getAgentBalance", () => {
  it("returns zero balances for a fresh agent", () => {
    const agent = makeAgent();
    createAgent(agent);
    const balance = getAgentBalance(agent.agentId);
    expect(balance.totalEarned).toBe(0);
    expect(balance.totalSpent).toBe(0);
    expect(balance.totalEscrow).toBe(0);
    expect(balance.netBalance).toBe(0);
    expect(balance.tasksPaid).toBe(0);
  });

  it("reflects completed payments in earned/spent", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 2,
      paymentSignature: mockSig(2_000_000, 50),
      priceString: "2 USDC",
    });
    releasePayment(task.taskId);

    const workerBalance = getAgentBalance(worker.agentId);
    expect(workerBalance.totalEarned).toBe(2);
    expect(workerBalance.tasksPaid).toBe(1);

    const senderBalance = getAgentBalance(sender.agentId);
    expect(senderBalance.totalSpent).toBe(2);
  });

  it("counts escrow payments correctly", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, 51),
      priceString: "1 USDC",
    });

    const balance = getAgentBalance(sender.agentId);
    expect(balance.totalEscrow).toBe(1);
  });
});

// ── webhook queue failure is non-fatal ────────────────────────────────────────

describe("releasePayment: webhook queue failure is non-fatal", () => {
  it("still returns the settled payment when queueWebhookEvent throws", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, 70),
      priceString: "1 USDC",
    });

    vi.spyOn(webhooksModule, "queueWebhookEvent").mockImplementationOnce(() => {
      throw new Error("webhook queue unavailable");
    });

    const released = releasePayment(task.taskId);
    expect(released).not.toBeNull();
    expect(released!.status).toBe("completed");
  });
});

describe("refundPayment: webhook queue failure is non-fatal", () => {
  it("still returns the refunded payment when queueWebhookEvent throws", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "x" });

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountSol: 1,
      paymentSignature: mockSig(1_000_000, 71),
      priceString: "1 USDC",
    });

    vi.spyOn(webhooksModule, "queueWebhookEvent").mockImplementationOnce(() => {
      throw new Error("webhook queue unavailable");
    });

    const refunded = refundPayment(task.taskId);
    expect(refunded).not.toBeNull();
    expect(refunded!.status).toBe("refunded");
  });
});

