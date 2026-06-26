// Mock payment verifier — set before imports
process.env.AXON_PAYMENT_VERIFIER = "mock";

import { describe, it, expect } from "vitest";
import {
  parseMppUsdcAmount,
  parseMppUsdcPrice,
  createChannel,
  deleteChannel,
  getChannelById,
  getChannelsByOwner,
  verifyChannelKey,
  recordDeposit,
  debitChannel,
  refundDebitForTask,
  claimChannelClose,
  finalizeChannelClose,
  verifyMppDeposit,
} from "@/lib/mpp";
import { createTask, startTask } from "@/lib/tasks";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";

const TEST_WALLET = "11111111111111111111111111111111";
const TEST_WALLET_2 = "11111111111111111111111111111112";
let counter = 0;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  counter++;
  return {
    agentId: `mpp-${counter}`,
    name: `MPP Agent ${counter}`,
    capabilities: ["research"],
    publicKey: `pk${counter}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// Convenience: create a funded channel for testing debit/close operations
function openFundedChannel(ownerAddress = TEST_WALLET, microUsdc = 5_000_000) {
  const { channel, channelKey } = createChannel(ownerAddress);
  recordDeposit(channel.channelId, { amountUsdc: microUsdc / 1_000_000, microUsdc }, `sig-${counter++}`);
  return { channel, channelKey };
}

// ── parseMppUsdcAmount / parseMppUsdcPrice ────────────────────────────────────

describe("parseMppUsdcAmount", () => {
  it("parses a valid USDC amount number", () => {
    const result = parseMppUsdcAmount(1.5);
    expect(result).not.toBeNull();
    expect(result!.amountUsdc).toBe(1.5);
    expect(result!.microUsdc).toBe(1_500_000);
  });

  it("parses a valid USDC amount string", () => {
    const result = parseMppUsdcAmount("2.00");
    expect(result).not.toBeNull();
    expect(result!.amountUsdc).toBe(2);
    expect(result!.microUsdc).toBe(2_000_000);
  });

  it("returns null for invalid input", () => {
    expect(parseMppUsdcAmount("not-a-number")).toBeNull();
    expect(parseMppUsdcAmount(-1)).toBeNull();
    expect(parseMppUsdcAmount(null)).toBeNull();
  });
});

describe("parseMppUsdcPrice", () => {
  it("parses USDC price string", () => {
    const result = parseMppUsdcPrice("3 USDC");
    expect(result).not.toBeNull();
    expect(result!.amountUsdc).toBe(3);
    expect(result!.microUsdc).toBe(3_000_000);
  });

  it("returns null for SOL price", () => {
    expect(parseMppUsdcPrice("0.05 SOL")).toBeNull();
  });

  it("returns null for invalid price", () => {
    expect(parseMppUsdcPrice("invalid")).toBeNull();
  });

  it("returns null for an amount exceeding MAX_SAFE_INTEGER micro-USDC", () => {
    // 9_007_199_255 USDC → units = 9_007_199_255_000_000 > Number.MAX_SAFE_INTEGER (9_007_199_254_740_991)
    expect(parseMppUsdcPrice("9007199255 USDC")).toBeNull();
  });
});

describe("parseMppUsdcAmount: out-of-safe-integer guard", () => {
  it("returns null for an amount exceeding MAX_SAFE_INTEGER micro-USDC", () => {
    // 9_007_199_255 USDC → units = 9_007_199_255_000_000 > Number.MAX_SAFE_INTEGER
    expect(parseMppUsdcAmount(9_007_199_255)).toBeNull();
  });
});

// ── createChannel / getChannelById / getChannelsByOwner / deleteChannel ────────

describe("createChannel", () => {
  it("creates a channel with open status and 0 balance", () => {
    const { channel, channelKey } = createChannel(TEST_WALLET);
    expect(channel.channelId).toBeDefined();
    expect(channel.status).toBe("open");
    expect(channel.balanceUsdc).toBe(0);
    expect(channel.ownerAddress).toBe(TEST_WALLET);
    expect(channelKey).toBeDefined();
    expect(channelKey.length).toBeGreaterThan(30);
  });

  it("returns a unique channelKey each time", () => {
    const a = createChannel(TEST_WALLET);
    const b = createChannel(TEST_WALLET);
    expect(a.channelKey).not.toBe(b.channelKey);
    expect(a.channel.channelId).not.toBe(b.channel.channelId);
  });
});

describe("getChannelById", () => {
  it("retrieves an existing channel", () => {
    const { channel } = createChannel(TEST_WALLET);
    const found = getChannelById(channel.channelId);
    expect(found).not.toBeNull();
    expect(found!.channelId).toBe(channel.channelId);
  });

  it("returns null for unknown channelId", () => {
    expect(getChannelById("nonexistent")).toBeNull();
  });
});

describe("getChannelsByOwner", () => {
  it("returns all channels for an owner", () => {
    createChannel(TEST_WALLET_2);
    createChannel(TEST_WALLET_2);
    const channels = getChannelsByOwner(TEST_WALLET_2);
    expect(channels.length).toBeGreaterThanOrEqual(2);
    expect(channels.every((c) => c.ownerAddress === TEST_WALLET_2)).toBe(true);
  });

  it("returns empty array for unknown owner", () => {
    expect(getChannelsByOwner("unknown-wallet")).toHaveLength(0);
  });
});

describe("deleteChannel", () => {
  it("removes the channel from the DB", () => {
    const { channel } = createChannel(TEST_WALLET);
    deleteChannel(channel.channelId);
    expect(getChannelById(channel.channelId)).toBeNull();
  });
});

describe("verifyChannelKey", () => {
  it("returns true for the correct key", () => {
    const { channel, channelKey } = createChannel(TEST_WALLET);
    expect(verifyChannelKey(channel.channelId, channelKey)).toBe(true);
  });

  it("returns false for the wrong key", () => {
    const { channel } = createChannel(TEST_WALLET);
    expect(verifyChannelKey(channel.channelId, "wrong-key")).toBe(false);
  });

  it("returns false for unknown channelId", () => {
    expect(verifyChannelKey("nonexistent", "any-key")).toBe(false);
  });
});

// ── recordDeposit ─────────────────────────────────────────────────────────────

describe("recordDeposit", () => {
  it("credits the channel balance", () => {
    const { channel } = createChannel(TEST_WALLET);
    recordDeposit(channel.channelId, { amountUsdc: 5, microUsdc: 5_000_000 }, `deposit-sig-${counter++}`);

    const updated = getChannelById(channel.channelId);
    expect(updated!.balanceUsdc).toBe(5);
  });

  it("rejects duplicate signature", () => {
    const { channel } = createChannel(TEST_WALLET);
    const sig = `deposit-dup-${counter++}`;
    recordDeposit(channel.channelId, { amountUsdc: 1, microUsdc: 1_000_000 }, sig);
    expect(() =>
      recordDeposit(channel.channelId, { amountUsdc: 1, microUsdc: 1_000_000 }, sig)
    ).toThrow("Deposit signature already used");
  });

  it("rejects deposit to non-existent channel", () => {
    expect(() =>
      recordDeposit("nonexistent", { amountUsdc: 1, microUsdc: 1_000_000 }, `sig-${counter++}`)
    ).toThrow("Channel not found or not open");
  });
});

// ── debitChannel ──────────────────────────────────────────────────────────────

describe("debitChannel", () => {
  it("debits balance and returns remaining", () => {
    const { channel } = openFundedChannel();
    const result = debitChannel(channel.channelId, "agent-x", { amountUsdc: 1, microUsdc: 1_000_000 });
    expect(result.success).toBe(true);
    expect(result.remainingBalance).toBe(4);
  });

  it("fails when balance is insufficient", () => {
    const { channel } = openFundedChannel(TEST_WALLET, 500_000); // 0.5 USDC
    const result = debitChannel(channel.channelId, "agent-x", { amountUsdc: 1, microUsdc: 1_000_000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Insufficient balance/);
  });

  it("fails for unknown channel", () => {
    const result = debitChannel("nonexistent", "agent-x", { amountUsdc: 1, microUsdc: 1_000_000 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Channel not found/);
  });

  it("records debit with optional taskId", () => {
    const { channel } = openFundedChannel();
    const result = debitChannel(channel.channelId, "agent-x", { amountUsdc: 1, microUsdc: 1_000_000 }, "task-123");
    expect(result.success).toBe(true);
  });
});

// ── refundDebitForTask ────────────────────────────────────────────────────────

describe("refundDebitForTask", () => {
  it("refunds debit for task and restores balance", () => {
    const { channel } = openFundedChannel();
    debitChannel(channel.channelId, "agent-x", { amountUsdc: 2, microUsdc: 2_000_000 }, "task-refund-1");
    const result = refundDebitForTask("task-refund-1");
    expect(result.success).toBe(true);

    const updated = getChannelById(channel.channelId);
    expect(updated!.balanceUsdc).toBe(5); // restored to original
  });

  it("returns success (no-op) for unknown taskId", () => {
    const result = refundDebitForTask("nonexistent-task");
    expect(result.success).toBe(true);
  });

  it("does NOT re-credit a closed channel (no phantom funds)", () => {
    const { channel } = openFundedChannel(TEST_WALLET, 5_000_000);
    debitChannel(channel.channelId, "agent-x", { amountUsdc: 2, microUsdc: 2_000_000 }, "task-closed-refund");
    // Close + settle the channel: balance is zeroed on-chain at close.
    claimChannelClose(channel.channelId);
    finalizeChannelClose(channel.channelId, true);
    expect(getChannelById(channel.channelId)!.status).toBe("closed");
    expect(getChannelById(channel.channelId)!.balanceUsdc).toBe(0);

    // A late refund (e.g. the completed task is requeued/failed) must not credit
    // the already-settled, closed channel.
    refundDebitForTask("task-closed-refund");
    expect(getChannelById(channel.channelId)!.balanceUsdc).toBe(0);
  });
});

// ── claimChannelClose / finalizeChannelClose ──────────────────────────────────

describe("claimChannelClose", () => {
  it("transitions open → closing when no pending debits", () => {
    const { channel } = openFundedChannel();
    const result = claimChannelClose(channel.channelId);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("closing");
  });

  it("returns null if channel has pending task debits", () => {
    const sender = makeAgent();
    const worker = makeAgent();
    createAgent(sender);
    createAgent(worker);
    const { channel } = openFundedChannel();
    const task = createTask({ fromAgent: sender.agentId, toAgent: worker.agentId, task: "pending" });
    startTask(task.taskId);
    debitChannel(channel.channelId, worker.agentId, { amountUsdc: 1, microUsdc: 1_000_000 }, task.taskId);

    const result = claimChannelClose(channel.channelId);
    expect(result).toBeNull(); // cannot close with running tasks
  });

  it("returns null for unknown channel", () => {
    expect(claimChannelClose("nonexistent")).toBeNull();
  });
});

describe("finalizeChannelClose", () => {
  it("transitions closing → closed and zeroes balance when zeroBalance=true", () => {
    const { channel } = openFundedChannel();
    claimChannelClose(channel.channelId);
    const result = finalizeChannelClose(channel.channelId, true);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("closed");
    expect(result!.balanceUsdc).toBe(0);
  });

  it("transitions closing → closed preserving balance when zeroBalance=false", () => {
    const { channel } = openFundedChannel(TEST_WALLET, 3_000_000);
    claimChannelClose(channel.channelId);
    const result = finalizeChannelClose(channel.channelId, false);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("closed");
    expect(result!.balanceUsdc).toBe(3);
  });

  it("returns null for channel not in closing state", () => {
    const { channel } = openFundedChannel();
    expect(finalizeChannelClose(channel.channelId, true)).toBeNull();
  });
});

// ── verifyMppDeposit (mock verifier) ──────────────────────────────────────────

describe("verifyMppDeposit (mock verifier)", () => {
  it("returns verified=true for valid mock signature", async () => {
    const amount = { amountUsdc: 1, microUsdc: 1_000_000 };
    const sig = `mockpay:USDC:1000000:${TEST_WALLET}:${TEST_WALLET}:${counter++}`;
    const result = await verifyMppDeposit(sig, amount, TEST_WALLET);
    expect(result.verified).toBe(true);
  });

  it("returns verified=false for mismatched amount", async () => {
    const amount = { amountUsdc: 2, microUsdc: 2_000_000 }; // expect 2 USDC
    const sig = `mockpay:USDC:1000000:${TEST_WALLET}:${TEST_WALLET}:${counter++}`; // only 1 USDC
    const result = await verifyMppDeposit(sig, amount, TEST_WALLET);
    expect(result.verified).toBe(false);
  });

  it("returns verified=false for duplicate signature", async () => {
    const { channel } = createChannel(TEST_WALLET);
    const amount = { amountUsdc: 1, microUsdc: 1_000_000 };
    const sig = `mockpay:USDC:1000000:${TEST_WALLET}:${TEST_WALLET}:dup-${counter++}`;
    recordDeposit(channel.channelId, amount, sig);

    const result = await verifyMppDeposit(sig, amount);
    expect(result.verified).toBe(false);
    expect(result.error).toMatch(/already used/);
  });
});
