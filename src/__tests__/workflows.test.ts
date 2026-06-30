// Tests for src/lib/workflows.ts
// Uses real agents and real DB — no external calls needed

import { vi, describe, it, expect, afterEach } from "vitest";
import {
  createWorkflow,
  advanceWorkflow,
  failWorkflow,
  getWorkflow,
  getWorkflowsByAgent,
} from "@/lib/workflows";
import { createAgent } from "@/lib/agents";
import { createChannel, recordDeposit } from "@/lib/mpp";
import * as tasksModule from "@/lib/tasks";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

afterEach(() => { vi.restoreAllMocks(); });

const WALLET = "11111111111111111111111111111111";
let seq = 0;
function uid() { return `wfl-${++seq}`; }

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const id = uid();
  return {
    agentId: id,
    name: `WFL Agent ${id}`,
    capabilities: ["research"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── createWorkflow: free agents ───────────────────────────────────────────────

describe("createWorkflow: free agents", () => {
  it("creates a running workflow with step 0 in queued state", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const wf = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId],
      task: "do work",
    });

    expect(wf.workflowId).toBeTruthy();
    expect(wf.status).toBe("running");
    expect(wf.currentStep).toBe(0);
    expect(wf.agents).toEqual([a.agentId, b.agentId]);
    expect(wf.initialTask).toBe("do work");
    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0].agentId).toBe(a.agentId);
    expect(wf.steps[0].stepIndex).toBe(0);
    expect(wf.steps[0].status).toBe("queued");
  });

  it("sets the task input to the workflow initial task", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const wf = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId],
      task: "analyze this document",
    });

    expect(wf.steps[0].input).toBe("analyze this document");
  });
});

// ── createWorkflow: missing agent rolls back ──────────────────────────────────

describe("createWorkflow: missing agent", () => {
  it("throws and rolls back the workflow row when an agent does not exist", () => {
    const a = makeAgent();
    createAgent(a);

    expect(() =>
      createWorkflow({
        fromAgent: a.agentId,
        agents: ["ghost-agent", a.agentId],
        task: "fail",
      })
    ).toThrow(/Agent.*not found/);

    // The workflow INSERT must have been rolled back
    const rows = getDb()
      .prepare("SELECT * FROM workflows WHERE agents LIKE ?")
      .all("%ghost-agent%");
    expect(rows).toHaveLength(0);
  });
});

// ── createWorkflow: paid MPP agent as step 0 ─────────────────────────────────

describe("createWorkflow: paid MPP agents", () => {
  it("creates step 0 in payment_pending state and debits the MPP channel", () => {
    const sender = makeAgent();
    const paid = makeAgent({ price: "0.001 USDC" });
    const free = makeAgent();
    createAgent(sender);
    createAgent(paid);
    createAgent(free);

    const { channel } = createChannel(WALLET);
    // Fund the channel with 1 USDC (1_000_000 micro-USDC)
    getDb()
      .prepare("UPDATE mpp_channels SET balance_usdc = 1, balance_micro_usdc = 1000000 WHERE channel_id = ?")
      .run(channel.channelId);

    const wf = createWorkflow({
      fromAgent: sender.agentId,
      agents: [paid.agentId, free.agentId],
      task: "paid step 0",
      mppChannelId: channel.channelId,
    });

    expect(wf.status).toBe("running");
    expect(wf.steps).toHaveLength(1);
    // Step 0 goes to the paid agent — markTaskPaymentConfirmed runs synchronously,
    // so by the time createWorkflow returns the step is already 'queued'
    expect(wf.steps[0].agentId).toBe(paid.agentId);
    expect(wf.steps[0].status).toBe("queued");

    // Channel balance should have been debited by 0.001 USDC = 1000 micro-USDC
    const updatedChannel = getDb()
      .prepare("SELECT balance_micro_usdc FROM mpp_channels WHERE channel_id = ?")
      .get(channel.channelId) as { balance_micro_usdc: number };
    expect(updatedChannel.balance_micro_usdc).toBe(1000000 - 1000);
  });

  it("throws when an MPP channel is required but not provided", () => {
    const sender = makeAgent();
    const paid = makeAgent({ price: "0.001 USDC" });
    const free = makeAgent();
    createAgent(sender);
    createAgent(paid);
    createAgent(free);

    expect(() =>
      createWorkflow({
        fromAgent: sender.agentId,
        agents: [paid.agentId, free.agentId],
        task: "no channel provided",
        // mppChannelId intentionally omitted
      })
    ).toThrow(/MPP channel/);
  });
});

// ── advanceWorkflow ───────────────────────────────────────────────────────────

describe("advanceWorkflow: creates the next step", () => {
  it("creates step N+1 task and advances currentStep when not the last step", () => {
    const a = makeAgent();
    const b = makeAgent();
    const c = makeAgent();
    createAgent(a);
    createAgent(b);
    createAgent(c);

    const wf = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId, c.agentId],
      task: "step 0 input",
    });

    advanceWorkflow(wf.workflowId, 0, "step 0 output");

    const updated = getWorkflow(wf.workflowId)!;
    expect(updated.currentStep).toBe(1);
    expect(updated.status).toBe("running");
    expect(updated.steps).toHaveLength(2);
    expect(updated.steps[1].agentId).toBe(b.agentId);
    // The next step gets a FRAMED task: the original job + the previous
    // output as working material + a clear continue instruction — a bare
    // output alone confuses the receiving agent into meta-questions.
    expect(updated.steps[1].input).toContain("step 0 output");
    expect(updated.steps[1].input).toContain("The original job: step 0 input");
    expect(updated.steps[1].input).toContain("step 2 of 3");
    expect(updated.steps[1].status).toBe("queued");
  });
});

describe("advanceWorkflow: completes on the last step", () => {
  it("marks workflow completed with the final output when the last agent finishes", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const wf = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId],
      task: "two-step task",
    });

    // Advance step 0 → creates step 1 for b
    advanceWorkflow(wf.workflowId, 0, "step0_output");
    // Advance step 1 → last step, workflow completes
    advanceWorkflow(wf.workflowId, 1, "final_output");

    const done = getWorkflow(wf.workflowId)!;
    expect(done.status).toBe("completed");
    expect(done.finalOutput).toBe("final_output");
    expect(done.completedAt).toBeTruthy();
  });
});

describe("advanceWorkflow: fails workflow when next step cannot be created", () => {
  it("marks workflow failed when the next step agent is deleted before advancing", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const wf = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId],
      task: "advance will fail",
    });

    // Remove agent b from the DB so the step-1 task creation fails
    getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run(b.agentId);

    advanceWorkflow(wf.workflowId, 0, "step0_out");

    const failed = getWorkflow(wf.workflowId)!;
    expect(failed.status).toBe("failed");
  });

  it("is a no-op (does not throw) for an unknown workflow ID", () => {
    expect(() => advanceWorkflow("ghost-workflow", 0, "output")).not.toThrow();
  });
});

// ── failWorkflow ─────────────────────────────────────────────────────────────

describe("failWorkflow", () => {
  it("sets the workflow status to failed and records a completedAt timestamp", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const wf = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId],
      task: "fail me",
    });

    failWorkflow(wf.workflowId);

    const updated = getWorkflow(wf.workflowId)!;
    expect(updated.status).toBe("failed");
    expect(updated.completedAt).toBeTruthy();
  });
});

// ── getWorkflow ───────────────────────────────────────────────────────────────

describe("getWorkflow", () => {
  it("returns null for an unknown workflow ID", () => {
    expect(getWorkflow("no-such-wf")).toBeNull();
  });

  it("returns the workflow with its steps hydrated", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const created = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId],
      task: "retrieve-me",
    });

    const retrieved = getWorkflow(created.workflowId)!;
    expect(retrieved.workflowId).toBe(created.workflowId);
    expect(retrieved.initialTask).toBe("retrieve-me");
    expect(retrieved.steps.length).toBe(1);
    expect(retrieved.createdAt).toBeTruthy();
  });
});

// ── getWorkflowsByAgent ───────────────────────────────────────────────────────

describe("getWorkflowsByAgent", () => {
  it("returns workflows where the agent is the fromAgent (sender)", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const wf = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId],
      task: "sender lookup",
    });

    const list = getWorkflowsByAgent(a.agentId);
    expect(list.some((w) => w.workflowId === wf.workflowId)).toBe(true);
  });

  it("returns workflows where the agent appears in the agents chain", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const wf = createWorkflow({
      fromAgent: a.agentId,
      agents: [a.agentId, b.agentId],
      task: "participant lookup",
    });

    const list = getWorkflowsByAgent(b.agentId);
    expect(list.some((w) => w.workflowId === wf.workflowId)).toBe(true);
  });

  it("returns empty array for an agent with no workflows", () => {
    const a = makeAgent();
    createAgent(a);
    expect(getWorkflowsByAgent(a.agentId)).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    for (let i = 0; i < 5; i++) {
      createWorkflow({ fromAgent: a.agentId, agents: [a.agentId, b.agentId], task: `task-${i}` });
    }

    expect(getWorkflowsByAgent(a.agentId, 3)).toHaveLength(3);
  });
});

// ── getWorkflow: bad agents JSON is handled gracefully ────────────────────────

describe("getWorkflow: malformed agents JSON falls back to empty array", () => {
  it("returns agents: [] when the DB row has unparseable agents JSON", () => {
    const a = makeAgent();
    const b = makeAgent();
    createAgent(a);
    createAgent(b);

    const wf = createWorkflow({ fromAgent: a.agentId, agents: [a.agentId, b.agentId], task: "bad-json test" });

    // Corrupt the agents column directly
    getDb()
      .prepare("UPDATE workflows SET agents = 'bad-json' WHERE workflow_id = ?")
      .run(wf.workflowId);

    const retrieved = getWorkflow(wf.workflowId)!;
    expect(retrieved).not.toBeNull();
    expect(retrieved.agents).toEqual([]);
  });
});

// ── createWorkflow: MPP debit failure throws and cleans up ────────────────────

describe("createWorkflow: MPP debit failure", () => {
  it("throws when the channel has insufficient balance for a paid step", () => {
    const sender = makeAgent();
    const paid = makeAgent({ price: "1 USDC" });
    createAgent(sender);
    createAgent(paid);

    // Channel with 0 balance — debit will fail
    const { channel } = createChannel(WALLET);

    expect(() =>
      createWorkflow({
        fromAgent: sender.agentId,
        agents: [paid.agentId],
        task: "paid step",
        mppChannelId: channel.channelId,
      })
    ).toThrow(/Insufficient balance|MPP debit failed/);
  });
});

// ── createWorkflow: payment confirmation failure throws and refunds ────────────

describe("createWorkflow: payment confirmation failure", () => {
  it("throws when markTaskPaymentConfirmed returns null after a successful debit", () => {
    const sender = makeAgent();
    const paid = makeAgent({ price: "1 USDC" });
    createAgent(sender);
    createAgent(paid);

    // Fund the channel so the debit succeeds
    const { channel } = createChannel(WALLET);
    recordDeposit(channel.channelId, { amountUsdc: 5, microUsdc: 5_000_000 }, `sig-confirm-${uid()}`);

    vi.spyOn(tasksModule, "markTaskPaymentConfirmed").mockImplementationOnce(() => null);

    expect(() =>
      createWorkflow({
        fromAgent: sender.agentId,
        agents: [paid.agentId],
        task: "confirmation fail",
        mppChannelId: channel.channelId,
      })
    ).toThrow(/payment could not be confirmed/);
  });
});
