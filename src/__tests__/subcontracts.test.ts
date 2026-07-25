import { describe, it, expect } from "vitest";
import { createAgent } from "@/lib/agents";
import { createTask, getTaskById } from "@/lib/tasks";
import { createHiredTask } from "@/lib/planner";
import { recordSubcontract, getSubcontractsForParent, getSubcontractParent } from "@/lib/subcontracts";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";
let n = 0;
function mk(cap: string, reputation: number, price?: string): Agent {
  n++;
  const a: Agent = {
    agentId: `sc-${n}`,
    name: `Sc ${n}`,
    capabilities: [cap],
    publicKey: `pk-${n}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation,
    price,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

describe("subcontracting — Phase 11", () => {
  it("createHiredTask creates a free-lane hire", () => {
    const w = mk(`scw-${n}`, 7);
    const hirer = mk(`sch-${n}`, 0);
    const hire = createHiredTask(hirer.agentId, w.agentId, "do part");
    const t = getTaskById(hire.taskId);
    expect(t?.toAgent).toBe(w.agentId);
    expect(t?.fromAgent).toBe(hirer.agentId);
    expect(t?.status).toBe("queued");
    expect(hire.costUsdc).toBe(0);
  });

  it("links a subcontract to its parent, both directions", () => {
    const worker = mk(`scwk-${n}`, 8);
    const sub = mk(`scsb-${n}`, 7);
    const parent = createTask({ fromAgent: "buyer", toAgent: worker.agentId, task: "big job", initialStatus: "queued", queueQueuedWebhook: true });
    const hire = createHiredTask(worker.agentId, sub.agentId, "sub part");
    recordSubcontract({ parentTaskId: parent.taskId, childTaskId: hire.taskId, fromAgent: worker.agentId, toAgent: sub.agentId });

    const subs = getSubcontractsForParent(parent.taskId);
    expect(subs.length).toBe(1);
    expect(subs[0].toAgent).toBe(sub.agentId);
    expect(subs[0].fromAgent).toBe(worker.agentId);
    expect(getSubcontractParent(hire.taskId)?.parentTaskId).toBe(parent.taskId);
  });
});
