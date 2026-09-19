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
  parsePriceToEth,
} from "@/lib/payments";
import * as webhooksModule from "@/lib/webhooks";
import { createAgent } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";
import { toWei } from "@/lib/money";

afterEach(() => { vi.restoreAllMocks(); });

// system program address — valid Solana pubkey, used as test wallet
const TEST_WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
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

// mockpay:CURRENCY:WEI:SIGNER:RECEIVER:NONCE — the amount is given in ETH and converted, so a test
// never hand-writes a wei literal that could drift from what the code computes.
// PAYMENT_RECEIVER_WALLET_ADDRESS is set to TEST_WALLET in setup.ts
function mockSig(eth: number | string, nonce: string | number, currency = "ETH"): string {
  return `mockpay:${currency}:${toWei(eth)}:${TEST_WALLET}:${TEST_WALLET}:${nonce}`;
}

// ── parsePriceToEth ───────────────────────────────────────────────────────────

describe("parsePriceToEth", () => {
  it("parses SOL price string", () => {
    expect(parsePriceToEth("0.05 ETH")).toBe(0.05);
  });
  it("parses an ETH price string", () => {
    expect(parsePriceToEth("0.005 ETH")).toBe(0.005);
  });
  it("returns null for undefined", () => {
    expect(parsePriceToEth(undefined)).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(parsePriceToEth("")).toBeNull();
  });
  it("returns null for invalid string", () => {
    expect(parsePriceToEth("not-a-price")).toBeNull();
  });
});

// ── createPayment: mock verifier rejects invalid payments ─────────────────────

describe("createPayment: mock verifier rejects wrong-amount", () => {
  it("rejects when payment units are less than expected", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    // Expected: 1 USDC = 1_000_000 micro-USDC, signature only covers 500_000
    const sig = `mockpay:ETH:${toWei(0.0005)}:${TEST_WALLET}:${TEST_WALLET}:wrong-amt`;
    await expect(
      createPayment({
        fromAgent: sender.agentId,
        toAgent: worker.agentId,
        amountEth: 1,
        paymentSignature: sig,
        priceString: "0.001 ETH",
      })
    ).rejects.toThrow(/not verified on-chain/);
  });

  it("rejects when payment is for the wrong currency", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    // SOL units encoded but expected currency is USDC
    const sig = `mockpay:ETH:1000000:${TEST_WALLET}:${TEST_WALLET}:wrong-currency`;
    await expect(
      createPayment({
        fromAgent: sender.agentId,
        toAgent: worker.agentId,
        amountEth: 1,
        paymentSignature: sig,
        priceString: "0.001 ETH",
      })
    ).rejects.toThrow(/not verified on-chain/);
  });
});

describe("createPayment: mock verifier rejects wrong-recipient", () => {
  it("rejects when payment recipient does not match the treasury wallet", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const WRONG_WALLET = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
    const sig = `mockpay:ETH:${toWei(0.001)}:${TEST_WALLET}:${WRONG_WALLET}:wrong-recv`;
    await expect(
      createPayment({
        fromAgent: sender.agentId,
        toAgent: worker.agentId,
        amountEth: 1,
        paymentSignature: sig,
        priceString: "0.001 ETH",
      })
    ).rejects.toThrow(/not verified on-chain/);
  });

  it("rejects when signer does not match payer wallet", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const WRONG_SIGNER = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
    const sig = `mockpay:ETH:${toWei(0.001)}:${WRONG_SIGNER}:${TEST_WALLET}:wrong-signer`;
    await expect(
      createPayment({
        fromAgent: sender.agentId,
        toAgent: worker.agentId,
        amountEth: 1,
        paymentSignature: sig,
        priceString: "0.001 ETH",
      })
    ).rejects.toThrow(/not verified on-chain/);
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
      amountEth: 1,
      paymentSignature: mockSig(0.001, 1),
      priceString: "0.001 ETH",
    });

    expect(payment.txId).toBeDefined();
    expect(payment.status).toBe("escrow");
    expect(payment.fromAgent).toBe(sender.agentId);
    expect(payment.toAgent).toBe(worker.agentId);
    expect(payment.taskId).toBe(task.taskId);
    expect(payment.currency).toBe("ETH");
    expect(payment.incomingSignature).toBe(mockSig(0.001, 1));
  });

  it("rejects duplicate payment signature", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const sig = mockSig(0.001, 2);

    await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountEth: 1,
      paymentSignature: sig,
      priceString: "0.001 ETH",
    });

    await expect(
      createPayment({
        fromAgent: sender.agentId,
        toAgent: worker.agentId,
        amountEth: 1,
        paymentSignature: sig,
        priceString: "0.001 ETH",
      })
    ).rejects.toThrow("Payment signature already used");
  });

  it("rejects when payer wallet cannot be resolved", async () => {
    await expect(
      createPayment({
        fromAgent: "unknown-agent-id",
        toAgent: "another-agent",
        amountEth: 1,
        paymentSignature: mockSig(0.001, 99),
        priceString: "0.001 ETH",
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
        amountEth: 0,
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
      amountEth: 1,
      paymentSignature: mockSig(0.001, 10),
      priceString: "0.001 ETH",
    });

    const released = releasePayment(task.taskId);
    expect(released).not.toBeNull();
    expect(released!.status).toBe("completed");
    expect(released!.settledAt).toBeDefined();
  });

  it("returns null when no escrow payment exists for task", () => {
    expect(releasePayment("no-such-task")).toBeNull();
  });

  it("sets burn_status=pending for platform agent payments", async () => {
    const sender = makeAgent();
    const platform = makeAgent({ verificationStatus: "platform" });
    createAgent(sender);
    createAgent(platform);
    const task = createTask({ fromAgent: sender.agentId, toAgent: platform.agentId, task: "x" });

    await createPayment({
      taskId: task.taskId,
      fromAgent: sender.agentId,
      toAgent: platform.agentId,
      amountEth: 2,
      paymentSignature: mockSig(0.002, "burn-1"),
      priceString: "0.002 ETH",
    });

    releasePayment(task.taskId);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT burn_status FROM transactions WHERE task_id = ?")
      .get(task.taskId) as { burn_status: string } | undefined;
    expect(row?.burn_status).toBe("pending");
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
      amountEth: 1,
      paymentSignature: mockSig(0.001, 20),
      priceString: "0.001 ETH",
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
    const sig = mockSig(0.001, 30);
    const p = await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountEth: 1,
      paymentSignature: sig,
      priceString: "0.001 ETH",
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
      amountEth: 1,
      paymentSignature: mockSig(0.001, 31),
      priceString: "0.001 ETH",
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
    const sig = mockSig(0.001, 32);

    await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountEth: 1,
      paymentSignature: sig,
      priceString: "0.001 ETH",
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
      amountEth: 1,
      paymentSignature: mockSig(0.001, 40),
      priceString: "0.001 ETH",
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
      amountEth: 2,
      paymentSignature: mockSig(0.002, 50),
      priceString: "0.002 ETH",
    });
    releasePayment(task.taskId);

    // The VERIFIED amount is what lands in the ledger, which is the price string, not the
    // `amountEth` passed alongside it. When those two disagree the chain's answer wins.
    const workerBalance = getAgentBalance(worker.agentId);
    expect(workerBalance.totalEarned).toBe(0.002);
    expect(workerBalance.tasksPaid).toBe(1);

    const senderBalance = getAgentBalance(sender.agentId);
    expect(senderBalance.totalSpent).toBe(0.002);
  });

  it("counts escrow payments correctly", async () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);

    await createPayment({
      fromAgent: sender.agentId,
      toAgent: worker.agentId,
      amountEth: 1,
      paymentSignature: mockSig(0.001, 51),
      priceString: "0.001 ETH",
    });

    const balance = getAgentBalance(sender.agentId);
    expect(balance.totalEscrow).toBe(0.001);
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
      amountEth: 1,
      paymentSignature: mockSig(0.001, 70),
      priceString: "0.001 ETH",
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
      amountEth: 1,
      paymentSignature: mockSig(0.001, 71),
      priceString: "0.001 ETH",
    });

    vi.spyOn(webhooksModule, "queueWebhookEvent").mockImplementationOnce(() => {
      throw new Error("webhook queue unavailable");
    });

    const refunded = refundPayment(task.taskId);
    expect(refunded).not.toBeNull();
    expect(refunded!.status).toBe("refunded");
  });
});

