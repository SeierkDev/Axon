// The allowance methods and hire()'s allowance lane, against a stubbed network.
//
// These pin what the SDK sends. Whether the server agrees is the live test's job
// (test/live.integration.test.ts, via scripts/sdk-e2e.mjs), which runs a real allowance on a real chain.

import { describe, it, expect, vi, afterEach } from "vitest";
import { AxonClient } from "../src/client";
import { hire } from "../src/hire";
import type { TaskRequest } from "../src/types";

interface Call { method: string; path: string; body: unknown; headers: Record<string, string> }

function stub(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    calls.push({
      method,
      path,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    const body = responses[`${method} ${path}`] ?? { error: "unexpected", code: "NOT_FOUND" };
    return new Response(JSON.stringify(body), { status: responses[`${method} ${path}`] ? 200 : 404 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const client = () => new AxonClient({ endpoint: "https://axon.test", apiKey: "axon_test" });

describe("allowance methods", () => {
  it("getAllowance reads /api/allowance with the key", async () => {
    const calls = stub({ "GET /api/allowance": { enabled: true, wallet: "0xabc", accounts: [] } });
    const status = await client().getAllowance();
    expect(status).toEqual({ enabled: true, wallet: "0xabc", accounts: [] });
    expect(calls[0].headers.authorization ?? calls[0].headers["x-api-key"]).toBeTruthy();
  });

  it("createAllowanceKey sends the limits as given", async () => {
    const calls = stub({ "POST /api/allowance/keys": { keyId: "k1", apiKey: "axon_x" } });
    await client().createAllowanceKey({ label: "Claude", maxPerTask: "0.0002", maxPerDay: "0.001", allowedAgents: ["a"], expiresInDays: 7 });
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/allowance/keys",
      body: { label: "Claude", maxPerTask: "0.0002", maxPerDay: "0.001", allowedAgents: ["a"], expiresInDays: 7 },
    });
  });

  it("listAllowanceKeys unwraps the list, revokeAllowanceKey deletes by id", async () => {
    const calls = stub({
      "GET /api/allowance/keys": { keys: [{ keyId: "k1" }] },
      "DELETE /api/allowance/keys/k%201": { ok: true },
    });
    expect(await client().listAllowanceKeys()).toEqual([{ keyId: "k1" }]);
    await client().revokeAllowanceKey("k 1");
    expect(calls[1]).toMatchObject({ method: "DELETE", path: "/api/allowance/keys/k%201" });
  });
});

describe("hire() with paymentMethod allowance", () => {
  function mockClient(created: Partial<TaskRequest> = {}) {
    const task: TaskRequest = {
      taskId: "t1", fromAgent: "0xabc", toAgent: "a", task: "x", status: "completed", output: "done",
      createdAt: new Date().toISOString(), ...created,
    } as TaskRequest;
    return {
      getAllowance: vi.fn(async () => ({ enabled: true, wallet: "0xabc", accounts: [] })),
      sendTask: vi.fn(async () => task),
      getTask: vi.fn(async () => task),
      getReceipt: vi.fn(async () => ({ receipt: {} })),
      getX402Requirements: vi.fn(),
    };
  }

  it("hires as the key's wallet, needs no pay function, and never probes x402", async () => {
    const c = mockClient();
    const result = await hire(c as never, { to: "a", task: "x", paymentMethod: "allowance", withReceipt: false });
    expect(c.sendTask).toHaveBeenCalledWith({ from: "0xabc", to: "a", task: "x", context: undefined, paymentMethod: "allowance" });
    expect(c.getX402Requirements).not.toHaveBeenCalled();
    expect(result).toMatchObject({ paid: true, status: "completed", output: "done" });
  });

  it("payWith axon asks the server for an $AXON quote for this hire", async () => {
    const c = mockClient();
    await hire(c as never, { to: "a", task: "x", paymentMethod: "allowance", payWith: "axon", withReceipt: false });
    expect(c.sendTask).toHaveBeenCalledWith(expect.objectContaining({ payIn: "AXON" }));
  });

  it("uses an explicit from without asking for the allowance", async () => {
    const c = mockClient();
    await hire(c as never, { to: "a", task: "x", from: "my-agent", paymentMethod: "allowance", withReceipt: false });
    expect(c.getAllowance).not.toHaveBeenCalled();
    expect(c.sendTask).toHaveBeenCalledWith(expect.objectContaining({ from: "my-agent" }));
  });

  it("says so when the network has no allowances", async () => {
    const c = mockClient();
    c.getAllowance.mockResolvedValueOnce({ enabled: false } as never);
    await expect(hire(c as never, { to: "a", task: "x", paymentMethod: "allowance" })).rejects.toThrow(/not available/);
  });
});
