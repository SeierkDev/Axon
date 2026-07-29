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
    // A free failure costs the step nothing, so it falls to the next specialist
    // and still delivers — both planned steps end up done.
    expect(res.hires).toBe(2);
    const kinds = getGrowEvents(res.run.runId).map((e) => e.kind);
    expect(kinds).toContain("error");
    expect(res.run.status).toBe("completed");
  });
});

// ── Missions: the same engine, now owned by somebody ──────────────────────────

describe("a mission belongs to its owner", () => {
  it("keeps runs separate and hides another owner's mission", async () => {
    const { createGrowRun, listGrowRunsForOwner, cancelGrowRun } = await import("@/lib/grow");
    const mine = createGrowRun({ agentId: "a1", ownerWallet: "WALLET_A", mission: "mine", budgetUsdc: 5 });
    createGrowRun({ agentId: "a2", ownerWallet: "WALLET_B", mission: "theirs", budgetUsdc: 5 });

    expect(listGrowRunsForOwner("WALLET_A").map((r) => r.runId)).toContain(mine.runId);
    expect(listGrowRunsForOwner("WALLET_B").map((r) => r.runId)).not.toContain(mine.runId);
    // Someone else cannot stop it.
    expect(cancelGrowRun(mine.runId, "WALLET_B")).toBeNull();
    expect(cancelGrowRun(mine.runId, "WALLET_A")).not.toBeNull();
  });

  it("records the caps the run was started with", async () => {
    const { createGrowRun, getGrowRun } = await import("@/lib/grow");
    const r = createGrowRun({
      agentId: "a3", ownerWallet: "WALLET_C", mission: "capped", budgetUsdc: 9,
      perHireCapUsdc: 3, maxHires: 4,
    });
    const back = getGrowRun(r.runId)!;
    expect(back.perHireCapUsdc).toBe(3);
    expect(back.maxHires).toBe(4);
    expect(back.canceled).toBe(false);
  });
});

describe("stopping a mission", () => {
  it("stops between steps, never mid-hire, and keeps what was already paid for", async () => {
    const { createGrowRun, cancelGrowRun, getGrowEvents } = await import("@/lib/grow");
    const run = createGrowRun({ agentId: "stopper", ownerWallet: "W", mission: "three steps", budgetUsdc: 20 });

    const hired: string[] = [];
    const deps: GrowDeps = {
      self: "stopper",
      think: async (prompt: string) =>
        prompt.includes("Return ONLY a JSON array")
          ? '[{"capability":"a","task":"one"},{"capability":"b","task":"two"},{"capability":"c","task":"three"}]'
          : "ASSEMBLED FROM WHAT WAS BOUGHT",
      search: async ({ capability }) => [
        { agentId: `${capability}-pro`, name: `${capability} pro`, priceUsdc: 1, proofScore: 800, capabilities: [capability ?? ""] },
      ],
      hire: async ({ to }) => {
        hired.push(to);
        // The owner stops it while the FIRST hire is in flight.
        if (hired.length === 1) cancelGrowRun(run.runId, "W");
        return { taskId: `t-${hired.length}`, status: "completed" as const, output: "work", costUsdc: 1 };
      },
    };

    const res = await runGrowMission(
      deps, { mission: "three steps", budgetUsdc: 20, perHireCapUsdc: 5, maxHires: 3 }, run.runId,
    );

    // The in-flight hire finished and was paid — cancelling never abandons money
    // that already moved.
    expect(hired).toHaveLength(1);
    expect(res.spentUsdc).toBe(1);
    // …and the work bought is still assembled rather than thrown away.
    expect(res.deliverable).toBe("ASSEMBLED FROM WHAT WAS BOUGHT");
    const summaries = getGrowEvents(run.runId).map((e) => e.summary);
    expect(summaries.some((s) => s.includes("Stopped by the owner"))).toBe(true);
  });

  it("a stop before any hire ends the run without spending", async () => {
    const { createGrowRun, cancelGrowRun } = await import("@/lib/grow");
    const run = createGrowRun({ agentId: "early", ownerWallet: "W", mission: "m", budgetUsdc: 10 });
    cancelGrowRun(run.runId, "W");

    let hires = 0;
    const deps: GrowDeps = {
      self: "early",
      think: async (p: string) => (p.includes("Return ONLY a JSON array") ? '[{"capability":"a","task":"one"}]' : "x"),
      search: async () => [{ agentId: "a-pro", name: "a", priceUsdc: 1, proofScore: 1, capabilities: [] }],
      hire: async () => { hires++; return { taskId: "t", status: "completed" as const, output: "o", costUsdc: 1 }; },
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 10, perHireCapUsdc: 5, maxHires: 1 }, run.runId);
    expect(hires).toBe(0);
    expect(res.spentUsdc).toBe(0);
  });
});

describe("one mission at a time per agent", () => {
  it("reports a live run as active, so a second can be refused", async () => {
    const { createGrowRun, getActiveGrowRun, recordGrowEvent, updateGrowRun } = await import("@/lib/grow");
    const run = createGrowRun({ agentId: "solo", ownerWallet: "W", mission: "first", budgetUsdc: 5 });
    // Fresh activity — two runs would race the same budget and the same balance.
    recordGrowEvent(run.runId, { kind: "note", summary: "working" });
    expect(getActiveGrowRun("solo")?.runId).toBe(run.runId);

    // Once it reaches a terminal state the agent is free again.
    updateGrowRun(run.runId, { status: "failed" });
    expect(getActiveGrowRun("solo")).toBeNull();
  });

  it("does not let an abandoned run block the agent forever", async () => {
    const { createGrowRun, getActiveGrowRun, recordGrowEvent } = await import("@/lib/grow");
    const { getDb } = await import("@/lib/db");
    const run = createGrowRun({ agentId: "stale", ownerWallet: "W", mission: "orphan", budgetUsdc: 5 });
    const ev = recordGrowEvent(run.runId, { kind: "note", summary: "last thing it ever did" });

    // A process restart can strand a run non-terminal. Backdate its last activity
    // past the staleness window: without this the orphan would block every future
    // mission for that agent, forever.
    getDb().prepare("UPDATE grow_events SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), ev.id);

    expect(getActiveGrowRun("stale")).toBeNull();          // default 15-min window
    expect(getActiveGrowRun("stale", 2 * 60 * 60 * 1000)).not.toBeNull(); // wider window still sees it
  });
});

// ── What makes a multi-step mission actually multi-step ──────────────────────

describe("steps build on each other", () => {
  it("hands each specialist what the earlier ones produced", async () => {
    const seen: (string | undefined)[] = [];
    const deps: GrowDeps = {
      self: "e",
      think: async (p: string) =>
        p.includes("Return ONLY a JSON array")
          ? '[{"capability":"research","task":"find the facts"},{"capability":"writing","task":"write it up"}]'
          : "FINAL",
      search: async ({ capability }) => [
        { agentId: `${capability}-pro`, name: capability ?? "", priceUsdc: 0, proofScore: 900, capabilities: [] },
      ],
      hire: async ({ to, context }) => {
        seen.push(context);
        return { taskId: `t-${to}`, status: "completed" as const, output: `OUTPUT FROM ${to}`, costUsdc: 0 };
      },
    };
    await runGrowMission(deps, { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 2 });

    // The planner is told to order steps so earlier results feed later ones —
    // which only means anything if the later specialist can see them.
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toContain("OUTPUT FROM research-pro");
  });
});

describe("a step doesn't die with one specialist", () => {
  it("falls down the ranking when a hire costs nothing and fails", async () => {
    const tried: string[] = [];
    const deps: GrowDeps = {
      self: "e",
      think: async (p: string) =>
        p.includes("Return ONLY a JSON array") ? '[{"capability":"x","task":"do it"}]' : "FINAL",
      search: async () => [
        { agentId: "best", name: "best", priceUsdc: 0, proofScore: 900, capabilities: [] },
        { agentId: "second", name: "second", priceUsdc: 0, proofScore: 500, capabilities: [] },
      ],
      hire: async ({ to }) => {
        tried.push(to);
        return to === "best"
          ? { taskId: "t1", status: "failed" as const, error: "nope", costUsdc: 0 }
          : { taskId: "t2", status: "completed" as const, output: "done", costUsdc: 0 };
      },
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 1 });
    expect(tried).toEqual(["best", "second"]); // most proven first
    expect(res.hires).toBe(1);
  });

  it("never pays twice for one step", async () => {
    const tried: string[] = [];
    const deps: GrowDeps = {
      self: "e",
      think: async (p: string) =>
        p.includes("Return ONLY a JSON array") ? '[{"capability":"x","task":"do it"}]' : "FINAL",
      search: async () => [
        { agentId: "took-the-money", name: "a", priceUsdc: 2, proofScore: 900, capabilities: [] },
        { agentId: "would-be-next", name: "b", priceUsdc: 2, proofScore: 500, capabilities: [] },
      ],
      hire: async ({ to }) => {
        tried.push(to);
        // Paid, then delivered nothing. Hiring a replacement would spend twice
        // the per-hire cap on a single step.
        return { taskId: "t1", status: "completed" as const, output: "", costUsdc: 2 };
      },
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 20, perHireCapUsdc: 2, maxHires: 1 });
    expect(tried).toEqual(["took-the-money"]);
    expect(res.spentUsdc).toBe(2);
  });
});

describe("seeing the cost before committing to it", () => {
  it("plans and prices a mission without hiring anyone", async () => {
    const { previewGrowMission } = await import("@/lib/growRunner");
    let hires = 0;
    const deps: GrowDeps = {
      self: "e",
      think: async (p: string) =>
        p.includes("Return ONLY a JSON array")
          ? '[{"capability":"research","task":"find"},{"capability":"writing","task":"write"}]'
          : "FINAL",
      search: async ({ capability }) => [
        { agentId: `${capability}-pro`, name: `${capability} pro`, priceUsdc: 2, proofScore: 900, capabilities: [] },
        { agentId: `${capability}-alt`, name: `${capability} alt`, priceUsdc: 1, proofScore: 300, capabilities: [] },
      ],
      hire: async () => { hires++; throw new Error("a preview must never hire"); },
    };

    const p = await previewGrowMission(deps, { mission: "m", budgetUsdc: 10, perHireCapUsdc: 4, maxHires: 2 });
    expect(hires).toBe(0);
    expect(p.steps.map((s) => s.pick?.agentId)).toEqual(["research-pro", "writing-pro"]); // most proven
    expect(p.steps[0].alternatives).toBe(1);
    expect(p.estimatedUsdc).toBe(4);
    expect(p.withinBudget).toBe(true);
  });

  it("prices against what would actually be left, and flags an over-budget plan", async () => {
    const { previewGrowMission } = await import("@/lib/growRunner");
    const deps: GrowDeps = {
      self: "e",
      think: async (p: string) =>
        p.includes("Return ONLY a JSON array")
          ? '[{"capability":"a","task":"1"},{"capability":"b","task":"2"},{"capability":"c","task":"3"}]'
          : "FINAL",
      search: async ({ capability, maxPriceUsdc }) =>
        (maxPriceUsdc ?? 0) >= 2
          ? [{ agentId: `${capability}-pro`, name: "p", priceUsdc: 2, proofScore: 500, capabilities: [] }]
          : [],
      hire: async () => { throw new Error("a preview must never hire"); },
    };
    // Budget 5 covers two hires at 2; the third has 1 left and finds nothing.
    const p = await previewGrowMission(deps, { mission: "m", budgetUsdc: 5, perHireCapUsdc: 2, maxHires: 3 });
    expect(p.steps.map((s) => s.pick !== null)).toEqual([true, true, false]);
    expect(p.estimatedUsdc).toBe(4);
  });
});

// ── Judging the work, and changing the plan because of it ────────────────────

/** A think() that answers the planner, the reviewer and the re-planner distinctly. */
function brain(opts: { plan: string; review?: (out: string) => string; replan?: string; final?: string }): GrowDeps["think"] {
  return async (prompt: string) => {
    if (prompt.includes("Break the mission into")) return opts.plan;
    if (prompt.includes("Judge whether it actually does the job")) {
      const out = prompt.split("What came back:\n")[1] ?? "";
      return opts.review ? opts.review(out) : '{"ok":true,"reason":"fine"}';
    }
    if (prompt.includes("deciding what is still worth doing")) return opts.replan ?? "[]";
    return opts.final ?? "FINAL";
  };
}

describe("it judges the work it bought", () => {
  it("rejects unusable free work and moves to the next specialist", async () => {
    const tried: string[] = [];
    const deps: GrowDeps = {
      self: "e",
      think: brain({
        plan: '[{"capability":"x","task":"do it"}]',
        review: (out) => (out.includes("junk") ? '{"ok":false,"reason":"off topic"}' : '{"ok":true,"reason":"good"}'),
      }),
      search: async () => [
        { agentId: "sloppy", name: "sloppy", priceUsdc: 0, proofScore: 900, capabilities: [] },
        { agentId: "solid", name: "solid", priceUsdc: 0, proofScore: 500, capabilities: [] },
      ],
      hire: async ({ to }) => {
        tried.push(to);
        return { taskId: `t-${to}`, status: "completed" as const, output: to === "sloppy" ? "junk" : "real work", costUsdc: 0 };
      },
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 1 });
    expect(tried).toEqual(["sloppy", "solid"]);
    expect(res.hires).toBe(1);
    const evs = getGrowEvents(res.run.runId);
    expect(evs.some((e) => e.kind === "review" && e.summary.includes("Rejected"))).toBe(true);
  });

  it("keeps work it already paid for, flagged, rather than binning it on a hunch", async () => {
    const deps: GrowDeps = {
      self: "e",
      think: brain({ plan: '[{"capability":"x","task":"do it"}]', review: () => '{"ok":false,"reason":"a bit thin"}' }),
      search: async () => [
        { agentId: "paid", name: "paid", priceUsdc: 2, proofScore: 900, capabilities: [] },
        { agentId: "other", name: "other", priceUsdc: 2, proofScore: 100, capabilities: [] },
      ],
      hire: async ({ to }) => ({ taskId: `t-${to}`, status: "completed" as const, output: "something", costUsdc: 2 }),
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 20, perHireCapUsdc: 2, maxHires: 1 });
    // Paid for once, kept, and the doubt is on the record — not silently dropped
    // (you paid) and not silently accepted (you should know).
    expect(res.spentUsdc).toBe(2);
    expect(res.hires).toBe(1);
    const review = getGrowEvents(res.run.runId).find((e) => e.kind === "review")!;
    expect(review.summary).toContain("already paid for");
  });

  it("accepts the work when the reviewer itself fails", async () => {
    const deps: GrowDeps = {
      self: "e",
      think: async (p: string) => {
        if (p.includes("Break the mission into")) return '[{"capability":"x","task":"do it"}]';
        if (p.includes("Judge whether")) throw new Error("reviewer offline");
        if (p.includes("deciding what is still worth doing")) return "[]";
        return "FINAL";
      },
      search: async () => [{ agentId: "s", name: "s", priceUsdc: 0, proofScore: 1, capabilities: [] }],
      hire: async () => ({ taskId: "t", status: "completed" as const, output: "work", costUsdc: 0 }),
    };
    // A broken safeguard must not discard results — it should get out of the way.
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 1 });
    expect(res.hires).toBe(1);
  });
});

describe("it revises the plan once it sees the results", () => {
  it("replaces the remaining steps and says so", async () => {
    const asked: string[] = [];
    const deps: GrowDeps = {
      self: "e",
      think: brain({
        plan: '[{"capability":"a","task":"first"},{"capability":"b","task":"second"}]',
        replan: '[{"capability":"c","task":"a better second step"}]',
      }),
      search: async ({ capability }) => [
        { agentId: `${capability}-pro`, name: capability ?? "", priceUsdc: 0, proofScore: 500, capabilities: [] },
      ],
      hire: async ({ to, task }) => {
        asked.push(task);
        return { taskId: `t-${to}`, status: "completed" as const, output: `out-${to}`, costUsdc: 0 };
      },
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 3 });
    expect(asked).toEqual(["first", "a better second step"]);
    const plans = getGrowEvents(res.run.runId).filter((e) => e.kind === "plan");
    expect(plans.some((p) => p.summary.includes("Revised the plan"))).toBe(true);
  });

  it("never re-commissions a step that is already done and paid for", async () => {
    const asked: string[] = [];
    const deps: GrowDeps = {
      self: "e",
      think: brain({
        plan: '[{"capability":"a","task":"first"},{"capability":"b","task":"second"}]',
        // A model handing back the WHOLE plan, finished steps included.
        replan: '[{"capability":"a","task":"first"},{"capability":"b","task":"second"}]',
      }),
      search: async ({ capability }) => [
        { agentId: `${capability}-pro`, name: capability ?? "", priceUsdc: 1, proofScore: 500, capabilities: [] },
      ],
      hire: async ({ to, task }) => {
        asked.push(task);
        return { taskId: `t-${to}`, status: "completed" as const, output: `out-${to}`, costUsdc: 1 };
      },
    };
    const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 20, perHireCapUsdc: 2, maxHires: 4 });
    // "first" is bought and paid for; a revision must not buy it again.
    expect(asked).toEqual(["first", "second"]);
    expect(res.spentUsdc).toBe(2);
  });
});

// ── When nobody can be hired ─────────────────────────────────────────────────

describe("a step with no specialist isn't just lost", () => {
  const noOneAvailable = { self: "e", search: async () => [] } as const;

  it("does it itself, and says plainly that nothing was bought", async () => {
    const res = await runGrowMission(
      {
        ...noOneAvailable,
        think: brain({ plan: '[{"capability":"rare","task":"the hard bit"}]' }),
        hire: async () => { throw new Error("nothing to hire"); },
        attempt: async (task) => `did ${task} myself`,
      },
      { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 1 },
    );
    expect(res.spentUsdc).toBe(0);
    expect(res.deliverable).toBe("FINAL");
    const ev = getGrowEvents(res.run.runId).find((e) => e.kind === "self")!;
    // The distinction has to survive into the record: this part had no hire,
    // no payment and no receipt, and the timeline must not imply otherwise.
    expect(ev.summary).toContain("did it itself");
    expect(ev.summary).toContain("no receipt");
  });

  it("holds its own work to the same standard as work it paid for", async () => {
    const res = await runGrowMission(
      {
        ...noOneAvailable,
        think: brain({
          plan: '[{"capability":"rare","task":"the hard bit"}]',
          review: () => '{"ok":false,"reason":"waffle"}',
        }),
        hire: async () => { throw new Error("nothing to hire"); },
        attempt: async () => "some waffle",
      },
      { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 1 },
    );
    // Rejected by its own reviewer, so it never reaches the deliverable.
    const self = getGrowEvents(res.run.runId).find((e) => e.kind === "self")!;
    expect(self.summary).toContain("not good enough");
    expect(res.deliverable).toBeUndefined();
  });

  it("still skips the step when the agent has no way to attempt it", async () => {
    const res = await runGrowMission(
      {
        ...noOneAvailable,
        think: brain({ plan: '[{"capability":"rare","task":"the hard bit"}]' }),
        hire: async () => { throw new Error("nothing to hire"); },
        // no `attempt` — an agent without tools behaves exactly as before
      },
      { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 1 },
    );
    expect(getGrowEvents(res.run.runId).some((e) => e.summary.includes("skipping this step"))).toBe(true);
  });
});

describe("the deliverable says what it's made of", () => {
  it("counts in-house steps separately from hires, and puts it on the record", async () => {
    const res = await runGrowMission(
      {
        self: "e",
        think: brain({ plan: '[{"capability":"buyable","task":"one"},{"capability":"rare","task":"two"}]' }),
        // A specialist exists for the first capability, nobody for the second.
        search: async ({ capability }) =>
          capability === "buyable"
            ? [{ agentId: "pro", name: "pro", priceUsdc: 1, proofScore: 700, capabilities: [] }]
            : [],
        hire: async ({ to }) => ({ taskId: `t-${to}`, status: "completed" as const, output: "bought work", costUsdc: 1 }),
        attempt: async () => "in-house work",
      },
      { mission: "m", budgetUsdc: 5, perHireCapUsdc: 2, maxHires: 2 },
    );
    expect(res.hires).toBe(1);
    expect(res.selfDone).toBe(1);
    const last = getGrowEvents(res.run.runId).at(-1)!;
    expect(last.summary).toContain("1 step done in-house (no hire, no receipt)");
  });
});

// ── Independent steps run together ───────────────────────────────────────────

describe("parallel steps", () => {
  /** Records how many hires were in flight at once. */
  function tracker() {
    let live = 0;
    const t = { peak: 0, order: [] as string[] };
    return {
      t,
      hire: async ({ to }: { to: string }) => {
        live++; t.peak = Math.max(t.peak, live); t.order.push(to);
        await new Promise((r) => setTimeout(r, 25));
        live--;
        return { taskId: `t-${to}`, status: "completed" as const, output: `out-${to}`, costUsdc: 1 };
      },
    };
  }
  const oneEach: GrowDeps["search"] = async ({ capability }) => [
    { agentId: `${capability}-pro`, name: capability ?? "", priceUsdc: 1, proofScore: 500, capabilities: [] },
  ];

  it("runs steps that declare no dependencies at the same time", async () => {
    const { t, hire } = tracker();
    const res = await runGrowMission(
      {
        self: "e",
        think: brain({
          plan: '[{"capability":"a","task":"1","needs":[]},{"capability":"b","task":"2","needs":[]},{"capability":"c","task":"3","needs":[]}]',
        }),
        search: oneEach, hire,
      },
      { mission: "m", budgetUsdc: 20, perHireCapUsdc: 2, maxHires: 3 },
    );
    expect(t.peak).toBeGreaterThan(1);
    expect(res.hires).toBe(3);
    const evs = getGrowEvents(res.run.runId).map((e) => e.summary);
    expect(evs.some((x) => x.includes("independent steps at once"))).toBe(true);
  });

  it("keeps a dependent step waiting for the one it needs", async () => {
    const { t, hire } = tracker();
    await runGrowMission(
      {
        self: "e",
        think: brain({
          // 3 depends on 1; 1 and 2 are free to go together.
          plan: '[{"capability":"a","task":"1","needs":[]},{"capability":"b","task":"2","needs":[]},{"capability":"c","task":"3","needs":[1]}]',
        }),
        search: oneEach, hire,
      },
      { mission: "m", budgetUsdc: 20, perHireCapUsdc: 2, maxHires: 3 },
    );
    // c can't be in the first wave — a and b are, so c comes after.
    expect(t.order.slice(0, 2).sort()).toEqual(["a-pro", "b-pro"]);
    expect(t.order[2]).toBe("c-pro");
  });

  it("never lets concurrency spend past the budget", async () => {
    const { t, hire } = tracker();
    // Room for exactly two hires at the cap. Four independent steps want to run.
    const res = await runGrowMission(
      {
        self: "e",
        think: brain({
          plan: '[{"capability":"a","task":"1","needs":[]},{"capability":"b","task":"2","needs":[]},{"capability":"c","task":"3","needs":[]},{"capability":"d","task":"4","needs":[]}]',
        }),
        search: async ({ capability }) => [
          { agentId: `${capability}-pro`, name: capability ?? "", priceUsdc: 2, proofScore: 500, capabilities: [] },
        ],
        hire: async (o) => { const r = await hire(o); return { ...r, costUsdc: 2 }; },
      },
      { mission: "m", budgetUsdc: 4, perHireCapUsdc: 2, maxHires: 4 },
    );
    // Concurrent hires all read "spent so far" before any has paid, so the wave
    // is sized to what the budget covers at worst case rather than trusting the
    // per-hire check to serialise.
    expect(t.peak).toBeLessThanOrEqual(2);
    expect(res.spentUsdc).toBeLessThanOrEqual(4);
  });

  it("ignores a dependency on itself or on a later step", async () => {
    const { hire } = tracker();
    const res = await runGrowMission(
      {
        self: "e",
        // needs:[2] on step 1 points forward; needs:[1] on step 1 points at itself.
        think: brain({ plan: '[{"capability":"a","task":"1","needs":[1,2,99]},{"capability":"b","task":"2","needs":[]}]' }),
        search: oneEach, hire,
      },
      { mission: "m", budgetUsdc: 20, perHireCapUsdc: 2, maxHires: 2 },
    );
    // Nonsense dependencies would deadlock the scheduler; they're dropped, so
    // both steps still run.
    expect(res.hires).toBe(2);
  });
});

// ── Recovering a mission that died mid-flight ────────────────────────────────

describe("a mission stranded by a restart isn't money thrown away", () => {
  it("re-gathers the work already paid for and builds the deliverable", async () => {
    const { createGrowRun, recordGrowEvent, getGrowRun } = await import("@/lib/grow");
    const { resumeGrowMission } = await import("@/lib/growRunner");

    // A run that paid for two hires and then lost its process.
    const run = createGrowRun({ agentId: "a", ownerWallet: "W", mission: "the job", budgetUsdc: 10 });
    for (const [i, task] of [["t1", "step one"], ["t2", "step two"]] as const) {
      recordGrowEvent(run.runId, { kind: "payment", summary: `paid`, taskId: i, amountUsdc: 2 });
      recordGrowEvent(run.runId, { kind: "result", summary: task, taskId: i, data: { preview: "short preview" } });
    }

    const res = await resumeGrowMission(
      {
        self: "a",
        think: async () => "DELIVERABLE FROM RECOVERED WORK",
        search: async () => { throw new Error("resume must not search"); },
        hire: async () => { throw new Error("resume must never hire"); },
        // The timeline only kept a preview; the full output comes from the task.
        fetchOutput: async (taskId) => `full output of ${taskId}`,
      },
      run.runId,
    );

    expect(res?.deliverable).toBe("DELIVERABLE FROM RECOVERED WORK");
    expect(res?.hires).toBe(2);
    expect(res?.spentUsdc).toBe(4);      // what was already spent, not re-spent
    expect(getGrowRun(run.runId)?.status).toBe("completed");
  });

  it("falls back to the stored preview when a task can't be read", async () => {
    const { createGrowRun, recordGrowEvent } = await import("@/lib/grow");
    const { resumeGrowMission } = await import("@/lib/growRunner");
    const run = createGrowRun({ agentId: "a", ownerWallet: "W", mission: "m", budgetUsdc: 10 });
    recordGrowEvent(run.runId, { kind: "result", summary: "step", taskId: "gone", data: { preview: "the preview" } });

    let sawPreview = false;
    const res = await resumeGrowMission(
      {
        self: "a",
        think: async (p: string) => { sawPreview = p.includes("the preview"); return "OUT"; },
        search: async () => [],
        hire: async () => { throw new Error("no"); },
        fetchOutput: async () => null,   // task unreadable
      },
      run.runId,
    );
    // Partial recovery beats none: a step the owner paid for isn't dropped just
    // because its task can no longer be fetched.
    expect(sawPreview).toBe(true);
    expect(res?.deliverable).toBe("OUT");
  });

  it("refuses to resume a run that already finished", async () => {
    const { createGrowRun, updateGrowRun } = await import("@/lib/grow");
    const { resumeGrowMission } = await import("@/lib/growRunner");
    const run = createGrowRun({ agentId: "a", ownerWallet: "W", mission: "m", budgetUsdc: 5 });
    updateGrowRun(run.runId, { status: "completed" });
    const deps = {
      self: "a", think: async () => "x", search: async () => [], hire: async () => { throw new Error("no"); },
    } as unknown as GrowDeps;
    expect(await resumeGrowMission(deps, run.runId)).toBeNull();
  });

  it("marks a run failed when nothing is recoverable", async () => {
    const { createGrowRun, getGrowRun } = await import("@/lib/grow");
    const { resumeGrowMission } = await import("@/lib/growRunner");
    const run = createGrowRun({ agentId: "a", ownerWallet: "W", mission: "m", budgetUsdc: 5 });
    const res = await resumeGrowMission(
      { self: "a", think: async () => "x", search: async () => [], hire: async () => { throw new Error("no"); } },
      run.runId,
    );
    expect(res?.deliverable).toBeUndefined();
    expect(getGrowRun(run.runId)?.status).toBe("failed");
  });
});

// ── Spending the budget well, not just legally ───────────────────────────────

describe("value for money among equals", () => {
  const plan = '[{"capability":"x","task":"do it"}]';
  const run = (cands: { agentId: string; priceUsdc: number; proofScore: number }[], budget = 10, cap = 5) => {
    const tried: string[] = [];
    return runGrowMission(
      {
        self: "e",
        think: brain({ plan }),
        search: async () => cands.map((c) => ({ ...c, name: c.agentId, capabilities: [] })),
        hire: async ({ to }) => {
          tried.push(to);
          return { taskId: `t-${to}`, status: "completed" as const, output: "work", costUsdc: cands.find((c) => c.agentId === to)!.priceUsdc };
        },
      },
      { mission: "m", budgetUsdc: budget, perHireCapUsdc: cap, maxHires: 1 },
    ).then((r) => ({ r, tried }));
  };

  it("takes the cheap one when it's within a few percent on score", async () => {
    // The case this exists for: 4 USDC for 910, or 0.40 for 890. Ranking on
    // score alone burns the whole budget on one step.
    const { r, tried } = await run([
      { agentId: "expensive", priceUsdc: 4, proofScore: 910 },
      { agentId: "nearly-as-good", priceUsdc: 0.4, proofScore: 890 },
    ]);
    expect(tried).toEqual(["nearly-as-good"]);
    expect(r.spentUsdc).toBe(0.4);
  });

  it("still pays up for a specialist that is genuinely better", async () => {
    // 400 is nowhere near 900 — cheapness must not buy a worse result.
    const { tried } = await run([
      { agentId: "proven", priceUsdc: 4, proofScore: 900 },
      { agentId: "cheap-and-weak", priceUsdc: 0.2, proofScore: 400 },
    ]);
    expect(tried).toEqual(["proven"]);
  });

  it("prefers the better score when two cost the same", async () => {
    const { tried } = await run([
      { agentId: "same-price-worse", priceUsdc: 1, proofScore: 880 },
      { agentId: "same-price-better", priceUsdc: 1, proofScore: 900 },
    ]);
    expect(tried).toEqual(["same-price-better"]);
  });

  it("makes a fixed budget reach further across a plan", async () => {
    // Four steps, 4 USDC. At top-of-list pricing that buys one; on value, all four.
    const tried: string[] = [];
    const res = await runGrowMission(
      {
        self: "e",
        think: brain({
          plan: '[{"capability":"a","task":"1"},{"capability":"b","task":"2"},{"capability":"c","task":"3"},{"capability":"d","task":"4"}]',
        }),
        search: async ({ capability }) => [
          { agentId: `${capability}-premium`, name: "premium", priceUsdc: 4, proofScore: 910, capabilities: [] },
          { agentId: `${capability}-value`, name: "value", priceUsdc: 0.5, proofScore: 880, capabilities: [] },
        ],
        hire: async ({ to }) => {
          tried.push(to);
          return { taskId: `t-${to}`, status: "completed" as const, output: "work", costUsdc: to.endsWith("-value") ? 0.5 : 4 };
        },
      },
      { mission: "m", budgetUsdc: 4, perHireCapUsdc: 4, maxHires: 4 },
    );
    expect(res.hires).toBe(4);
    expect(tried.every((t) => t.endsWith("-value"))).toBe(true);
    expect(res.spentUsdc).toBe(2);
  });

  it("records that a cheaper near-equal was a deliberate choice", async () => {
    const { r } = await run([
      { agentId: "expensive", priceUsdc: 4, proofScore: 910 },
      { agentId: "nearly-as-good", priceUsdc: 0.4, proofScore: 890 },
    ]);
    const hire = getGrowEvents(r.run.runId).find((e) => e.kind === "hire")!;
    expect(hire.summary).toContain("within 5% of the best available, and cheaper");
  });

  it("falls back to price when nothing has a score yet", async () => {
    const { tried } = await run([
      { agentId: "unproven-pricey", priceUsdc: 3, proofScore: 0 },
      { agentId: "unproven-cheap", priceUsdc: 1, proofScore: 0 },
    ]);
    expect(tried).toEqual(["unproven-cheap"]);
  });
});

// ── The mission receipt ──────────────────────────────────────────────────────

describe("the deliverable itself is provable", () => {
  async function finishedMission() {
    const tried: string[] = [];
    const res = await runGrowMission(
      {
        self: "e",
        think: brain({ plan: '[{"capability":"research","task":"one"},{"capability":"writing","task":"two"}]' }),
        search: async ({ capability }) => [
          { agentId: `${capability}-pro`, name: `${capability} pro`, priceUsdc: 1, proofScore: 800, capabilities: [] },
        ],
        hire: async ({ to }) => {
          tried.push(to);
          return { taskId: `task-${to}`, status: "completed" as const, output: `output of ${to}`, costUsdc: 1 };
        },
        fetchOutput: async (taskId) => `output of ${taskId.replace("task-", "")}`,
      },
      { mission: "the brief", budgetUsdc: 10, perHireCapUsdc: 2, maxHires: 2 },
    );
    const { getGrowRun } = await import("@/lib/grow");
    return { res, run: getGrowRun(res.run.runId)! };
  }

  it("seals a manifest covering every step, chained", async () => {
    const { verifyMissionManifest } = await import("@/lib/growReceipt");
    const { run } = await finishedMission();
    const m = run.manifest as import("@/lib/growReceipt").MissionManifest;

    expect(m.entries).toHaveLength(2);
    expect(m.entries[0].prevHash).toBeNull();
    expect(m.entries[1].prevHash).toBe(m.entries[0].hash);
    expect(m.totals).toEqual({ hires: 2, inHouse: 0, spentUsdc: 2 });
    expect(verifyMissionManifest(m).ok).toBe(true);
  });

  it("holds hashes, never the brief or the deliverable", async () => {
    const { run } = await finishedMission();
    const raw = JSON.stringify(run.manifest);
    // The manifest is published; the content it describes is not.
    expect(raw).not.toContain("the brief");
    expect(raw).not.toContain("output of");
    expect((run.manifest as { missionHash: string }).missionHash).toHaveLength(64);
  });

  it("confirms the deliverable it describes, and rejects a different one", async () => {
    const { verifyMissionManifest } = await import("@/lib/growReceipt");
    const { res, run } = await finishedMission();
    const m = run.manifest as import("@/lib/growReceipt").MissionManifest;

    expect(verifyMissionManifest(m, { deliverable: res.deliverable }).deliverableMatches).toBe(true);
    const swapped = verifyMissionManifest(m, { deliverable: "a different result entirely" });
    expect(swapped.deliverableMatches).toBe(false);
    expect(swapped.ok).toBe(false);
    expect(swapped.problems.join(" ")).toContain("not the deliverable");
  });

  it("catches a tampered cost, a swapped specialist, and a re-ordered step", async () => {
    const { verifyMissionManifest } = await import("@/lib/growReceipt");
    const { run } = await finishedMission();
    const m = run.manifest as import("@/lib/growReceipt").MissionManifest;

    const cheapened = structuredClone(m);
    cheapened.entries[0].costUsdc = 0;
    expect(verifyMissionManifest(cheapened).chainIntact).toBe(false);

    const impersonated = structuredClone(m);
    impersonated.entries[1].agentId = "someone-else";
    expect(verifyMissionManifest(impersonated).chainIntact).toBe(false);

    const reordered = structuredClone(m);
    reordered.entries.reverse();
    expect(verifyMissionManifest(reordered).chainIntact).toBe(false);
  });

  it("marks in-house steps in the manifest, so provenance survives publication", async () => {
    const { verifyMissionManifest } = await import("@/lib/growReceipt");
    const res = await runGrowMission(
      {
        self: "e",
        think: brain({ plan: '[{"capability":"buyable","task":"one"},{"capability":"rare","task":"two"}]' }),
        search: async ({ capability }) =>
          capability === "buyable"
            ? [{ agentId: "pro", name: "pro", priceUsdc: 1, proofScore: 700, capabilities: [] }]
            : [],
        hire: async () => ({ taskId: "task-pro", status: "completed" as const, output: "bought", costUsdc: 1 }),
        attempt: async () => "made in-house",
        fetchOutput: async () => "bought",
      },
      { mission: "m", budgetUsdc: 5, perHireCapUsdc: 2, maxHires: 2 },
    );
    const { getGrowRun } = await import("@/lib/grow");
    const m = getGrowRun(res.run.runId)!.manifest as import("@/lib/growReceipt").MissionManifest;

    expect(m.totals).toMatchObject({ hires: 1, inHouse: 1 });
    const inHouse = m.entries.find((e) => e.source === "in-house")!;
    // No specialist, no task, no receipt — a reader must be able to see which
    // parts nobody witnessed.
    expect(inHouse.taskId).toBeUndefined();
    expect(inHouse.receiptUrl).toBeUndefined();
    expect(inHouse.costUsdc).toBe(0);
    expect(verifyMissionManifest(m).inHouseSteps).toBe(1);
  });

  it("gives a step a null hash rather than a false one when its output is gone", async () => {
    const res = await runGrowMission(
      {
        self: "e",
        think: brain({ plan: '[{"capability":"x","task":"one"}]' }),
        search: async () => [{ agentId: "pro", name: "pro", priceUsdc: 0, proofScore: 500, capabilities: [] }],
        hire: async () => ({ taskId: "t1", status: "completed" as const, output: "a long real output", costUsdc: 0 }),
        fetchOutput: async () => null,   // can't be re-read
      },
      { mission: "m", budgetUsdc: 5, perHireCapUsdc: 1, maxHires: 1 },
    );
    const { getGrowRun } = await import("@/lib/grow");
    const m = getGrowRun(res.run.runId)!.manifest as import("@/lib/growReceipt").MissionManifest;
    // Hashing the 280-char preview would pin something nobody can reproduce.
    expect(m.entries[0].outputHash).toBeNull();
  });
});
