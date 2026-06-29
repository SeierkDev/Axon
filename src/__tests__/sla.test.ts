import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  defineSla,
  getSlaForTask,
  resolveSlaOnCompletion,
  settleCompletedTask,
  enforceSlaDeadlines,
} from "@/lib/sla";
import { releaseWithPenalty } from "@/lib/payments";
import { defineSplits } from "@/lib/escrowSplits";
import { getReceipt } from "@/lib/receipts";
import { createTask } from "@/lib/tasks";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let counter = 0;

function makeAgent(): Agent {
  counter++;
  const a: Agent = {
    agentId: `sla-${counter}`,
    name: `SLA Agent ${counter}`,
    capabilities: ["x"],
    publicKey: `pk-sla-${counter}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

function makeTask(from: string, to: string): string {
  return createTask({ fromAgent: from, toAgent: to, task: "do the thing" }).taskId;
}

function escrow(taskId: string, from: string, to: string, amount: number): void {
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at)
       VALUES (?, ?, ?, ?, ?, 'escrow', NULL, 0, 'USDC', ?)`
    )
    .run(randomUUID(), taskId, from, to, amount, new Date().toISOString());
}

function sum(agentId: string, status: string, column: "to_agent" | "from_agent"): number {
  return (
    getDb()
      .prepare(`SELECT COALESCE(SUM(amount_sol),0) AS v FROM transactions WHERE ${column}=? AND status=?`)
      .get(agentId, status) as { v: number }
  ).v;
}
const earned = (id: string) => sum(id, "completed", "to_agent");
const refundedTo = (id: string) => sum(id, "refunded", "to_agent");

const future = (ms: number) => new Date(Date.now() + ms).toISOString();
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("task SLAs", () => {
  it("defines an SLA on a task", () => {
    const c = makeAgent();
    const p = makeAgent();
    const taskId = makeTask(c.agentId, p.agentId);
    const r = defineSla(taskId, 300, 1500);
    expect(r.success).toBe(true);
    const sla = getSlaForTask(taskId);
    expect(sla?.penaltyBps).toBe(1500);
    expect(sla?.status).toBe("active");
    // The receipt surfaces the SLA so a settlement explains itself.
    expect(getReceipt(taskId).sla?.slaId).toBe(sla?.slaId);
  });

  it("rejects an unknown task, bad penalty, and bad deadline", () => {
    const c = makeAgent();
    const p = makeAgent();
    const taskId = makeTask(c.agentId, p.agentId);
    expect(defineSla("no-such-task", 300, 1000)).toMatchObject({ success: false, code: "NOT_FOUND" });
    expect(defineSla(taskId, 300, 0)).toMatchObject({ success: false, code: "INVALID" });
    expect(defineSla(taskId, 300, 10001)).toMatchObject({ success: false, code: "INVALID" });
    expect(defineSla(taskId, 0, 1000)).toMatchObject({ success: false, code: "INVALID" });
  });

  it("rejects an SLA once the task is running or already settled", () => {
    const c = makeAgent();
    const p = makeAgent();

    // Running: terms are locked so a client can't grief the provider mid-flight.
    const running = makeTask(c.agentId, p.agentId);
    getDb().prepare("UPDATE tasks SET status='running', started_at=? WHERE task_id=?").run(future(0), running);
    expect(defineSla(running, 300, 1000)).toMatchObject({ success: false, code: "INVALID" });

    // Settled.
    const settled = makeTask(c.agentId, p.agentId);
    getDb().prepare("UPDATE tasks SET status='completed', completed_at=? WHERE task_id=?").run(future(0), settled);
    expect(defineSla(settled, 300, 1000)).toMatchObject({ success: false, code: "INVALID" });
  });

  it("marks an on-time completion as met and a late one as breached", () => {
    const c = makeAgent();
    const p = makeAgent();
    const onTime = makeTask(c.agentId, p.agentId);
    defineSla(onTime, 3600, 2000); // deadline ~1h out
    expect(resolveSlaOnCompletion(onTime, future(0))).toEqual({ breached: false, penaltyBps: 2000 });
    expect(getSlaForTask(onTime)?.status).toBe("met");

    const late = makeTask(c.agentId, p.agentId);
    defineSla(late, 1, 2000); // deadline ~1s out
    const res = resolveSlaOnCompletion(late, future(60_000)); // completed a minute later
    expect(res).toEqual({ breached: true, penaltyBps: 2000 });
    expect(getSlaForTask(late)?.status).toBe("breached");
  });

  it("returns null when resolving a task with no SLA", () => {
    const c = makeAgent();
    const p = makeAgent();
    expect(resolveSlaOnCompletion(makeTask(c.agentId, p.agentId), future(0))).toBeNull();
  });

  it("releaseWithPenalty docks the provider and refunds the client, summing to the total", () => {
    const c = makeAgent();
    const p = makeAgent();
    const taskId = makeTask(c.agentId, p.agentId);
    escrow(taskId, c.agentId, p.agentId, 1.0);

    releaseWithPenalty(taskId, 1000); // 10% penalty
    expect(earned(p.agentId)).toBeCloseTo(0.9, 9);
    expect(refundedTo(c.agentId)).toBeCloseTo(0.1, 9);
    // Original escrow row preserved for audit, marked 'split'.
    const escrowRow = getDb().prepare("SELECT status FROM transactions WHERE task_id=? AND incoming_signature IS NULL AND amount_sol=1.0").get(taskId) as { status?: string } | undefined;
    expect(escrowRow?.status).toBe("split");
  });

  it("distributes the docked payout across an escrow split when both apply", () => {
    const c = makeAgent();
    const x = makeAgent();
    const y = makeAgent();
    const taskId = makeTask(c.agentId, x.agentId);
    escrow(taskId, c.agentId, x.agentId, 1.0);
    defineSplits(taskId, [
      { agentId: x.agentId, shareBps: 6000 },
      { agentId: y.agentId, shareBps: 4000 },
    ]);

    releaseWithPenalty(taskId, 1000); // 10% penalty → reduced payout 0.9 split 60/40
    expect(earned(x.agentId)).toBeCloseTo(0.54, 9);
    expect(earned(y.agentId)).toBeCloseTo(0.36, 9);
    expect(refundedTo(c.agentId)).toBeCloseTo(0.1, 9);
  });

  it("treats a 100% penalty as a full refund and a 0% as a full release", () => {
    const c = makeAgent();
    const p = makeAgent();

    const full = makeTask(c.agentId, p.agentId);
    escrow(full, c.agentId, p.agentId, 2.0);
    releaseWithPenalty(full, 10000);
    expect(earned(p.agentId)).toBe(0);

    const none = makeTask(c.agentId, p.agentId);
    escrow(none, c.agentId, p.agentId, 2.0);
    releaseWithPenalty(none, 0);
    expect(earned(p.agentId)).toBeCloseTo(2.0, 9);
  });

  it("settleCompletedTask applies the penalty only when breached", () => {
    const c = makeAgent();
    const p = makeAgent();

    // Breached: completed after the deadline.
    const breached = makeTask(c.agentId, p.agentId);
    escrow(breached, c.agentId, p.agentId, 1.0);
    defineSla(breached, 1, 2500); // deadline ~1s out
    getDb().prepare("UPDATE tasks SET status='completed', completed_at=? WHERE task_id=?").run(future(60_000), breached);
    settleCompletedTask(breached);
    expect(earned(p.agentId)).toBeCloseTo(0.75, 9);
    expect(refundedTo(c.agentId)).toBeCloseTo(0.25, 9);
    expect(getSlaForTask(breached)?.status).toBe("breached");
  });

  it("settleCompletedTask releases in full when met", () => {
    const c = makeAgent();
    const p = makeAgent();
    const met = makeTask(c.agentId, p.agentId);
    escrow(met, c.agentId, p.agentId, 1.0);
    defineSla(met, 3600, 2500);
    getDb().prepare("UPDATE tasks SET status='completed', completed_at=? WHERE task_id=?").run(future(0), met);
    settleCompletedTask(met);
    expect(earned(p.agentId)).toBeCloseTo(1.0, 9);
    expect(getSlaForTask(met)?.status).toBe("met");
  });

  it("the sweep fails a task past its deadline and refunds the client in full", () => {
    const c = makeAgent();
    const p = makeAgent();
    const taskId = makeTask(c.agentId, p.agentId); // queued
    escrow(taskId, c.agentId, p.agentId, 1.0);
    defineSla(taskId, 1, 3000); // deadline ~1s out

    // Sweep from 10s in the future → the deadline has passed.
    const result = enforceSlaDeadlines(future(10_000));
    expect(result.breached).toContain(taskId);

    expect((getDb().prepare("SELECT status FROM tasks WHERE task_id=?").get(taskId) as { status: string }).status).toBe("failed");
    expect(getSlaForTask(taskId)?.status).toBe("breached");
    expect(earned(p.agentId)).toBe(0); // provider got nothing
    expect((getDb().prepare("SELECT status FROM transactions WHERE task_id=? AND amount_sol=1.0").get(taskId) as { status: string }).status).toBe("refunded");
  });

  it("the sweep leaves a not-yet-due SLA untouched", () => {
    const c = makeAgent();
    const p = makeAgent();
    const taskId = makeTask(c.agentId, p.agentId);
    defineSla(taskId, 3600, 1000); // deadline ~1h out
    const result = enforceSlaDeadlines(future(0));
    expect(result.breached).not.toContain(taskId);
    expect(getSlaForTask(taskId)?.status).toBe("active");
  });
});
