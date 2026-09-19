import { describe, it, expect } from "vitest";
import { createAgent } from "@/lib/agents";
import { assignTeam, planTeam, executePlan, createHiredTask, parsePlan, type ThinkFn } from "@/lib/planner";
import { getTaskById, getTasksByAgent } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

const WALLET = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
let n = 0;
function mk(cap: string, reputation: number, price?: string): Agent {
  n++;
  const a: Agent = {
    agentId: `plan-${n}`,
    name: `Plan ${n}`,
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

describe("planner — Phase 11 self-assembling", () => {
  it("parsePlan extracts steps from a fenced JSON response", () => {
    const steps = parsePlan('```json\n[{"capability":"Research","task":"find sources"},{"capability":"writing","task":"draft"}]\n```');
    expect(steps).toEqual([
      { capability: "research", task: "find sources" },
      { capability: "writing", task: "draft" },
    ]);
  });

  it("assembles a team by routing each step and projecting cost", () => {
    const rcap = `pl-research-${n}`, wcap = `pl-writing-${n}`;
    const researcher = mk(rcap, 9, "0.00015 ETH");
    const writer = mk(wcap, 8, "0.0002 ETH");
    const plan = assignTeam("someone", "goal", [
      { capability: rcap, task: "research it" },
      { capability: wcap, task: "write it" },
    ], { budgetEth: 1 });
    expect(plan.routedCount).toBe(2);
    expect(plan.steps[0].agentId).toBe(researcher.agentId);
    expect(plan.steps[1].agentId).toBe(writer.agentId);
    expect(plan.estCostEth).toBeCloseTo(0.00035, 6);
    expect(plan.withinBudget).toBe(true);
  });

  it("flags a plan that exceeds the budget", () => {
    const cap = `pl-exp-${n}`;
    mk(cap, 9, "0.005 ETH");
    const plan = assignTeam("x", "g", [{ capability: cap, task: "t" }], { budgetEth: 0.001 });
    expect(plan.withinBudget).toBe(false);
  });

  it("planTeam decomposes with the injected model then routes", async () => {
    const cap = `pl-pt-${n}`;
    const a = mk(cap, 9, "0.0001 ETH");
    const think: ThinkFn = async () => `[{"capability":"${cap}","task":"do the thing"}]`;
    const plan = await planTeam({ from: "x", goal: "achieve", budgetEth: 1 }, think);
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].agentId).toBe(a.agentId);
  });

  it("createHiredTask rolls the task back when the balance payment fails (no orphan)", () => {
    const worker = mk(`pl-priced-${n}`, 8, "0.0001 ETH"); // priced
    const brokeHirer = mk(`pl-broke-${n}`, 0);           // registered, zero balance
    expect(() => createHiredTask(brokeHirer.agentId, worker.agentId, "do it")).toThrow();
    // The failed hire must leave NO payment_pending task lingering on the worker.
    const orphans = getTasksByAgent({ agentId: worker.agentId, role: "recipient" })
      .filter((t) => t.status === "payment_pending");
    expect(orphans.length).toBe(0);
  });

  it("executePlan creates the routed tasks (free lane)", () => {
    const cap = `pl-exec-${n}`;
    const worker = mk(cap, 7); // free-lane
    const hirer = mk(`pl-hirer-${n}`, 0);
    const plan = assignTeam(hirer.agentId, "g", [{ capability: cap, task: "go" }], { budgetEth: 1 });
    const { created, skipped } = executePlan(hirer.agentId, plan);
    expect(created.length).toBe(1);
    expect(skipped).toBe(0);
    const t = getTaskById(created[0].taskId);
    expect(t?.toAgent).toBe(worker.agentId);
    expect(t?.status).toBe("queued");
  });
});
