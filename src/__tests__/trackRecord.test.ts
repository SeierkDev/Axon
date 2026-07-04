// Agent Track Records: the proof-backed public profile. Two contracts —
// (1) task content NEVER leaks; (2) the numbers MATCH the shared functions the
// Explorer/reputation use, so a track record can never contradict the network.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getAgentTrackRecord } from "@/lib/trackRecord";
import { computeReputation } from "@/lib/reputation";
import { createTask, completeTask, startTask } from "@/lib/tasks";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let n = 0;
function makeAgent(name: string): Agent {
  n++;
  const a: Agent = {
    agentId: `track-agent-${n}-${randomUUID().slice(0, 6)}`,
    name,
    capabilities: ["research"],
    publicKey: `pk-track-${n}`,
    provider: "anthropic",
    reputation: 7.5,
    category: "Research",
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

function completed(from: string, to: string, task: string, payment: string | null, ageMs = 1000): string {
  const t = createTask({ fromAgent: from, toAgent: to, task, payment: payment ?? undefined });
  startTask(t.taskId);
  completeTask(t.taskId, "OUTPUT — should never surface");
  if (ageMs) {
    const ts = new Date(Date.now() - ageMs).toISOString();
    getDb().prepare("UPDATE tasks SET completed_at = ?, started_at = ? WHERE task_id = ?").run(ts, ts, t.taskId);
  }
  return t.taskId;
}

describe("getAgentTrackRecord", () => {
  it("returns proof-backed stats + recent jobs, never task content", () => {
    const from = makeAgent("Requester");
    const to = makeAgent("Worker");
    const SECRET = "CONFIDENTIAL brief: acquire Zeta Corp";
    const id = completed(from.agentId, to.agentId, SECRET, "0.25 USDC");
    getDb()
      .prepare(
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, fee_amount, currency, created_at, settled_at)
         VALUES (?, ?, ?, ?, 0.25, 'completed', 0, 'USDC', ?, ?)`,
      )
      .run(randomUUID(), id, from.agentId, to.agentId, new Date().toISOString(), new Date().toISOString());

    const tr = getAgentTrackRecord(to.agentId);
    expect(tr).not.toBeNull();
    expect(tr!.name).toBe("Worker");
    expect(tr!.tasksCompleted).toBeGreaterThanOrEqual(1);
    expect(tr!.usdcEarned).toBeCloseTo(0.25, 6);
    expect(tr!.recentJobs[0]).toMatchObject({ taskId: id, counterparty: "Requester", payment: "0.25 USDC" });

    const flat = JSON.stringify(tr);
    expect(flat).not.toContain("CONFIDENTIAL");
    expect(flat).not.toContain("Zeta");
    expect(flat).not.toContain("OUTPUT");
  });

  it("reports the SAME task counts as computeReputation (no drift)", () => {
    const from = makeAgent("R");
    const to = makeAgent("W");
    completed(from.agentId, to.agentId, "job a", "0.10 USDC");
    completed(from.agentId, to.agentId, "job b", null);

    const tr = getAgentTrackRecord(to.agentId)!;
    const rep = computeReputation(to.agentId);
    expect(tr.tasksCompleted).toBe(rep.totalTasksCompleted);
    expect(tr.tasksFailed).toBe(rep.totalTasksFailed);
    expect(tr.successRate).toBe(rep.successRate);
  });

  it("caps recent jobs and returns null for an unknown agent", () => {
    const from = makeAgent("R");
    const to = makeAgent("W");
    for (let i = 0; i < 15; i++) completed(from.agentId, to.agentId, `job ${i}`, "0.10 USDC");
    expect(getAgentTrackRecord(to.agentId)!.recentJobs.length).toBeLessThanOrEqual(12);
    expect(getAgentTrackRecord("no-such-agent")).toBeNull();
  });

  it("shows the SETTLED amount for jobs whose task.payment is null (seed/demo)", () => {
    const from = makeAgent("Client");
    const to = makeAgent("Paid Worker");
    // A seed-style job: no task.payment, but it actually settled 0.15 USDC.
    const t = createTask({ fromAgent: from.agentId, toAgent: to.agentId, task: "job" });
    startTask(t.taskId);
    completeTask(t.taskId, "out");
    getDb()
      .prepare(
        `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, fee_amount, currency, created_at, settled_at)
         VALUES (?, ?, ?, ?, 0.15, 'completed', 0, 'USDC', ?, ?)`,
      )
      .run(randomUUID(), t.taskId, from.agentId, to.agentId, new Date().toISOString(), new Date().toISOString());

    const job = getAgentTrackRecord(to.agentId)!.recentJobs.find((j) => j.taskId === t.taskId)!;
    expect(job.payment).toBe("0.15 USDC"); // never "free" when it actually settled
  });

  it("hides contract-test jobs and labels system requesters", () => {
    const to = makeAgent("W");
    // A contract-test requester (id matching the network's hide pattern).
    const testId = "split-a-123456789012";
    createAgent({
      agentId: testId, name: "Contract Test", capabilities: ["x"], publicKey: "pk-ct",
      provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(),
    });
    completed(testId, to.agentId, "automated check", "0.10 USDC");
    // A real job from the world pipeline's system requester.
    completed("axon-world-visitor", to.agentId, "pipeline step", null);

    const jobs = getAgentTrackRecord(to.agentId)!.recentJobs;
    expect(jobs.some((j) => j.counterparty.includes("Contract Test"))).toBe(false);
    expect(jobs.some((j) => j.counterparty === "a World visitor")).toBe(true);
  });
});
