// The grow-yourself engine, driven with fake deps — proves the full orchestration
// (plan → hire each step → pay → synthesize) records a correct public timeline and
// respects the budget, all without spending anything or touching the network.
import { describe, it, expect } from "vitest";
import { runGrowMission, type GrowDeps } from "@/lib/growRunner";
import { getGrowEvents, getGrowRun, getGrowSpent } from "@/lib/grow";

function fakeThink(): GrowDeps["think"] {
  return async (prompt: string) => {
    if (prompt.includes("Return ONLY a JSON array")) {
      return '[{"capability":"research","task":"Gather sources"},{"capability":"writing","task":"Write it up"}]';
    }
    return "FINAL DELIVERABLE: the assembled report.";
  };
}

const candidates = (cap: string) => [
  { agentId: `${cap}-pro`, name: `${cap} pro`, priceUsdc: 2, proofScore: 900, capabilities: [cap] },
  { agentId: `${cap}-cheap`, name: `${cap} cheap`, priceUsdc: 1, proofScore: 400, capabilities: [cap] },
];

describe("grow-yourself engine", () => {
  it("plans, hires a proven specialist per step, pays, and synthesizes — with a full timeline", async () => {
    const hired: string[] = [];
    const deps: GrowDeps = {
      self: "entrepreneur",
      think: fakeThink(),
      search: async ({ capability }) => candidates(capability ?? "x"),
      hire: async ({ to, task }) => {
        hired.push(to);
        return { taskId: `task-${to}`, status: "completed", output: `did: ${task}`, costUsdc: 2, receiptUrl: `/r/task-${to}` };
      },
    };

    const res = await runGrowMission(deps, { mission: "Write a brief", budgetUsdc: 20, perHireCapUsdc: 4, maxHires: 3 });

    expect(res.run.status).toBe("completed");
    expect(res.deliverable).toContain("assembled report");
    expect(res.hires).toBe(2);
    // it picked the higher Proof Score within the cap, not the cheap one
    expect(hired).toEqual(["research-pro", "writing-pro"]);

    const events = getGrowEvents(res.run.runId).map((e) => e.kind);
    expect(events).toContain("plan");
    expect(events.filter((k) => k === "hire")).toHaveLength(2);
    expect(events.filter((k) => k === "payment")).toHaveLength(2);
    expect(events).toContain("synthesis");
    expect(getGrowSpent(res.run.runId)).toBeCloseTo(4); // 2 hires × 2 USDC
    expect(getGrowRun(res.run.runId)?.deliverable).toBeTruthy();
  });

  it("stops hiring when the budget can't cover another hire", async () => {
    const deps: GrowDeps = {
      self: "entrepreneur",
      think: fakeThink(),
      search: async ({ capability }) => candidates(capability ?? "x"),
      hire: async ({ to }) => ({ taskId: `t-${to}`, status: "completed", output: "ok", costUsdc: 2, receiptUrl: `/r/t-${to}` }),
    };
    // budget only covers one 2-USDC hire
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 2, perHireCapUsdc: 4, maxHires: 3 });
    expect(res.hires).toBe(1);
    expect(res.spentUsdc).toBeCloseTo(2);
  });

  it("records the payment even when a PAID hire completes but returns nothing", async () => {
    // money moved on-chain before the specialist ran; an empty result must not hide it
    const deps: GrowDeps = {
      self: "entrepreneur",
      think: fakeThink(),
      search: async ({ capability }) => candidates(capability ?? "x"),
      hire: async ({ to }) => ({ taskId: `t-${to}`, status: "completed", output: "", costUsdc: 2, receiptUrl: `/r/t-${to}` }),
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 20, perHireCapUsdc: 4, maxHires: 3 });
    expect(res.hires).toBe(0);                       // nothing usable delivered
    expect(getGrowSpent(res.run.runId)).toBeCloseTo(4); // but both payments are logged
    const kinds = getGrowEvents(res.run.runId).map((e) => e.kind);
    expect(kinds.filter((k) => k === "payment")).toHaveLength(2);
    expect(res.run.status).toBe("failed");           // no deliverable without content
  });

  it("counts committed money when a paid hire times out (escrow may still settle)", async () => {
    const deps: GrowDeps = {
      self: "entrepreneur",
      think: fakeThink(),
      search: async ({ capability }) => candidates(capability ?? "x"),
      hire: async ({ to }) => ({ taskId: `t-${to}`, status: "timeout", costUsdc: 2 }),
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 20, perHireCapUsdc: 4, maxHires: 3 });
    expect(res.hires).toBe(0);
    expect(getGrowSpent(res.run.runId)).toBeCloseTo(4); // both timed-out hires' committed funds counted
    expect(getGrowEvents(res.run.runId).filter((e) => e.kind === "payment")).toHaveLength(2);
  });

  it("records a hire failure and keeps going instead of throwing", async () => {
    let n = 0;
    const deps: GrowDeps = {
      self: "entrepreneur",
      think: fakeThink(),
      search: async ({ capability }) => candidates(capability ?? "x"),
      hire: async ({ to }) => {
        n++;
        if (n === 1) return { taskId: `t-${to}`, status: "failed", error: "specialist error", costUsdc: 0 };
        return { taskId: `t-${to}`, status: "completed", output: "ok", costUsdc: 2, receiptUrl: `/r/t-${to}` };
      },
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 20, perHireCapUsdc: 4, maxHires: 3 });
    expect(res.hires).toBe(1); // second succeeded
    const kinds = getGrowEvents(res.run.runId).map((e) => e.kind);
    expect(kinds).toContain("error");
    expect(res.run.status).toBe("completed");
  });
});
