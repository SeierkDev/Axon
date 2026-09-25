// What the network spends on inference, and which half earns nothing back.
//
// The number this produces is what a free-call allowance gets priced from, so the tests are mostly
// about it being honest: free and paid kept apart, averages per hire rather than per model call,
// and spend it cannot price counted out loud instead of quietly dropped.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { getSpendSummary, averageFreeCallCostUsd } from "@/lib/spendSummary";

const now = () => new Date().toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

let seq = 0;

const task = (id: string, payment: string | null) => {
  const db = getDb();
  db.prepare("DELETE FROM tasks WHERE task_id = ?").run(id);
  db.prepare(
    `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, payment)
     VALUES (?, 'buyer', 'seller', 'work', 'completed', ?, ?)`,
  ).run(id, now(), payment);
};

const step = (taskId: string, costUsd: number | null, model: string | null = "claude-sonnet-5", at = now()) => {
  getDb()
    .prepare(
      `INSERT INTO trace_events
         (trace_id, seq, task_id, kind, model, input_tokens, output_tokens, cost_usd, hash, created_at)
       VALUES (?, ?, ?, 'step.model', ?, 100, 50, ?, ?, ?)`,
    )
    .run(taskId, ++seq, taskId, model, costUsd, `h${seq}`, at);
};

describe("summing model spend", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM trace_events").run();
    db.prepare("DELETE FROM tasks WHERE task_id LIKE 'spend-%'").run();
  });

  it("keeps free and paid apart", async () => {
    task("spend-free", null);
    task("spend-paid", "0.0002 ETH");
    step("spend-free", 0.01);
    step("spend-paid", 0.02);

    const s = getSpendSummary(24);
    // A paid hire arrived with ETH, so the buyer covered its inference. A free one did not. Summing
    // them together hides the only line that costs the project anything.
    expect(s.free.costUsd).toBeCloseTo(0.01, 6);
    expect(s.paid.costUsd).toBeCloseTo(0.02, 6);
    expect(s.total.costUsd).toBeCloseTo(0.03, 6);
  });

  it("averages per hire, not per model call", async () => {
    task("spend-multi", null);
    // One task that used six tool steps is one hire that cost the sum of them.
    for (let i = 0; i < 6; i++) step("spend-multi", 0.005);

    const s = getSpendSummary(24);
    expect(s.free.tasks).toBe(1);
    expect(s.free.avgCostUsd).toBeCloseTo(0.03, 6);
  });

  it("gives the free-lane average, which is what an allowance is priced from", async () => {
    task("spend-f1", null);
    task("spend-f2", null);
    step("spend-f1", 0.02);
    step("spend-f2", 0.04);

    expect(averageFreeCallCostUsd(24)).toBeCloseTo(0.03, 6);
  });

  it("falls back to the overall average when the free lane is empty", async () => {
    task("spend-p1", "0.001 ETH");
    step("spend-p1", 0.05);

    expect(averageFreeCallCostUsd(24)).toBeCloseTo(0.05, 6);
  });

  it("returns null rather than zero when there is nothing to average", async () => {
    // Zero would read as "free calls are free", which is the most expensive thing this could imply.
    expect(averageFreeCallCostUsd(24)).toBeNull();
  });

  it("counts spend it cannot price instead of dropping it", async () => {
    task("spend-unknown", null);
    step("spend-unknown", null, "some-model-nobody-priced");

    const s = getSpendSummary(24);
    // A total that silently omits part of the spend reads as complete and is not.
    expect(s.unpricedSteps).toBe(1);
    expect(s.total.costUsd).toBe(0);
  });

  it("respects the window", async () => {
    task("spend-old", null);
    task("spend-new", null);
    step("spend-old", 0.5, "claude-sonnet-5", hoursAgo(48));
    step("spend-new", 0.01);

    expect(getSpendSummary(24).total.costUsd).toBeCloseTo(0.01, 6);
    expect(getSpendSummary(72).total.costUsd).toBeCloseTo(0.51, 6);
  });

  it("breaks spend down by model", async () => {
    task("spend-a", null);
    task("spend-b", null);
    step("spend-a", 0.03, "claude-sonnet-5");
    step("spend-b", 0.001, "claude-haiku-4-5");

    const s = getSpendSummary(24);
    expect(s.byModel[0]!.model).toBe("claude-sonnet-5"); // ordered by cost
    expect(s.byModel[0]!.costUsd).toBeCloseTo(0.03, 6);
    expect(s.byModel[1]!.inputTokens).toBe(100);
  });

  it("returns an empty summary rather than throwing on a bad window", async () => {
    const s = getSpendSummary(0);
    expect(s.total.tasks).toBe(0);
    expect(s.total.avgCostUsd).toBeNull();
  });
});
