// Public receipts (/r/<taskId>): the shareable, metadata-only view of a task.
// The privacy rule is the contract — task content and output must NEVER leak.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getPublicReceipt, getAgentRecentWork } from "@/lib/receipts";
import { createTask, completeTask, startTask } from "@/lib/tasks";
import { commitOutput } from "@/lib/outputCommitment";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let n = 0;
function makeAgent(name: string): Agent {
  n++;
  const a: Agent = {
    agentId: `receipt-agent-${n}-${randomUUID().slice(0, 6)}`,
    name,
    capabilities: ["research"],
    publicKey: `pk-receipt-${n}`,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

const SECRET = "CONFIDENTIAL client brief: acquire competitor Zeta Corp";
const SECRET_OUT = "CONFIDENTIAL result: recommend the acquisition";

describe("getPublicReceipt", () => {
  it("returns metadata + hashes + verdict, never the task content or output", async () => {
    const from = makeAgent("Requester");
    const to = makeAgent("Worker");
    const task = createTask({ fromAgent: from.agentId, toAgent: to.agentId, task: SECRET, payment: "0.25 USDC" });
    startTask(task.taskId);
    completeTask(task.taskId, SECRET_OUT);
    // The output hash commits asynchronously after completion — do it explicitly.
    await commitOutput(task.taskId, SECRET_OUT);

    const r = getPublicReceipt(task.taskId);
    expect(r).not.toBeNull();
    expect(r!.fromName).toBe("Requester");
    expect(r!.toName).toBe("Worker");
    expect(r!.status).toBe("completed");
    expect(r!.specHash).toBeTruthy();
    expect(r!.outputHash).toBeTruthy();
    expect(r!.specVerified).toBe(true);
    expect(r!.completedAt).toBeTruthy();

    // The contract: NOTHING in the serialized receipt contains the content.
    const flat = JSON.stringify(r);
    expect(flat).not.toContain("CONFIDENTIAL");
    expect(flat).not.toContain("Zeta");
  });

  it("flags a tampered spec", () => {
    const from = makeAgent("Requester");
    const to = makeAgent("Worker");
    const task = createTask({ fromAgent: from.agentId, toAgent: to.agentId, task: "original agreement" });
    // Tamper with the agreed terms after creation.
    getDb().prepare("UPDATE tasks SET payment = '99 USDC' WHERE task_id = ?").run(task.taskId);
    const r = getPublicReceipt(task.taskId);
    expect(r!.specVerified).toBe(false);
  });

  it("includes the settlement when one exists", () => {
    const from = makeAgent("Requester");
    const to = makeAgent("Worker");
    const task = createTask({ fromAgent: from.agentId, toAgent: to.agentId, task: "job", payment: "0.10 USDC" });
    getDb()
      .prepare(
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, fee_amount, currency, signature, created_at, settled_at)
         VALUES (?, ?, ?, ?, 0.1, 'completed', 0, 'USDC', 'sig123abc', ?, ?)`,
      )
      .run(randomUUID(), task.taskId, from.agentId, to.agentId, new Date().toISOString(), new Date().toISOString());
    const r = getPublicReceipt(task.taskId);
    expect(r!.settlement).toMatchObject({ amount: 0.1, currency: "USDC", status: "completed", signature: "sig123abc" });
  });

  it("returns null for an unknown task", () => {
    expect(getPublicReceipt("no-such-task")).toBeNull();
  });
});

// ── An agent's recent work: the receipts behind the profile's totals ──────────

describe("getAgentRecentWork: the profile shows jobs, not just a count of them", () => {
  it("returns the agent's finished jobs, newest first, and never the task itself", () => {
    const worker = makeAgent("Recent Worker");
    const buyer = makeAgent("Recent Buyer");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = createTask({ fromAgent: buyer.agentId, toAgent: worker.agentId, task: `${SECRET} ${i}` });
      startTask(t.taskId);
      completeTask(t.taskId, `${SECRET_OUT} ${i}`);
      ids.push(t.taskId);
    }

    const work = getAgentRecentWork(worker.agentId, 10);
    expect(work.map((w) => w.taskId).sort()).toEqual([...ids].sort());

    // The whole point of the section is that it is checkable, so it must carry
    // the receipt identity and the proof fields...
    for (const w of work) {
      expect(w.taskId).toBeTruthy();
      expect(w.toAgent).toBe(worker.agentId);
    }
    // ...and nothing a receipt would not already show. This is the same contract
    // the /r/<taskId> page keeps, asserted again because a profile that leaks the
    // brief would leak it for every job the agent ever ran, not just one.
    const blob = JSON.stringify(work);
    expect(blob).not.toContain("CONFIDENTIAL");
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain(SECRET_OUT);
  });

  it("counts work the agent performed, not work it commissioned", () => {
    // A track record is what you did for other people. Hires this agent paid for
    // are somebody else's record, and showing them would let an agent inflate its
    // own page just by spending.
    const worker = makeAgent("Performer");
    const other = makeAgent("Other Side");
    const mine = createTask({ fromAgent: other.agentId, toAgent: worker.agentId, task: "for me" });
    startTask(mine.taskId); completeTask(mine.taskId, "done");
    const theirs = createTask({ fromAgent: worker.agentId, toAgent: other.agentId, task: "I hired out" });
    startTask(theirs.taskId); completeTask(theirs.taskId, "done");

    const ids = getAgentRecentWork(worker.agentId, 10).map((w) => w.taskId);
    expect(ids).toContain(mine.taskId);
    expect(ids).not.toContain(theirs.taskId);
  });

  it("shows failures too, so the list agrees with the success rate beside it", () => {
    const worker = makeAgent("Sometimes Fails");
    const buyer = makeAgent("Patient Buyer");
    const ok = createTask({ fromAgent: buyer.agentId, toAgent: worker.agentId, task: "fine" });
    startTask(ok.taskId); completeTask(ok.taskId, "done");
    const bad = createTask({ fromAgent: buyer.agentId, toAgent: worker.agentId, task: "not fine" });
    startTask(bad.taskId);
    getDb().prepare("UPDATE tasks SET status='failed', completed_at=? WHERE task_id=?")
      .run(new Date().toISOString(), bad.taskId);

    const work = getAgentRecentWork(worker.agentId, 10);
    expect(work.map((w) => w.status).sort()).toEqual(["completed", "failed"]);
  });

  it("leaves unfinished work out, and is empty for an agent that has done none", () => {
    const worker = makeAgent("Busy But Unfinished");
    const buyer = makeAgent("Waiting Buyer");
    const running = createTask({ fromAgent: buyer.agentId, toAgent: worker.agentId, task: "still going" });
    startTask(running.taskId);
    // In flight has no outcome to show and no settled receipt to check.
    expect(getAgentRecentWork(worker.agentId, 10)).toEqual([]);

    expect(getAgentRecentWork(makeAgent("Brand New").agentId, 10)).toEqual([]);
  });

  it("honours the limit even when the agent has a long history", () => {
    const worker = makeAgent("Prolific");
    const buyer = makeAgent("Repeat Buyer");
    for (let i = 0; i < 12; i++) {
      const t = createTask({ fromAgent: buyer.agentId, toAgent: worker.agentId, task: `job ${i}` });
      startTask(t.taskId); completeTask(t.taskId, "done");
    }
    expect(getAgentRecentWork(worker.agentId, 8)).toHaveLength(8);
  });
});
