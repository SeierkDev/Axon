// E2E tests for core API routes — handlers invoked directly (no HTTP server needed).
// Each test file gets an isolated in-memory DB (vitest isolate: true).

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST as createTaskPOST } from "@/app/api/tasks/route";
import { POST as completePOST } from "@/app/api/tasks/[taskId]/complete/route";
import { POST as startPOST } from "@/app/api/tasks/[taskId]/start/route";
import { POST as failPOST } from "@/app/api/tasks/[taskId]/fail/route";
import { GET as receiptGET } from "@/app/api/receipts/[taskId]/route";
import { POST as agentPOST } from "@/app/api/agents/route";
import { GET as agentByIdGET } from "@/app/api/agents/[agentId]/route";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { startTask, createTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

// Two known valid Solana base58 addresses used as test wallet identities
const WALLET_A = "11111111111111111111111111111111"; // System Program
const WALLET_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // SPL Token Program

let seq = 0;
function uid() { return `e2e-${++seq}`; }

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const id = uid();
  return {
    agentId: id,
    name: `E2E Agent ${id}`,
    capabilities: ["research"],
    publicKey: `pk-${id}`,
    walletAddress: WALLET_A,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function jsonReq(url: string, method: string, body?: unknown, headers?: Record<string, string>) {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function getReq(url: string, headers?: Record<string, string>) {
  return new NextRequest(url, { method: "GET", headers: headers ?? {} });
}

function bearer(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

// ── Idempotency replay ────────────────────────────────────────────────────────

describe("POST /api/tasks: idempotency", () => {
  // afterEach is needed because these tests write to a shared in-memory DB
  // via the same module context. The uid() counter keeps agent IDs unique.

  it("replays the same task on duplicate idempotency key and returns 200", async () => {
    const a = makeAgent();
    createAgent(a);
    const key = `idempotency-test-${uid()}`;

    const body = { from: "anonymous", to: a.agentId, task: "Idempotent work" };

    const first = await createTaskPOST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      })
    );
    expect(first.status).toBe(201);
    const firstTask = await first.json() as { taskId: string };

    const second = await createTaskPOST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(body),
      })
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    const secondTask = await second.json() as { taskId: string };
    expect(secondTask.taskId).toBe(firstTask.taskId);
  });

  it("returns 409 CONFLICT when idempotency key reused with different payload", async () => {
    const a = makeAgent();
    createAgent(a);
    const key = `idempotency-conflict-${uid()}`;

    await createTaskPOST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ from: "anonymous", to: a.agentId, task: "Original task" }),
      })
    );

    const res = await createTaskPOST(
      new NextRequest("http://localhost/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ from: "anonymous", to: a.agentId, task: "DIFFERENT task" }),
      })
    );
    expect(res.status).toBe(409);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("CONFLICT");
  });
});

// ── POST /api/tasks ───────────────────────────────────────────────────────────

describe("POST /api/tasks: request validation", () => {
  it("returns 400 INVALID_JSON on non-JSON body", async () => {
    const req = new NextRequest("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json}",
    });
    const res = await createTaskPOST(req);
    expect(res.status).toBe(400);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("INVALID_JSON");
  });

  it("returns 400 VALIDATION_ERROR when required fields are missing", async () => {
    const res = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous" })
    );
    expect(res.status).toBe(400);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 NOT_FOUND when target agent does not exist", async () => {
    const res = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", {
        from: "anonymous",
        to: "nonexistent-agent",
        task: "Hello",
      })
    );
    expect(res.status).toBe(404);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("NOT_FOUND");
  });

  it("returns 401 AUTH_REQUIRED when attributed (non-anonymous) request has no API key", async () => {
    const a = makeAgent();
    createAgent(a);

    const res = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", {
        from: a.agentId, // attributed sender — requires auth
        to: a.agentId,
        task: "Summarise",
      })
    );
    expect(res.status).toBe(401);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("AUTH_REQUIRED");
  });
});

describe("POST /api/tasks: happy path", () => {
  it("creates an anonymous free task and returns 201 with task shape", async () => {
    const a = makeAgent();
    createAgent(a);

    const res = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", {
        from: "anonymous",
        to: a.agentId,
        task: "Summarise this document",
      })
    );
    expect(res.status).toBe(201);
    const task = await res.json() as { taskId: string; status: string; toAgent: string; fromAgent: string };
    expect(task.taskId).toBeDefined();
    expect(task.status).toBe("queued");
    expect(task.toAgent).toBe(a.agentId);
    expect(task.fromAgent).toBe("anonymous");
    // Rate-limit headers should be present
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
  });
});

// ── POST /api/tasks/:taskId/complete ─────────────────────────────────────────

describe("POST /api/tasks/:taskId/complete: auth and state checks", () => {
  it("returns 404 NOT_FOUND for unknown task", async () => {
    const { apiKey } = createApiKey(WALLET_A);
    const res = await completePOST(
      jsonReq("http://localhost/api/tasks/nope/complete", "POST", { output: "done" }, bearer(apiKey)),
      { params: Promise.resolve({ taskId: "nope" }) }
    );
    expect(res.status).toBe(404);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("NOT_FOUND");
  });

  it("returns 401 AUTH_REQUIRED when no API key is provided", async () => {
    const a = makeAgent();
    createAgent(a);

    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous", to: a.agentId, task: "x" })
    );
    const { taskId } = await createRes.json() as { taskId: string };

    const res = await completePOST(
      jsonReq(`http://localhost/api/tasks/${taskId}/complete`, "POST", { output: "result" }),
      { params: Promise.resolve({ taskId }) }
    );
    expect(res.status).toBe(401);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("AUTH_REQUIRED");
  });

  it("returns 403 FORBIDDEN when API key belongs to a different wallet", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey: keyB } = createApiKey(WALLET_B);

    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous", to: a.agentId, task: "x" })
    );
    const { taskId } = await createRes.json() as { taskId: string };

    const res = await completePOST(
      jsonReq(`http://localhost/api/tasks/${taskId}/complete`, "POST", { output: "result" }, bearer(keyB)),
      { params: Promise.resolve({ taskId }) }
    );
    expect(res.status).toBe(403);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("FORBIDDEN");
  });

  it("returns 409 TASK_STATE_CONFLICT when task is not running", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey } = createApiKey(WALLET_A);

    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous", to: a.agentId, task: "x" })
    );
    const { taskId } = await createRes.json() as { taskId: string };
    // Task is still queued — completing it should be refused

    const res = await completePOST(
      jsonReq(`http://localhost/api/tasks/${taskId}/complete`, "POST", { output: "result" }, bearer(apiKey)),
      { params: Promise.resolve({ taskId }) }
    );
    expect(res.status).toBe(409);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("TASK_STATE_CONFLICT");
  });

  it("returns 400 VALIDATION_ERROR when output field is missing", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey } = createApiKey(WALLET_A);

    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous", to: a.agentId, task: "x" })
    );
    const { taskId } = await createRes.json() as { taskId: string };
    startTask(taskId);

    const res = await completePOST(
      jsonReq(`http://localhost/api/tasks/${taskId}/complete`, "POST", {}, bearer(apiKey)),
      { params: Promise.resolve({ taskId }) }
    );
    expect(res.status).toBe(400);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/tasks/:taskId/complete: happy path", () => {
  it("completes a running task and returns 200 with completed task", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey } = createApiKey(WALLET_A);

    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous", to: a.agentId, task: "Analyse" })
    );
    const { taskId } = await createRes.json() as { taskId: string };
    startTask(taskId);

    const res = await completePOST(
      jsonReq(
        `http://localhost/api/tasks/${taskId}/complete`,
        "POST",
        { output: "The final answer is 42" },
        bearer(apiKey)
      ),
      { params: Promise.resolve({ taskId }) }
    );
    expect(res.status).toBe(200);
    const task = await res.json() as { status: string; output: string; completedAt: string };
    expect(task.status).toBe("completed");
    expect(task.output).toBe("The final answer is 42");
    expect(task.completedAt).toBeDefined();
  });
});

// ── GET /api/receipts/:taskId ─────────────────────────────────────────────────

describe("GET /api/receipts/:taskId: auth and not-found checks", () => {
  it("returns 404 NOT_FOUND for unknown task", async () => {
    const { apiKey } = createApiKey(WALLET_A);
    const res = await receiptGET(
      getReq("http://localhost/api/receipts/nope", bearer(apiKey)),
      { params: Promise.resolve({ taskId: "nope" }) }
    );
    expect(res.status).toBe(404);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("NOT_FOUND");
  });

  it("returns 401 AUTH_REQUIRED when no API key is provided", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);

    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous", to: a.agentId, task: "x" })
    );
    const { taskId } = await createRes.json() as { taskId: string };

    const res = await receiptGET(
      getReq(`http://localhost/api/receipts/${taskId}`),
      { params: Promise.resolve({ taskId }) }
    );
    expect(res.status).toBe(401);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("AUTH_REQUIRED");
  });

  it("returns 403 FORBIDDEN when API key belongs to an unrelated wallet", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey: keyB } = createApiKey(WALLET_B);

    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous", to: a.agentId, task: "x" })
    );
    const { taskId } = await createRes.json() as { taskId: string };

    const res = await receiptGET(
      getReq(`http://localhost/api/receipts/${taskId}`, bearer(keyB)),
      { params: Promise.resolve({ taskId }) }
    );
    expect(res.status).toBe(403);
    const data = await res.json() as { code: string };
    expect(data.code).toBe("FORBIDDEN");
  });
});

describe("GET /api/receipts/:taskId: happy path", () => {
  it("returns 200 with receipt containing progress and outputCommitment fields", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey } = createApiKey(WALLET_A);

    const createRes = await createTaskPOST(
      jsonReq("http://localhost/api/tasks", "POST", { from: "anonymous", to: a.agentId, task: "Analyse" })
    );
    const { taskId } = await createRes.json() as { taskId: string };
    startTask(taskId);

    await completePOST(
      jsonReq(
        `http://localhost/api/tasks/${taskId}/complete`,
        "POST",
        { output: "Final result" },
        bearer(apiKey)
      ),
      { params: Promise.resolve({ taskId }) }
    );
    // Flush the commitOutput microtask so output_hash is written before asserting
    await Promise.resolve();

    const res = await receiptGET(
      getReq(`http://localhost/api/receipts/${taskId}`, bearer(apiKey)),
      { params: Promise.resolve({ taskId }) }
    );
    expect(res.status).toBe(200);
    const { receipt } = await res.json() as { receipt: { task: { status: string; output: string }; progress: unknown[]; outputCommitment: null } };
    expect(receipt.task?.status).toBe("completed");
    expect(receipt.task?.output).toBe("Final result");
    expect(Array.isArray(receipt.progress)).toBe(true);
    // outputCommitment is null in tests — no Solana keys configured
    expect(receipt.outputCommitment).toBeNull();
  });
});

// ── POST /api/tasks/:taskId/start ─────────────────────────────────────────────

describe("POST /api/tasks/:taskId/start", () => {
  it("returns 404 when task does not exist", async () => {
    const { apiKey } = createApiKey(WALLET_A);
    const res = await startPOST(
      jsonReq("http://localhost/api/tasks/ghost-task/start", "POST", {}, bearer(apiKey)),
      { params: Promise.resolve({ taskId: "ghost-task" }) }
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when no API key is provided", async () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "start-auth" });
    const res = await startPOST(
      jsonReq(`http://localhost/api/tasks/${task.taskId}/start`, "POST", {}),
      { params: Promise.resolve({ taskId: task.taskId }) }
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when the API key does not own the recipient agent", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    const b = makeAgent({ walletAddress: WALLET_B });
    createAgent(a);
    createAgent(b);
    const task = createTask({ fromAgent: a.agentId, toAgent: b.agentId, task: "forbidden-start" });
    // Key for WALLET_A, but task.toAgent is owned by WALLET_B
    const { apiKey } = createApiKey(WALLET_A);
    const res = await startPOST(
      jsonReq(`http://localhost/api/tasks/${task.taskId}/start`, "POST", {}, bearer(apiKey)),
      { params: Promise.resolve({ taskId: task.taskId }) }
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 when task is not in queued status", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey } = createApiKey(WALLET_A);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "double-start" });
    // First start — moves task to 'running'
    startTask(task.taskId, "api");
    const res = await startPOST(
      jsonReq(`http://localhost/api/tasks/${task.taskId}/start`, "POST", {}, bearer(apiKey)),
      { params: Promise.resolve({ taskId: task.taskId }) }
    );
    expect(res.status).toBe(409);
  });

  it("returns 200 and the updated task on a valid start", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey } = createApiKey(WALLET_A);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "start-me" });
    const res = await startPOST(
      jsonReq(`http://localhost/api/tasks/${task.taskId}/start`, "POST", {}, bearer(apiKey)),
      { params: Promise.resolve({ taskId: task.taskId }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("running");
  });
});

// ── POST /api/tasks/:taskId/fail ──────────────────────────────────────────────

describe("POST /api/tasks/:taskId/fail", () => {
  it("returns 404 when task does not exist", async () => {
    const { apiKey } = createApiKey(WALLET_A);
    const res = await failPOST(
      jsonReq("http://localhost/api/tasks/ghost-task/fail", "POST", { error: "oops" }, bearer(apiKey)),
      { params: Promise.resolve({ taskId: "ghost-task" }) }
    );
    expect(res.status).toBe(404);
  });

  it("returns 401 when no API key is provided", async () => {
    const a = makeAgent();
    createAgent(a);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "fail-auth" });
    const res = await failPOST(
      jsonReq(`http://localhost/api/tasks/${task.taskId}/fail`, "POST", { error: "no auth" }),
      { params: Promise.resolve({ taskId: task.taskId }) }
    );
    expect(res.status).toBe(401);
  });

  it("returns 409 when task is already completed", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey } = createApiKey(WALLET_A);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "already-done" });
    // Complete the task first
    startTask(task.taskId, "api");
    await completePOST(
      jsonReq(`http://localhost/api/tasks/${task.taskId}/complete`, "POST", { output: "done" }, bearer(apiKey)),
      { params: Promise.resolve({ taskId: task.taskId }) }
    );
    // Now try to fail it
    const res = await failPOST(
      jsonReq(`http://localhost/api/tasks/${task.taskId}/fail`, "POST", { error: "too late" }, bearer(apiKey)),
      { params: Promise.resolve({ taskId: task.taskId }) }
    );
    expect(res.status).toBe(409);
  });

  it("returns 200 and the failed task on a valid fail call", async () => {
    const a = makeAgent({ walletAddress: WALLET_A });
    createAgent(a);
    const { apiKey } = createApiKey(WALLET_A);
    const task = createTask({ fromAgent: a.agentId, toAgent: a.agentId, task: "fail-me" });
    startTask(task.taskId, "api");
    const res = await failPOST(
      jsonReq(`http://localhost/api/tasks/${task.taskId}/fail`, "POST", { error: "worker crash" }, bearer(apiKey)),
      { params: Promise.resolve({ taskId: task.taskId }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; error: string };
    expect(body.status).toBe("failed");
    expect(body.error).toBe("worker crash");
  });
});

// ── POST /api/agents ──────────────────────────────────────────────────────────

describe("POST /api/agents", () => {
  it("returns 401 when no API key is provided", async () => {
    const res = await agentPOST(
      jsonReq("http://localhost/api/agents", "POST", {
        agentId: uid(),
        name: "No Auth Agent",
        capabilities: ["research"],
        publicKey: "pk-no-auth",
        walletAddress: WALLET_A,
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    const { apiKey } = createApiKey(WALLET_A);
    const res = await agentPOST(
      jsonReq("http://localhost/api/agents", "POST", { name: "Missing Fields" }, bearer(apiKey))
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 when an agent with the same ID already exists", async () => {
    const { apiKey } = createApiKey(WALLET_A);
    const existingId = uid();
    const a = makeAgent({ agentId: existingId, walletAddress: WALLET_A });
    createAgent(a);
    const res = await agentPOST(
      jsonReq("http://localhost/api/agents", "POST", {
        agentId: existingId,
        name: "Duplicate Agent",
        capabilities: ["research"],
        publicKey: "pk-dup",
        walletAddress: WALLET_A,
      }, bearer(apiKey))
    );
    expect(res.status).toBe(409);
  });

  it("returns 201 and the new agent on a valid registration", async () => {
    const { apiKey } = createApiKey(WALLET_A);
    const agentId = uid();
    const res = await agentPOST(
      jsonReq("http://localhost/api/agents", "POST", {
        agentId,
        name: "Fresh Agent",
        capabilities: ["research"],
        publicKey: `pk-fresh-${agentId}`,
        walletAddress: WALLET_A,
        endpoint: "https://example.com/agent",
      }, bearer(apiKey))
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { agentId: string; name: string };
    expect(body.agentId).toBe(agentId);
    expect(body.name).toBe("Fresh Agent");
  });
});

// ── GET /api/agents/:agentId ──────────────────────────────────────────────────

describe("GET /api/agents/:agentId", () => {
  it("returns 404 when the agent does not exist", async () => {
    const res = await agentByIdGET(
      new NextRequest("http://localhost/api/agents/ghost-agent"),
      { params: Promise.resolve({ agentId: "ghost-agent" }) }
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with the agent on a valid lookup", async () => {
    const a = makeAgent();
    createAgent(a);
    const res = await agentByIdGET(
      new NextRequest(`http://localhost/api/agents/${a.agentId}`),
      { params: Promise.resolve({ agentId: a.agentId }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { agentId: string };
    expect(body.agentId).toBe(a.agentId);
  });
});

// ── POST /api/agents: X-RateLimit headers ─────────────────────────────────────

describe("POST /api/agents: rate-limit headers on 201", () => {
  it("returns X-RateLimit-Limit and X-RateLimit-Remaining on a successful registration", async () => {
    const { apiKey } = createApiKey(WALLET_A);
    const agentId = uid();
    const res = await agentPOST(
      jsonReq("http://localhost/api/agents", "POST", {
        agentId,
        name: "Rate Header Agent",
        capabilities: ["research"],
        publicKey: `pk-ratelimit-${agentId}`,
        walletAddress: WALLET_A,
        endpoint: "https://example.com/agent",
      }, bearer(apiKey))
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Reset")).toBeDefined();
  });
});
