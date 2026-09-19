import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { defineSplits, getSplitsForTask, computeSplitAmounts } from "@/lib/escrowSplits";
import { releasePayment, getPaymentByTaskId } from "@/lib/payments";
import { getReceipt } from "@/lib/receipts";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";
import { toWei } from "@/lib/money";

const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
let counter = 0;

function makeAgent(): Agent {
  counter++;
  const a: Agent = {
    agentId: `split-${counter}`,
    name: `Split Agent ${counter}`,
    capabilities: ["x"],
    publicKey: `pk-split-${counter}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

// Insert an escrowed payment for a task directly (skips on-chain verification).
function escrow(taskId: string, fromAgent: string, toAgent: string, amount: number): void {
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at)
       VALUES (?, ?, ?, ?, ?, 'escrow', NULL, 0, 'USDC', ?)`
    )
    .run(randomUUID(), taskId, fromAgent, toAgent, amount, new Date().toISOString());
}

function earned(agentId: string): number {
  return (
    getDb()
      .prepare("SELECT COALESCE(SUM(amount_eth),0) AS v FROM transactions WHERE to_agent=? AND status='completed'")
      .get(agentId) as { v: number }
  ).v;
}

describe("escrow splits", () => {
  it("defines and lists a split", () => {
    const a = makeAgent();
    const b = makeAgent();
    const taskId = randomUUID();
    const r = defineSplits(taskId, [
      { agentId: a.agentId, shareBps: 6000 },
      { agentId: b.agentId, shareBps: 4000 },
    ]);
    expect(r.success).toBe(true);
    expect(getSplitsForTask(taskId).length).toBe(2);
  });

  it("rejects shares that don't sum to 10000", () => {
    const a = makeAgent();
    const b = makeAgent();
    const r = defineSplits(randomUUID(), [
      { agentId: a.agentId, shareBps: 6000 },
      { agentId: b.agentId, shareBps: 3000 },
    ]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects fewer than two recipients", () => {
    const a = makeAgent();
    const r = defineSplits(randomUUID(), [{ agentId: a.agentId, shareBps: 10000 }]);
    expect(r.success).toBe(false);
  });

  it("rejects a duplicate recipient", () => {
    const a = makeAgent();
    const r = defineSplits(randomUUID(), [
      { agentId: a.agentId, shareBps: 5000 },
      { agentId: a.agentId, shareBps: 5000 },
    ]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("INVALID");
  });

  it("rejects an unknown recipient agent", () => {
    const a = makeAgent();
    const r = defineSplits(randomUUID(), [
      { agentId: a.agentId, shareBps: 5000 },
      { agentId: "no-such-agent", shareBps: 5000 },
    ]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe("NOT_FOUND");
  });

  it("redefining a split replaces the previous one", () => {
    const a = makeAgent();
    const b = makeAgent();
    const c = makeAgent();
    const taskId = randomUUID();
    defineSplits(taskId, [
      { agentId: a.agentId, shareBps: 5000 },
      { agentId: b.agentId, shareBps: 5000 },
    ]);
    defineSplits(taskId, [
      { agentId: a.agentId, shareBps: 3000 },
      { agentId: c.agentId, shareBps: 7000 },
    ]);
    const splits = getSplitsForTask(taskId);
    expect(splits.length).toBe(2);
    expect(splits.some((s) => s.agentId === b.agentId)).toBe(false);
    expect(splits.some((s) => s.agentId === c.agentId)).toBe(true);
  });

  // The invariant that matters: what goes in comes out. Asserted in wei, because that is the unit
  // the division actually happens in and the only one where "exactly" means exactly.
  it("computeSplitAmounts divides exactly, remainder to the first recipient", () => {
    const total = toWei(0.1)!;
    const parts = computeSplitAmounts(total, [
      { agentId: "a", shareBps: 3333 },
      { agentId: "b", shareBps: 3333 },
      { agentId: "c", shareBps: 3334 },
    ]);
    expect(parts.reduce((s, p) => s + p.wei, 0n)).toBe(total);
  });

  // 7 wei across three shares cannot divide evenly, so there is always something left over.
  it("puts the leftover wei on the first recipient rather than losing it", () => {
    const total = 7n;
    const parts = computeSplitAmounts(total, [
      { agentId: "a", shareBps: 3333 },
      { agentId: "b", shareBps: 3333 },
      { agentId: "c", shareBps: 3334 },
    ]);
    expect(parts.reduce((s, p) => s + p.wei, 0n)).toBe(total);
    expect(parts[0].wei).toBeGreaterThan(parts[1].wei);
  });

  it("never distributes more than was escrowed, for any split", () => {
    const total = toWei("0.000000000000000007")!; // 7 wei, so every share has a remainder
    const shapes = [
      [5000, 5000],
      [3333, 3333, 3334],
      [1, 9999],
      [2500, 2500, 2500, 2500],
    ];
    for (const shape of shapes) {
      const parts = computeSplitAmounts(total, shape.map((shareBps, i) => ({ agentId: `a${i}`, shareBps })));
      expect(parts.reduce((s, p) => s + p.wei, 0n)).toBe(total);
      expect(parts.every((p) => p.wei >= 0n)).toBe(true);
    }
  });

  it("gives a single recipient the whole escrow", () => {
    const total = toWei(0.1)!;
    const parts = computeSplitAmounts(total, [{ agentId: "a", shareBps: 10_000 }]);
    expect(parts[0].wei).toBe(total);
  });

  it("releasePayment distributes the escrow across recipients by share", () => {
    const payer = makeAgent();
    const a = makeAgent();
    const b = makeAgent();
    const taskId = randomUUID();
    escrow(taskId, payer.agentId, a.agentId, 0.1);
    defineSplits(taskId, [
      { agentId: a.agentId, shareBps: 7000 },
      { agentId: b.agentId, shareBps: 3000 },
    ]);

    const released = releasePayment(taskId);
    expect(released).not.toBeNull();
    expect(earned(a.agentId)).toBeCloseTo(0.07, 6);
    expect(earned(b.agentId)).toBeCloseTo(0.03, 6);

    // Escrow fully settled, and the payouts sum to the original amount.
    const stillEscrow = getDb()
      .prepare("SELECT COUNT(*) AS v FROM transactions WHERE task_id=? AND status='escrow'")
      .get(taskId) as { v: number };
    expect(stillEscrow.v).toBe(0);
    const totalCompleted = getDb()
      .prepare("SELECT COALESCE(SUM(amount_eth),0) AS v FROM transactions WHERE task_id=? AND status='completed'")
      .get(taskId) as { v: number };
    expect(Math.round(totalCompleted.v * 1e6)).toBe(100_000);
  });

  it("preserves the original payment (total + signature) after a split settles", () => {
    const payer = makeAgent();
    const a = makeAgent();
    const b = makeAgent();
    const taskId = randomUUID();
    const sig = `sig-${taskId}`;
    getDb()
      .prepare(
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at)
         VALUES (?, ?, ?, ?, ?, 'escrow', ?, 0, 'USDC', ?)`
      )
      .run(randomUUID(), taskId, payer.agentId, a.agentId, 0.1, sig, new Date().toISOString());
    defineSplits(taskId, [
      { agentId: a.agentId, shareBps: 7000 },
      { agentId: b.agentId, shareBps: 3000 },
    ]);
    releasePayment(taskId);

    // getPaymentByTaskId returns the parent: full amount + the on-chain signature.
    const payment = getPaymentByTaskId(taskId);
    expect(payment?.amountEth).toBeCloseTo(0.1, 6);
    expect(payment?.incomingSignature).toBe(sig);
    expect(payment?.status).toBe("split");
    // Recipients are still credited their shares.
    expect(earned(a.agentId)).toBeCloseTo(0.07, 6);
    expect(earned(b.agentId)).toBeCloseTo(0.03, 6);
  });

  it("surfaces the split and the total payment on the receipt", () => {
    const payer = makeAgent();
    const a = makeAgent();
    const b = makeAgent();
    const taskId = randomUUID();
    const sig = `sig-${taskId}`;
    getDb()
      .prepare(
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at)
         VALUES (?, ?, ?, ?, ?, 'escrow', ?, 0, 'USDC', ?)`
      )
      .run(randomUUID(), taskId, payer.agentId, a.agentId, 0.1, sig, new Date().toISOString());
    defineSplits(taskId, [
      { agentId: a.agentId, shareBps: 6000 },
      { agentId: b.agentId, shareBps: 4000 },
    ]);
    releasePayment(taskId);

    const receipt = getReceipt(taskId);
    expect(receipt.payment?.amountEth).toBeCloseTo(0.1, 6); // total, not a recipient share
    expect(receipt.payment?.status).toBe("split");
    expect(receipt.splits.length).toBe(2);
  });

  it("without a split, releasePayment pays the single agent as before", () => {
    const payer = makeAgent();
    const a = makeAgent();
    const taskId = randomUUID();
    escrow(taskId, payer.agentId, a.agentId, 0.05);
    const released = releasePayment(taskId);
    expect(released).not.toBeNull();
    expect(earned(a.agentId)).toBeCloseTo(0.05, 6);
  });
});
