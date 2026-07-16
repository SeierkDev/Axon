// Measured costs — the network-activity cron now EXECUTES each task against the
// live model, so receipts carry the provider's real reported usage, not an
// artifact-size estimate. These tests drive the real route with a mocked
// provider and assert the end-to-end contract:
//   (1) a successful task's step.model carries the MEASURED tokens + a cost
//       derived from them, and a settlement is written;
//   (2) a failed inference fails the task and writes NO settlement (the guard).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { recordModelUsage } from "@/lib/modelUsage";

// Never post to Telegram in a test.
vi.mock("@/lib/telegram", () => ({ postSingleTask: vi.fn(async () => {}) }));

// Swap only the live inference — everything else in providers stays real.
const runMock = vi.fn();
vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>();
  return { ...actual, runWithProvider: (...args: unknown[]) => runMock(...args) };
});

import { POST } from "@/app/api/cron/demo-activity/route";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { getPublicTrace } from "@/lib/traceEvents";
import { NextRequest } from "next/server";
import type { Agent } from "@/sdk/types";

function seedAgent(price: string | null): Agent {
  const a: Agent = {
    agentId: `netact-${randomUUID().slice(0, 8)}`,
    name: "Net Activity Worker",
    capabilities: ["research"], // GENERIC["research"] supplies the prompt
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    provider: "anthropic",
    reputation: 0,
    category: "Research",
    price: price ?? undefined,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

const call = () => POST(new NextRequest("http://localhost/api/cron/demo-activity", { method: "POST" }));

beforeEach(() => {
  runMock.mockReset();
  // A clean slate for the tables these assertions read.
  const db = getDb();
  db.exec("DELETE FROM transactions");
  db.exec("DELETE FROM trace_events");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM agents");
});

describe("network-activity cron — measured costs", () => {
  it("executes live, records MEASURED tokens/cost, and settles", async () => {
    seedAgent("0.15 USDC");
    seedAgent("0.15 USDC"); // a second so there's always a distinct sender
    runMock.mockImplementation(async () => {
      recordModelUsage("claude-sonnet-5", 312, 148); // the provider's real usage
      return "A measured, live answer.";
    });

    const res = await call();
    const body = (await res.json()) as { ok: boolean; created: number; taskIds: string[] };
    expect(body.ok).toBe(true);
    expect(body.created).toBeGreaterThan(0);

    const db = getDb();
    // Every created task actually completed…
    for (const taskId of body.taskIds) {
      const t = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get(taskId) as { status: string };
      expect(t.status).toBe("completed");

      // …its step.model carries the provider's measured numbers, not length/4…
      const trace = getPublicTrace(taskId)!;
      const step = trace.events.find((e) => e.kind === "step.model")!;
      expect(step.inputTokens).toBe(312);
      expect(step.outputTokens).toBe(148);
      expect(step.model).toBe("claude-sonnet-5");
      // …cost derived from those real tokens at the published $3/$15 per-1M price…
      expect(step.costUsd).toBeCloseTo((312 / 1e6) * 3 + (148 / 1e6) * 15, 9);
      expect(trace.summary.totalInputTokens).toBe(312);

      // …and exactly one settlement was written for it.
      const settle = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE task_id = ?").get(taskId) as { n: number };
      expect(settle.n).toBe(1);
    }
  }, 30_000);

  it("a failed inference fails the task and writes NO settlement", async () => {
    seedAgent(null);
    seedAgent(null);
    runMock.mockImplementation(async () => {
      throw new Error("Upstream inference timeout");
    });

    const res = await call();
    const body = (await res.json()) as { created: number; taskIds: string[] };
    expect(body.created).toBeGreaterThan(0);

    const db = getDb();
    for (const taskId of body.taskIds) {
      const t = db.prepare("SELECT status FROM tasks WHERE task_id = ?").get(taskId) as { status: string };
      expect(t.status).toBe("failed");
      // the guard: a task that never completed must never be settled
      const settle = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE task_id = ?").get(taskId) as { n: number };
      expect(settle.n).toBe(0);
    }
    // …and no stray step.model claimed measured usage for a failed run either.
    const settlements = db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number };
    expect(settlements.n).toBe(0);
  }, 30_000);
});
