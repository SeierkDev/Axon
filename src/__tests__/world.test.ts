import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getWorldSnapshot, getAgentActivity, getWorldActivity, getAgentWallReceipts, _clearWorldCache } from "@/lib/world";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let counter = 0;
function makeAgent(category: string, reputation = 0): Agent {
  counter++;
  const a: Agent = {
    agentId: `world-${counter}-${randomUUID().slice(0, 8)}`,
    name: `World Agent ${counter}`,
    capabilities: ["x"],
    publicKey: `pk-world-${counter}`,
    provider: "anthropic",
    reputation,
    category,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

function completedTask(to: string, ageMs = 0): void {
  const ts = new Date(Date.now() - ageMs).toISOString();
  getDb()
    .prepare(
      `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, started_at, completed_at)
       VALUES (?, 'requester', ?, 'body', 'completed', ?, ?, ?)`
    )
    .run(randomUUID(), to, ts, ts, ts);
}

function settlementUsdc(to: string, amount: number): void {
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, fee_amount, currency, created_at, settled_at)
       VALUES (?, NULL, 'requester', ?, ?, 'completed', 0, 'USDC', ?, ?)`
    )
    .run(randomUUID(), to, amount, new Date().toISOString(), new Date().toISOString());
}

describe("Axon Open World — city model", () => {
  it("groups agents into districts by category and centres the city near origin", () => {
    const a = makeAgent("Finance");
    const b = makeAgent("Content");
    const snap = getWorldSnapshot();

    const districts = snap.districts.map((d) => d.name);
    expect(districts).toContain("Finance");
    expect(districts).toContain("Content");

    const pa = snap.plots.find((p) => p.agentId === a.agentId)!;
    const pb = snap.plots.find((p) => p.agentId === b.agentId)!;
    expect(pa.district).toBe("Finance");
    expect(pb.district).toBe("Content");
    // Agents in different categories land in different places.
    expect(pa.x !== pb.x || pa.z !== pb.z).toBe(true);
  });

  it("produces a deterministic, stable layout across calls", () => {
    const a = makeAgent("Dev");
    const first = getWorldSnapshot().plots.find((p) => p.agentId === a.agentId)!;
    const second = getWorldSnapshot().plots.find((p) => p.agentId === a.agentId)!;
    expect(second.x).toBe(first.x);
    expect(second.z).toBe(first.z);
  });

  it("maps real metrics to building dimensions and activity", () => {
    const earner = makeAgent("Trading");
    const idle = makeAgent("Trading");
    settlementUsdc(earner.agentId, 500);
    completedTask(earner.agentId, 0); // recent → active
    completedTask(earner.agentId, 0);
    completedTask(idle.agentId, 48 * 3_600_000); // old → not active

    const snap = getWorldSnapshot();
    const pe = snap.plots.find((p) => p.agentId === earner.agentId)!;
    const pi = snap.plots.find((p) => p.agentId === idle.agentId)!;

    expect(pe.usdcEarned).toBe(500);
    expect(pe.tasksCompleted).toBe(2);
    expect(pe.size).toBeGreaterThan(pi.size); // earnings → bigger footprint
    expect(pe.height).toBeGreaterThan(pi.height); // throughput → taller
    expect(pe.active).toBe(true);
    expect(pi.active).toBe(false);
  });

  it("normalises reputation to a 0..1 glow within the snapshot", () => {
    makeAgent("Research", 5);
    const snap = getWorldSnapshot();
    const norms = snap.plots.map((p) => p.reputationNorm);
    expect(Math.max(...norms)).toBeLessThanOrEqual(1);
    expect(Math.min(...norms)).toBeGreaterThanOrEqual(0);
  });

  it("excludes contract-test agents from the city", () => {
    const real = makeAgent("Ops");
    // A contract-test id pattern (split-a-<12+ digits>) must be filtered out.
    const testId = `split-a-${Date.now()}000`;
    getDb()
      .prepare(
        `INSERT INTO agents (agent_id, name, capabilities, public_key, reputation, category, provider, verification_status, created_at)
         VALUES (?, 'Test Artifact', '["x"]', 'pk', 0, 'Ops', 'anthropic', 'unverified', ?)`
      )
      .run(testId, new Date().toISOString());

    const snap = getWorldSnapshot();
    expect(snap.plots.some((p) => p.agentId === real.agentId)).toBe(true);
    expect(snap.plots.some((p) => p.agentId === testId)).toBe(false);
  });

  it("reports totals consistent with the plots", () => {
    const snap = getWorldSnapshot();
    expect(snap.totals.agents).toBe(snap.plots.length);
    expect(snap.totals.districts).toBe(snap.districts.length);
    expect(snap.totals.activeAgents).toBe(snap.plots.filter((p) => p.active).length);
  });
});

describe("Axon Open World — live agent activity (storefront panel)", () => {
  function taskWithStatus(to: string, status: string): void {
    const ts = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, started_at, completed_at)
         VALUES (?, 'requester', ?, 'body', ?, ?, ?, ?)`
      )
      .run(randomUUID(), to, status, ts, status === "queued" ? null : ts, status === "completed" ? ts : null);
  }

  it("counts running and queued tasks and the 24h completions", () => {
    const a = makeAgent("Research");
    taskWithStatus(a.agentId, "running");
    taskWithStatus(a.agentId, "queued");
    taskWithStatus(a.agentId, "queued");
    completedTask(a.agentId, 60_000); // 1 min ago — inside 24h
    completedTask(a.agentId, 30 * 3_600_000); // 30h ago — outside 24h

    const act = getAgentActivity(a.agentId);
    expect(act.running).toBe(1);
    expect(act.queued).toBe(2);
    expect(act.completed24h).toBe(1);
    expect(act.lastCompletedAt).not.toBeNull();
  });

  it("returns an all-idle shape for an agent with no tasks", () => {
    const a = makeAgent("Research");
    const act = getAgentActivity(a.agentId);
    expect(act).toEqual({ running: 0, queued: 0, lastCompletedAt: null, completed24h: 0 });
  });
});

describe("Axon Open World — live features (streaks, receipts wall, weekly top)", () => {
  it("getWorldActivity returns recent completions as metadata only", () => {
    const a = makeAgent("Research");
    const secret = "CONFIDENTIAL brief: acquire Zeta Corp";
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, started_at, completed_at)
         VALUES (?, 'requester', ?, ?, 'completed', ?, ?, ?)`
      )
      .run("streak-task-1", a.agentId, secret, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    const events = getWorldActivity();
    const mine = events.find((e) => e.taskId === "streak-task-1");
    expect(mine).toBeTruthy();
    expect(mine!.toAgent).toBe(a.agentId);
    expect(JSON.stringify(events)).not.toContain("CONFIDENTIAL");
  });

  it("getWorldActivity excludes completions older than 10 minutes", () => {
    const a = makeAgent("Research");
    completedTask(a.agentId, 15 * 60_000); // 15 min ago
    expect(getWorldActivity().some((e) => e.toAgent === a.agentId)).toBe(false);
  });

  it("getAgentWallReceipts returns framed-certificate metadata, never content", () => {
    const from = makeAgent("Research");
    const to = makeAgent("Development");
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, from_agent, to_agent, task, payment, status, created_at, started_at, completed_at)
         VALUES (?, ?, ?, 'CONFIDENTIAL work item', '0.25 USDC', 'completed', ?, ?, ?)`
      )
      .run("wall-task-1", from.agentId, to.agentId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    const wall = getAgentWallReceipts(to.agentId);
    expect(wall.length).toBe(1);
    expect(wall[0]).toMatchObject({ taskId: "wall-task-1", counterparty: from.name, payment: "0.25 USDC" });
    expect(JSON.stringify(wall)).not.toContain("CONFIDENTIAL");
  });

  it("snapshot weeklyTop ranks by 7-day completions and carries the listed price", () => {
    const busy = makeAgent("Research");
    getDb().prepare("UPDATE agents SET price = '0.30 USDC' WHERE agent_id = ?").run(busy.agentId);
    // Clearly the week's busiest — the shared test DB holds other completions.
    for (let i = 0; i < 25; i++) completedTask(busy.agentId, i * 60_000);

    _clearWorldCache();
    const snap = getWorldSnapshot();
    expect(snap.weeklyTop.length).toBeLessThanOrEqual(3);
    expect(snap.weeklyTop[0]).toMatchObject({ agentId: busy.agentId, name: busy.name, price: "0.30 USDC" });
    expect(snap.weeklyTop[0].tasks7d).toBeGreaterThanOrEqual(25);
    for (let i = 1; i < snap.weeklyTop.length; i++) {
      expect(snap.weeklyTop[i - 1].tasks7d).toBeGreaterThanOrEqual(snap.weeklyTop[i].tasks7d);
    }
  });
});
