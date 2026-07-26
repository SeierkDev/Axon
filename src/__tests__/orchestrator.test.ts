import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { createAgent } from "@/lib/agents";
import { createTask, getTaskById, getTasksByAgent, startTask, completeTask, failTask, type Task } from "@/lib/tasks";
import { runWithTraceId } from "@/lib/tracing";
import { runOrchestration } from "@/lib/orchestrator";
import { getSubcontractsForParent } from "@/lib/subcontracts";
import { getAvailableBalance } from "@/lib/payments";
import { getDb } from "@/lib/db";
import type { ThinkFn } from "@/lib/planner";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let n = 0;

/** Seed earned USDC balance, the shape releasePayment produces on a hire payout. */
function credit(agentId: string, amount: number): void {
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at)
       VALUES (?, NULL, ?, ?, ?, 'completed', NULL, 0, 'USDC', ?, ?)`,
    )
    .run(randomUUID(), "external-seed", agentId, amount, new Date().toISOString(), new Date().toISOString());
}

function mk(cap: string, reputation: number, price?: string, orchestrator = false): Agent {
  n++;
  const a: Agent = {
    agentId: `orc-${n}`,
    name: `Orc ${n}`,
    capabilities: [cap],
    publicKey: `pk-${n}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation,
    price,
    orchestrator,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

/** A hired orchestrator task, in the running state the worker would have started it in. */
function orchestratorJob(orch: Agent, buyer: Agent, job: string): Task {
  return createTask({
    fromAgent: buyer.agentId,
    toAgent: orch.agentId,
    task: job,
    initialStatus: "running",
    startedBy: "orchestrator",
  });
}

/** Stand-in for the specialists' own workers: complete their queued hires as they land. */
function fakeSpecialistWorker(agentIds: string[]) {
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const id of agentIds) {
        for (const j of getTasksByAgent({ agentId: id, role: "recipient" })) {
          if (j.status === "queued") {
            startTask(j.taskId, "worker");
            completeTask(j.taskId, `specialist output for: ${j.task}`);
          }
        }
      }
      await new Promise((r) => setTimeout(r, 8));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}

const isPlan = (prompt: string) => prompt.includes("Return ONLY a JSON array");

describe("orchestrator — hosted agents that hire", () => {
  it("decomposes a job, hires a specialist, and synthesizes the deliverable", async () => {
    const cap = `orc-research-${n}`;
    const specialist = mk(cap, 9); // free lane
    const orch = mk(`orc-lead-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyer-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "Write a brief on the topic");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt) ? JSON.stringify([{ capability: cap, task: "research the topic" }]) : "FINAL DELIVERABLE";

    const worker = fakeSpecialistWorker([specialist.agentId]);
    // Mirror the worker: run under the parent's traceId so sub-hires inherit it.
    const trace = task.traceId ?? task.taskId;
    await runWithTraceId(trace, () =>
      runOrchestration(orch, task, { think, pollMs: 8, perHireTimeoutMs: 3000 }),
    );
    await worker.stop();

    const done = getTaskById(task.taskId);
    expect(done?.status).toBe("completed");
    expect(done?.output).toBe("FINAL DELIVERABLE");

    const subs = getSubcontractsForParent(task.taskId);
    expect(subs).toHaveLength(1);
    expect(subs[0].toAgent).toBe(specialist.agentId);
    expect(subs[0].fromAgent).toBe(orch.agentId);

    // The specialist's hire must share the orchestrator job's trace, so the flight
    // recorder can render the whole team under one pipeline.
    expect(getTaskById(subs[0].childTaskId)?.traceId).toBe(trace);
  });

  it("assembles a partial team — an unroutable step is skipped, the routable one still lands", async () => {
    const cap = `orc-writing-${n}`;
    const specialist = mk(cap, 8);
    const orch = mk(`orc-lead2-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyer2-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "Research then write");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt)
        ? JSON.stringify([
            { capability: `no-such-cap-${n}`, task: "unroutable part" },
            { capability: cap, task: "write it up" },
          ])
        : "SYNTHESIZED";

    const worker = fakeSpecialistWorker([specialist.agentId]);
    await runOrchestration(orch, task, { think, pollMs: 8, perHireTimeoutMs: 3000 });
    await worker.stop();

    expect(getTaskById(task.taskId)?.status).toBe("completed");
    const subs = getSubcontractsForParent(task.taskId);
    expect(subs).toHaveLength(1);
    expect(subs[0].toAgent).toBe(specialist.agentId);
  });

  it("answers directly when the plan needs no specialists", async () => {
    const orch = mk(`orc-solo-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyer3-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "a job it can do alone");

    const think: ThinkFn = async (prompt) => (isPlan(prompt) ? "[]" : "DIRECT ANSWER");

    await runOrchestration(orch, task, { think, pollMs: 5, perHireTimeoutMs: 500 });

    const done = getTaskById(task.taskId);
    expect(done?.status).toBe("completed");
    expect(done?.output).toBe("DIRECT ANSWER");
    expect(getSubcontractsForParent(task.taskId)).toHaveLength(0);
  });

  it("falls back to a direct answer when no worker matches any step", async () => {
    const orch = mk(`orc-nomatch-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyer4-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "needs skills nobody has");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt) ? JSON.stringify([{ capability: `ghost-cap-${n}`, task: "impossible" }]) : "FELL BACK";

    await runOrchestration(orch, task, { think, pollMs: 5, perHireTimeoutMs: 500 });

    const done = getTaskById(task.taskId);
    expect(done?.status).toBe("completed");
    expect(done?.output).toBe("FELL BACK");
    expect(getSubcontractsForParent(task.taskId)).toHaveLength(0);
  });

  it("feeds each specialist's output forward to the next step", async () => {
    const cap1 = `orc-a-${n}`;
    const cap2 = `orc-b-${n}`;
    const first = mk(cap1, 9);
    const second = mk(cap2, 9);
    const orch = mk(`orc-pipe-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyerP-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "research then write from it");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt)
        ? JSON.stringify([
            { capability: cap1, task: "research the topic" },
            { capability: cap2, task: "write from the research" },
          ])
        : "FINAL";

    const worker = fakeSpecialistWorker([first.agentId, second.agentId]);
    await runOrchestration(orch, task, { think, pollMs: 8, perHireTimeoutMs: 3000 });
    await worker.stop();

    const subs = getSubcontractsForParent(task.taskId);
    expect(subs).toHaveLength(2);
    // The second hire (to `second`) must carry the first specialist's output as context.
    const secondHire = subs.find((s) => s.toAgent === second.agentId);
    const priorResults = getTaskById(secondHire!.childTaskId)?.context?.priorResults as
      | { task: string; output: string }[]
      | undefined;
    expect(priorResults).toBeDefined();
    expect(priorResults).toHaveLength(1);
    expect(priorResults![0].output).toContain("specialist output for: research the topic");
  });

  it("passes the buyer's context through to the specialists", async () => {
    const cap = `orc-ctx-${n}`;
    const specialist = mk(cap, 9);
    const orch = mk(`orc-leadC-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyerC-${n}`, 0);
    const task = createTask({
      fromAgent: buyer.agentId,
      toAgent: orch.agentId,
      task: "summarize the document",
      context: { document: "the quarterly report text" },
      initialStatus: "running",
      startedBy: "orchestrator",
    });

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt) ? JSON.stringify([{ capability: cap, task: "summarize it" }]) : "SUMMARY";

    const worker = fakeSpecialistWorker([specialist.agentId]);
    await runOrchestration(orch, task, { think, pollMs: 8, perHireTimeoutMs: 3000 });
    await worker.stop();

    const subs = getSubcontractsForParent(task.taskId);
    expect(subs).toHaveLength(1);
    // The specialist must receive the reference material the buyer attached.
    expect(getTaskById(subs[0].childTaskId)?.context?.document).toBe("the quarterly report text");
  });

  it("cancels and refunds a sub-hire that never delivers", async () => {
    const cap = `orc-slow-${n}`;
    const specialist = mk(cap, 9, "0.20 USDC"); // priced, but no worker will run it
    const orch = mk(`orc-lead6-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyer6-${n}`, 0);
    credit(orch.agentId, 5);
    const before = getAvailableBalance(orch.agentId);
    const task = orchestratorJob(orch, buyer, "needs a slow specialist");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt) ? JSON.stringify([{ capability: cap, task: "do slow work" }]) : "FALLBACK";

    // No fake worker — the hire stays queued and must time out.
    await runOrchestration(orch, task, { think, pollMs: 15, perHireTimeoutMs: 80 });

    const subs = getSubcontractsForParent(task.taskId);
    expect(subs).toHaveLength(1);
    expect(subs[0].toAgent).toBe(specialist.agentId);
    expect(getTaskById(subs[0].childTaskId)?.status).toBe("failed"); // cancelled on timeout
    expect(getAvailableBalance(orch.agentId)).toBeCloseTo(before, 6); // escrow refunded in full

    const done = getTaskById(task.taskId);
    expect(done?.status).toBe("completed");
    expect(done?.output).toBe("FALLBACK"); // no parts survived → answered solo
  });

  it("will not hire another orchestrator — no cycles or nested fan-out", async () => {
    const cap = `orc-nested-${n}`;
    const otherOrch = mk(cap, 9, undefined, true); // the only match for `cap` is itself an orchestrator
    const orch = mk(`orc-lead7-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyer7-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "should not nest");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt) ? JSON.stringify([{ capability: cap, task: "part" }]) : "SOLO";

    await runOrchestration(orch, task, { think, pollMs: 10, perHireTimeoutMs: 300 });

    expect(getSubcontractsForParent(task.taskId)).toHaveLength(0);
    expect(getTaskById(task.taskId)?.output).toBe("SOLO");
    // sanity: otherOrch was never hired
    expect(getTasksByAgent({ agentId: otherOrch.agentId, role: "recipient" })).toHaveLength(0);
  });

  it("skips a plan step whose capability is blank", async () => {
    const orch = mk(`orc-lead8-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyer8-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "blank capability step");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt) ? JSON.stringify([{ capability: "  ", task: "nothing routable" }]) : "SOLO";

    await runOrchestration(orch, task, { think, pollMs: 10, perHireTimeoutMs: 300 });

    expect(getSubcontractsForParent(task.taskId)).toHaveLength(0);
    expect(getTaskById(task.taskId)?.output).toBe("SOLO");
  });

  it("stops hiring and does not complete once the parent job is externally failed", async () => {
    // Simulates an SLA sweep failing + refunding the parent mid-orchestration: the
    // background loop must notice and stop spending, not keep hiring for a dead job.
    const cap = `orc-killed-${n}`;
    const specialist = mk(cap, 9);
    const orch = mk(`orc-leadK-${n}`, 5, undefined, true);
    const buyer = mk(`orc-buyerK-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "job that gets cancelled");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt)
        ? JSON.stringify([
            { capability: cap, task: "step one" },
            { capability: cap, task: "step two" },
          ])
        : "SHOULD NOT SYNTHESIZE";

    // Kill the parent right after the first specialist finishes, before step two.
    let firstDone = false;
    const worker = (() => {
      let running = true;
      const loop = (async () => {
        while (running) {
          for (const j of getTasksByAgent({ agentId: specialist.agentId, role: "recipient" })) {
            if (j.status === "queued") {
              startTask(j.taskId, "worker");
              completeTask(j.taskId, "did the work");
              if (!firstDone) {
                firstDone = true;
                failTask(task.taskId, "SLA breach"); // external kill
              }
            }
          }
          await new Promise((r) => setTimeout(r, 8));
        }
      })();
      return { async stop() { running = false; await loop; } };
    })();

    await runOrchestration(orch, task, { think, pollMs: 8, perHireTimeoutMs: 3000 });
    await worker.stop();

    const done = getTaskById(task.taskId);
    expect(done?.status).toBe("failed"); // stayed failed — not resurrected by completeTask
    expect(done?.output).toBeFalsy(); // no deliverable written after the kill
    // It stopped early: at most the one sub-hire from before the kill, never a second.
    expect(getSubcontractsForParent(task.taskId).length).toBeLessThanOrEqual(1);
  });

  it("never routes the job back to the orchestrator itself", async () => {
    // Orchestrator shares the capability with a real specialist — it must pick the
    // specialist, never hire itself into a loop.
    const cap = `orc-shared-${n}`;
    const specialist = mk(cap, 9);
    const orch = mk(cap, 9, undefined, true); // same capability, same score
    const buyer = mk(`orc-buyer5-${n}`, 0);
    const task = orchestratorJob(orch, buyer, "self-routing guard");

    const think: ThinkFn = async (prompt) =>
      isPlan(prompt) ? JSON.stringify([{ capability: cap, task: "do the part" }]) : "OK";

    const worker = fakeSpecialistWorker([specialist.agentId]);
    await runOrchestration(orch, task, { think, pollMs: 8, perHireTimeoutMs: 3000 });
    await worker.stop();

    const subs = getSubcontractsForParent(task.taskId);
    expect(subs).toHaveLength(1);
    expect(subs[0].toAgent).toBe(specialist.agentId);
    expect(subs[0].toAgent).not.toBe(orch.agentId);
  });
});
