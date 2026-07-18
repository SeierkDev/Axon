// The free hire flow (close the loop): an anonymous hire gets a claimToken back,
// and that token — and only that token — reads the task's private output.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/tasks/route";
import { GET } from "@/app/api/tasks/[taskId]/route";
import { createAgent } from "@/lib/agents";
import { startTask, completeTask } from "@/lib/tasks";
import type { Agent } from "@/sdk/types";

const TEST_WALLET = "11111111111111111111111111111111";

function freeAgent(): Agent {
  const a: Agent = {
    agentId: `hire-${randomUUID().slice(0, 8)}`,
    name: "Hireable",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: TEST_WALLET,
    provider: "anthropic",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

async function postHire(to: string, task: string) {
  const req = new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: "anonymous", to, task }),
  });
  const res = await POST(req);
  return { res, body: (await res.json()) as { taskId?: string; claimToken?: string; error?: string } };
}

async function getResult(taskId: string, claimToken?: string, via: "header" | "query" = "header") {
  const url =
    claimToken && via === "query"
      ? `http://localhost/api/tasks/${taskId}?claimToken=${encodeURIComponent(claimToken)}`
      : `http://localhost/api/tasks/${taskId}`;
  const headers = claimToken && via === "header" ? { "x-claim-token": claimToken } : undefined;
  const res = await GET(new NextRequest(url, headers ? { headers } : undefined), { params: Promise.resolve({ taskId }) });
  return { res, body: (await res.json()) as { status?: string; output?: string | null } };
}

describe("free hire flow — claimToken", () => {
  it("an anonymous hire returns a claimToken that reads the private output", async () => {
    const a = freeAgent();
    const { res, body } = await postHire(a.agentId, "summarize the state of agent protocols");
    expect(res.status).toBe(201);
    expect(body.taskId).toBeTruthy();
    expect(body.claimToken).toBeTruthy();

    // the worker runs + completes it
    startTask(body.taskId!);
    completeTask(body.taskId!, "the finished answer");

    // read via the header (the browser's path)
    const ok = await getResult(body.taskId!, body.claimToken, "header");
    expect(ok.res.status).toBe(200);
    expect(ok.body.status).toBe("completed");
    expect(ok.body.output).toBe("the finished answer");

    // the legacy query form still works (back-compat)
    const okQuery = await getResult(body.taskId!, body.claimToken, "query");
    expect(okQuery.res.status).toBe(200);
    expect(okQuery.body.output).toBe("the finished answer");
  });

  it("rejects a wrong claim token, and requires auth when none is given", async () => {
    const a = freeAgent();
    const { body } = await postHire(a.agentId, "a task");
    expect(body.taskId).toBeTruthy();

    const bad = await getResult(body.taskId!, "not-the-real-token");
    expect(bad.res.status).toBe(403);

    // no claimToken + no API key → auth required (never leaks the output)
    const none = await getResult(body.taskId!);
    expect([401, 403]).toContain(none.res.status);
  });
});
