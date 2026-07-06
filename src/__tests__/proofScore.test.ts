// Proof Score: a portable, third-party-verifiable reputation credential.
// Contracts — (1) deterministic + tamper-evident (same data → same score AND
// contentHash, recomputable by anyone); (2) un-gameable (driven only by real
// settled work); (3) evidence links to public receipts; (4) never leaks content.

import { describe, it, expect } from "vitest";
import { randomUUID, createHash } from "crypto";
import { computeProofScore, verifyProofScore, updateAgentProofScore, recomputeAllProofScores } from "@/lib/proofScore";
import { recordCrossNetworkSettlement } from "@/lib/crossNetwork";
import { createTask, completeTask, startTask } from "@/lib/tasks";
import { createAgent, getAgentById } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let n = 0;
function makeAgent(name = "Worker"): Agent {
  n++;
  const a: Agent = {
    agentId: `ps-agent-${n}-${randomUUID().slice(0, 6)}`,
    name,
    capabilities: ["research"],
    publicKey: `pk-ps-${n}`,
    provider: "anthropic",
    reputation: 0,
    category: "Research",
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

// A completed task with a settled USDC transaction — the un-gameable substrate.
function settledJob(from: string, to: string, usdc: number, content = "OUTPUT — never surfaces"): string {
  const t = createTask({ fromAgent: from, toAgent: to, task: "CONFIDENTIAL brief", payment: `${usdc} USDC` });
  startTask(t.taskId);
  completeTask(t.taskId, content);
  const ts = new Date().toISOString();
  getDb().prepare("UPDATE tasks SET completed_at = ?, started_at = ? WHERE task_id = ?").run(ts, ts, t.taskId);
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, fee_amount, currency, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, 'completed', 0, 'USDC', ?, ?)`,
    )
    .run(randomUUID(), t.taskId, from, to, usdc, ts, ts);
  return t.taskId;
}

// A completed task with NO settlement (free-lane work) — feeds quality but must
// never inflate the proven-work booster.
function freeJob(from: string, to: string): string {
  const t = createTask({ fromAgent: from, toAgent: to, task: "free work" });
  startTask(t.taskId);
  completeTask(t.taskId, "output");
  const ts = new Date().toISOString();
  getDb().prepare("UPDATE tasks SET completed_at = ?, started_at = ? WHERE task_id = ?").run(ts, ts, t.taskId);
  return t.taskId;
}

// The exact canonicalization the module uses — so this test verifies the hash
// the way an independent third party would.
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

describe("computeProofScore", () => {
  it("returns null for an unknown agent", () => {
    expect(computeProofScore("nope-does-not-exist")).toBeNull();
  });

  it("is 0 / tier New for an agent with no work", () => {
    const a = makeAgent();
    const p = computeProofScore(a.agentId)!;
    expect(p.score).toBe(0);
    expect(p.tier).toBe("New");
    expect(p.evidenceCount).toBe(0);
    expect(p.evidence).toHaveLength(0);
  });

  it("builds a bounded score from settled work, evidence linking to receipts", () => {
    const from = makeAgent("Requester");
    const to = makeAgent("Worker");
    const id = settledJob(from.agentId, to.agentId, 0.5);
    const p = computeProofScore(to.agentId)!;
    expect(p.score).toBeGreaterThan(0);
    expect(p.score).toBeLessThanOrEqual(1000);
    expect(p.inputs.settledUsdc).toBeCloseTo(0.5, 6);
    expect(p.evidenceCount).toBe(1);
    expect(p.evidence[0]).toMatchObject({ taskId: id, receipt: `/r/${id}`, verify: `/api/receipts/${id}/public` });
  });

  it("is deterministic — same data yields the same score AND contentHash", () => {
    const from = makeAgent();
    const to = makeAgent();
    settledJob(from.agentId, to.agentId, 1);
    const a = computeProofScore(to.agentId)!;
    const b = computeProofScore(to.agentId)!;
    expect(a.score).toBe(b.score);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders evidence deterministically when completed_at ties (stable, citable hash)", () => {
    const from = makeAgent();
    const to = makeAgent();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(settledJob(from.agentId, to.agentId, 1));
    // Force a batch-settlement tie: all three share the same completed_at.
    const ts = new Date().toISOString();
    getDb().prepare(`UPDATE tasks SET completed_at = ? WHERE task_id IN (${ids.map(() => "?").join(",")})`).run(ts, ...ids);
    const a = computeProofScore(to.agentId)!;
    const b = computeProofScore(to.agentId)!;
    expect(a.contentHash).toBe(b.contentHash);
    // total order under ties = completed_at DESC, then task_id ASC
    expect(a.evidence.map((e) => e.taskId)).toEqual([...ids].sort());
    expect(b.evidence.map((e) => e.taskId)).toEqual([...ids].sort());
  });

  it("contentHash independently recomputes (tamper-evident, generatedAt excluded)", () => {
    const from = makeAgent();
    const to = makeAgent();
    settledJob(from.agentId, to.agentId, 2);
    const p = computeProofScore(to.agentId)!;
    const { contentHash, generatedAt, ...body } = p;
    void generatedAt;
    expect(createHash("sha256").update(canonical(body), "utf8").digest("hex")).toBe(contentHash);
  });

  it("more proven settled work raises the score (real settlements, not self-assigned)", () => {
    const from = makeAgent();
    const light = makeAgent();
    const heavy = makeAgent();
    settledJob(from.agentId, light.agentId, 0.1);
    for (let i = 0; i < 8; i++) settledJob(from.agentId, heavy.agentId, 5);
    const lp = computeProofScore(light.agentId)!;
    const hp = computeProofScore(heavy.agentId)!;
    expect(hp.score).toBeGreaterThan(lp.score);
    expect(hp.components.provenWork.factor).toBeGreaterThan(lp.components.provenWork.factor);
  });

  it("free (unsettled) completed tasks do NOT count toward proven-work or evidence", () => {
    const from = makeAgent();
    const to = makeAgent();
    for (let i = 0; i < 10; i++) freeJob(from.agentId, to.agentId); // lots of free work — cannot inflate the score
    const p = computeProofScore(to.agentId)!;
    expect(p.evidenceCount).toBe(0); // no settled work backs it
    expect(p.inputs.settledUsdc).toBe(0);
    expect(p.components.provenWork.factor).toBe(0);
    // quality still reflects the completed work (reputation counts free tasks)
    expect(p.inputs.tasksCompleted).toBe(10);
    expect(p.components.quality.factor).toBeGreaterThan(0);
  });

  it("verifyProofScore re-walks the receipts, confirms settlement, and recomputes the score", () => {
    const from = makeAgent();
    const to = makeAgent();
    for (let i = 0; i < 3; i++) settledJob(from.agentId, to.agentId, 1);
    const p = computeProofScore(to.agentId)!;
    const v = verifyProofScore(to.agentId)!;
    expect(v.verified).toBe(true);
    expect(v.receiptsChecked).toBe(3);
    expect(v.receiptsSettled).toBe(3);
    expect(v.recomputedScore).toBe(p.score);
    expect(v.scoreMatches).toBe(true);
    expect(v.contentHash).toBe(p.contentHash);
  });

  it("counts cross-network settlements in the score, evidence, and verification", () => {
    const from = makeAgent();
    const to = makeAgent();
    settledJob(from.agentId, to.agentId, 1); // one native Axon settlement
    recordCrossNetworkSettlement({
      agentId: to.agentId, network: "agenc", externalRef: "sig-abc-123", usdc: 5,
      receiptUrl: "https://agenc.ag/receipt/sig-abc-123", settledAt: new Date().toISOString(),
    });
    const p = computeProofScore(to.agentId)!;
    expect(p.evidenceCount).toBe(2); // native + cross-network
    const cross = p.evidence.find((e) => e.network === "agenc");
    expect(cross).toBeTruthy();
    expect(cross!.receipt).toContain("agenc.ag");
    expect(cross!.verify).toBeNull(); // verify externally on the other network

    const v = verifyProofScore(to.agentId)!;
    expect(v.receiptsChecked).toBe(1); // native only re-fetched via Axon receipts
    expect(v.receiptsSettled).toBe(1);
    expect(v.crossNetworkSettlements).toBe(1);
    expect(v.verified).toBe(true);
    expect(v.recomputedScore).toBe(p.score);
  });

  it("is idempotent on cross-network settlements (no double-counting)", () => {
    const from = makeAgent();
    const to = makeAgent();
    settledJob(from.agentId, to.agentId, 1);
    const s = { agentId: to.agentId, network: "agenc", externalRef: "dup-ref", usdc: 3, receiptUrl: "https://agenc.ag/receipt/dup-ref", settledAt: new Date().toISOString() };
    recordCrossNetworkSettlement(s);
    recordCrossNetworkSettlement(s); // same (network, externalRef) — must not double-count
    expect(computeProofScore(to.agentId)!.evidenceCount).toBe(2);
  });

  it("published formula uses evidenceCount (settled), not total tasksCompleted", () => {
    const from = makeAgent();
    const to = makeAgent();
    settledJob(from.agentId, to.agentId, 2);
    for (let i = 0; i < 6; i++) freeJob(from.agentId, to.agentId); // free work inflates tasksCompleted, not settled
    const p = computeProofScore(to.agentId)!;
    expect(p.inputs.tasksCompleted).toBeGreaterThan(p.evidenceCount); // total completed > settled

    const curve = (v: number, anchor: number) => Math.min(1, Math.log10(1 + Math.max(0, v)) / Math.log10(1 + anchor));
    const round3 = (n: number) => Math.round(n * 1000) / 1000;
    const fromEvidence = round3(Math.min(1, 0.6 * curve(p.evidenceCount, p.method.anchors.tasks) + 0.4 * curve(p.inputs.settledUsdc, p.method.anchors.usdc)));
    const fromCompleted = round3(Math.min(1, 0.6 * curve(p.inputs.tasksCompleted, p.method.anchors.tasks) + 0.4 * curve(p.inputs.settledUsdc, p.method.anchors.usdc)));
    expect(fromEvidence).toBe(p.components.provenWork.factor); // formula with evidenceCount reproduces the score
    expect(fromCompleted).not.toBe(p.components.provenWork.factor); // using tasksCompleted would be wrong
  });

  it("caches score + tier on the agent row (updateAgentProofScore) and rowToAgent reads it back", () => {
    const from = makeAgent();
    const to = makeAgent();
    settledJob(from.agentId, to.agentId, 3);
    const p = computeProofScore(to.agentId)!;
    expect(updateAgentProofScore(to.agentId)).toBe(p.score);
    const row = getDb().prepare("SELECT proof_score, proof_score_tier FROM agents WHERE agent_id = ?").get(to.agentId) as { proof_score: number; proof_score_tier: string };
    expect(row.proof_score).toBe(p.score);
    expect(row.proof_score_tier).toBe(p.tier);
    expect(getAgentById(to.agentId)!.proofScore).toBe(p.score); // list views read this cached value
  });

  it("recomputeAllProofScores backfills every agent's cached column", () => {
    const from = makeAgent();
    const to = makeAgent();
    settledJob(from.agentId, to.agentId, 2);
    expect(recomputeAllProofScores()).toBeGreaterThan(0);
    expect(getAgentById(to.agentId)!.proofScore).toBe(computeProofScore(to.agentId)!.score);
  });

  it("never leaks task content", () => {
    const from = makeAgent();
    const to = makeAgent();
    settledJob(from.agentId, to.agentId, 1, "SECRET deliverable text");
    const flat = JSON.stringify(computeProofScore(to.agentId));
    expect(flat).not.toContain("SECRET");
    expect(flat).not.toContain("CONFIDENTIAL");
  });
});
