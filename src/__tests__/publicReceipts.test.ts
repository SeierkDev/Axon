// Public receipts (/r/<taskId>): the shareable, metadata-only view of a task.
// The privacy rule is the contract — task content and output must NEVER leak.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getPublicReceipt } from "@/lib/receipts";
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
