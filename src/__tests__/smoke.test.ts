// Smoke tests — exercise the full handler stack end-to-end using real route
// handlers (no HTTP server required). Verify critical paths boot and respond
// correctly on a cold-start DB.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET as healthGET } from "@/app/api/health/route";
import { GET as readyGET } from "@/app/api/ready/route";
import { GET as metricsGET } from "@/app/api/metrics/route";
import { POST as createTaskPOST } from "@/app/api/tasks/route";
import { POST as startPOST } from "@/app/api/tasks/[taskId]/start/route";
import { POST as completePOST } from "@/app/api/tasks/[taskId]/complete/route";
import { GET as receiptGET } from "@/app/api/receipts/[taskId]/route";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import type { Agent } from "@/sdk/types";

const WALLET = "11111111111111111111111111111111";

function uid() {
  return `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeAgent(): Agent {
  const id = uid();
  return {
    agentId: id,
    name: `Smoke Agent ${id}`,
    capabilities: ["research"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
}

function jsonReq(url: string, method: string, body?: unknown, headers?: Record<string, string>) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// ── Health ────────────────────────────────────────────────────────────────────

describe("GET /api/health smoke", () => {
  function makeHealthReq(secret?: string) {
    const headers: Record<string, string> = {};
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    return new NextRequest("http://localhost/api/health", { headers });
  }

  it("returns minimal public response without auth", async () => {
    const res = await healthGET(makeHealthReq());
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; status: string; timestamp: string };
    expect(typeof body.ok).toBe("boolean");
    expect(body.status).toBeDefined();
    expect(body.timestamp).toBeDefined();
    // Full details must NOT be present in public response
    expect((body as Record<string, unknown>).checks).toBeUndefined();
  });

  it("returns full report with valid CRON_SECRET", async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-secret";
    try {
      const res = await healthGET(makeHealthReq("test-secret"));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; checks: { name: string }[] };
      expect(body.ok).toBe(true);
      const names = body.checks.map((c) => c.name);
      expect(names).toContain("database");
      expect(names).toContain("memory");
      expect(names).toContain("worker");
      expect(names).toContain("helius_circuit");
    } finally {
      process.env.CRON_SECRET = original;
    }
  });

  it("sets Cache-Control: no-store", async () => {
    const res = await healthGET(makeHealthReq());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// ── Readiness ─────────────────────────────────────────────────────────────────

describe("GET /api/ready smoke", () => {
  it("returns 200 when database and migrations are healthy", async () => {
    const res = await readyGET();
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; checks: { name: string; status: string }[] };
    expect(body.ok).toBe(true);
    const db = body.checks.find((c) => c.name === "database")!;
    expect(db.status).toBe("ok");
    const mig = body.checks.find((c) => c.name === "migrations")!;
    expect(mig.status).toBe("ok");
  });
});

// ── Prometheus metrics ────────────────────────────────────────────────────────

describe("GET /api/metrics smoke", () => {
  it("returns 200 with Prometheus content-type", async () => {
    const res = await metricsGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/plain/);
  });

  it("body contains all expected metric families", async () => {
    const res = await metricsGET();
    const text = await res.text();
    expect(text).toMatch(/axon_tasks_total/);
    expect(text).toMatch(/axon_agents_registered/);
    expect(text).toMatch(/axon_webhooks_total/);
    expect(text).toMatch(/axon_webhook_deliveries_total/);
    expect(text).toMatch(/axon_helius_circuit_state/);
    expect(text).toMatch(/axon_gateway_circuit_state/);
    expect(text).toMatch(/axon_mpp_channels_open/);
    expect(text).toMatch(/axon_uptime_seconds/);
  });

  it("every metric family has matching HELP and TYPE lines", async () => {
    const res = await metricsGET();
    const text = await res.text();
    const helpCount = (text.match(/^# HELP /gm) ?? []).length;
    const typeCount = (text.match(/^# TYPE /gm) ?? []).length;
    expect(helpCount).toBeGreaterThan(0);
    expect(helpCount).toBe(typeCount);
  });

  it("sets Cache-Control: no-store", async () => {
    const res = await metricsGET();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

// ── Full task round-trip ──────────────────────────────────────────────────────

describe("task round-trip smoke test", () => {
  it("creates → starts → completes a task and retrieves a valid receipt", async () => {
    const agent = makeAgent();
    createAgent(agent);
    const { apiKey } = createApiKey(WALLET);
    const auth = { Authorization: `Bearer ${apiKey}` };

    // 1. Create
    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", {
        from: "anonymous",
        to: agent.agentId,
        task: "smoke test task",
      })
    );
    expect(createRes.status).toBe(201);
    const { taskId } = await createRes.json() as { taskId: string };
    expect(typeof taskId).toBe("string");

    // 2. Start
    const startRes = await startPOST(
      jsonReq(`http://localhost/api/tasks/${taskId}/start`, "POST", {}, auth),
      { params: Promise.resolve({ taskId }) }
    );
    expect(startRes.status).toBe(200);
    const started = await startRes.json() as { status: string };
    expect(started.status).toBe("running");

    // 3. Complete
    const completeRes = await completePOST(
      jsonReq(`http://localhost/api/tasks/${taskId}/complete`, "POST",
        { output: "smoke result" }, auth),
      { params: Promise.resolve({ taskId }) }
    );
    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json() as { status: string; output: string };
    expect(completed.status).toBe("completed");
    expect(completed.output).toBe("smoke result");

    // 4. Receipt
    await Promise.resolve(); // flush outputCommitment microtask
    const receiptRes = await receiptGET(
      jsonReq(`http://localhost/api/receipts/${taskId}`, "GET", undefined, auth),
      { params: Promise.resolve({ taskId }) }
    );
    expect(receiptRes.status).toBe(200);
    const { receipt } = await receiptRes.json() as {
      receipt: { task: { status: string; output: string }; progress: unknown[] }
    };
    expect(receipt.task.status).toBe("completed");
    expect(receipt.task.output).toBe("smoke result");
    expect(Array.isArray(receipt.progress)).toBe(true);
  });
});
