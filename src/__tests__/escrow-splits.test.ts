import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { defineSplits, getSplitsForTask, computeSplitAmounts } from "@/lib/escrowSplits";
import { releasePayment, getPaymentByTaskId } from "@/lib/payments";
import { getReceipt } from "@/lib/receipts";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
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
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at)
       VALUES (?, ?, ?, ?, ?, 'escrow', NULL, 0, 'USDC', ?)`
    )
    .run(randomUUID(), taskId, fromAgent, toAgent, amount, new Date().toISOString());
}

function earned(agentId: string): number {
  return (
    getDb()
      .prepare("SELECT COALESCE(SUM(amount_sol),0) AS v FROM transactions WHERE to_agent=? AND status='completed'")
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

  it("computeSplitAmounts divides exactly, remainder to the first recipient", () => {
    const parts = computeSplitAmounts(0.1, [
      { agentId: "a", shareBps: 3333 },
      { agentId: "b", shareBps: 3333 },
      { agentId: "c", shareBps: 3334 },
    ]);
    const total = parts.reduce((s, p) => s + p.amount, 0);
    expect(Math.round(total * 1e6)).toBe(100_000); // 0.10 USDC, no dust lost
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
      .prepare("SELECT COALESCE(SUM(amount_sol),0) AS v FROM transactions WHERE task_id=? AND status='completed'")
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
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at)
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
    expect(payment?.amountSol).toBeCloseTo(0.1, 6);
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
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at)
         VALUES (?, ?, ?, ?, ?, 'escrow', ?, 0, 'USDC', ?)`
      )
      .run(randomUUID(), taskId, payer.agentId, a.agentId, 0.1, sig, new Date().toISOString());
    defineSplits(taskId, [
      { agentId: a.agentId, shareBps: 6000 },
      { agentId: b.agentId, shareBps: 4000 },
    ]);
    releasePayment(taskId);

    const receipt = getReceipt(taskId);
    expect(receipt.payment?.amountSol).toBeCloseTo(0.1, 6); // total, not a recipient share
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
