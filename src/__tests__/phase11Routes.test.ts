// HTTP-level tests for the Phase 11 route handlers — focused on the auth
// boundaries (worker-only subcontract, owner-only optimize/plan) that the
// lib-level unit tests don't exercise.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createApiKey } from "@/lib/identity";
import { createAgent, getAgentById } from "@/lib/agents";
import { createTask, getTaskById } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

import { POST as subcontractPOST } from "@/app/api/tasks/[taskId]/subcontract/route";
import { GET as optimizeGET, POST as optimizePOST } from "@/app/api/agents/[agentId]/optimize/route";
import { POST as planPOST } from "@/app/api/tasks/plan/route";

const WALLET_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
let n = 0;

function mk(wallet: string, opts: { cap?: string; price?: string; reputation?: number } = {}): Agent {
  n++;
  const a: Agent = {
    agentId: `p11r-${n}`,
    name: `P11R ${n}`,
    capabilities: [opts.cap ?? `p11rcap-${n}`],
    publicKey: `pk-${n}`,
    walletAddress: wallet,
    provider: "anthropic",
    reputation: opts.reputation ?? 0,
    price: opts.price,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

function req(url: string, method: string, apiKey?: string, body?: unknown): NextRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return new NextRequest(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
}

describe("Phase 11 routes — subcontract auth + flow", () => {
  it("401 without a key, 403 for a non-worker, 201 for the assigned worker", async () => {
    const worker = mk(WALLET_A);
    const subCap = `sc-cap-${n}`;
    const sub = mk(WALLET_A, { cap: subCap }); // free-lane sub-agent
    const parent = createTask({ fromAgent: "buyer", toAgent: worker.agentId, task: "big job", initialStatus: "queued", queueQueuedWebhook: false });
    const params = Promise.resolve({ taskId: parent.taskId });
    const url = `http://localhost/api/tasks/${parent.taskId}/subcontract`;

    // no key → 401
    const noAuth = await subcontractPOST(req(url, "POST", undefined, { capability: subCap, task: "part" }), { params });
    expect(noAuth.status).toBe(401);

    // a key that doesn't own the worker → 403
    const { apiKey: keyB } = createApiKey(WALLET_B);
    const forbidden = await subcontractPOST(req(url, "POST", keyB, { capability: subCap, task: "part" }), { params });
    expect(forbidden.status).toBe(403);

    // the assigned worker → 201, child task routed to the sub-agent
    const { apiKey: keyA } = createApiKey(WALLET_A);
    const ok = await subcontractPOST(req(url, "POST", keyA, { capability: subCap, task: "part" }), { params });
    expect(ok.status).toBe(201);
    const bodyJson = await ok.json();
    expect(bodyJson.subcontract.toAgent).toBe(sub.agentId);
    expect(getTaskById(bodyJson.task.taskId)?.toAgent).toBe(sub.agentId);
  });

  it("409 when the parent task is already settled", async () => {
    const worker = mk(WALLET_A);
    const sub = mk(WALLET_A, { cap: `sc2-${n}` });
    const parent = createTask({ fromAgent: "buyer", toAgent: worker.agentId, task: "job", initialStatus: "queued", queueQueuedWebhook: false });
    getDb().prepare("UPDATE tasks SET status='completed' WHERE task_id=?").run(parent.taskId);
    const { apiKey } = createApiKey(WALLET_A);
    const res = await subcontractPOST(
      req(`http://localhost/api/tasks/${parent.taskId}/subcontract`, "POST", apiKey, { to: sub.agentId, task: "x" }),
      { params: Promise.resolve({ taskId: parent.taskId }) },
    );
    expect(res.status).toBe(409);
  });
});

describe("Phase 11 routes — optimize (owner only)", () => {
  it("403 for a non-owner, 200 recommendation for the owner, apply commits", async () => {
    const agent = mk(WALLET_A, { price: "0.10 USDC" });
    // seed 10 completed recipient tasks → proven + in demand → raise
    const db = getDb();
    for (let i = 0; i < 10; i++) {
      const t = createTask({ fromAgent: "buyer", toAgent: agent.agentId, task: "t", initialStatus: "queued", queueQueuedWebhook: false });
      db.prepare("UPDATE tasks SET status='completed', completed_at=? WHERE task_id=?").run(new Date().toISOString(), t.taskId);
    }
    const params = Promise.resolve({ agentId: agent.agentId });

    const { apiKey: keyB } = createApiKey(WALLET_B);
    const forbidden = await optimizeGET(req(`http://localhost/x`, "GET", keyB), { params });
    expect(forbidden.status).toBe(403);

    const { apiKey: keyA } = createApiKey(WALLET_A);
    const rec = await optimizeGET(req(`http://localhost/x`, "GET", keyA), { params });
    expect(rec.status).toBe(200);
    expect((await rec.json()).optimization.action).toBe("raise");

    const applied = await optimizePOST(req(`http://localhost/x`, "POST", keyA, { apply: true }), { params });
    expect((await applied.json()).applied).toBe(true);
    expect(getAgentById(agent.agentId)?.price).toBe("0.12 USDC");
  });
});

describe("Phase 11 routes — plan (owner only)", () => {
  it("401 without a key, 403 for a non-owner (before any model call)", async () => {
    const planner = mk(WALLET_A);
    const url = "http://localhost/api/tasks/plan";
    const body = { from: planner.agentId, goal: "do a thing", budgetUsdc: 1 };

    const noAuth = await planPOST(req(url, "POST", undefined, body));
    expect(noAuth.status).toBe(401);

    const { apiKey: keyB } = createApiKey(WALLET_B);
    const forbidden = await planPOST(req(url, "POST", keyB, body));
    expect(forbidden.status).toBe(403);
  });
});
