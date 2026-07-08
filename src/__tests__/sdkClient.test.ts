import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AxonClient, AxonApiError } from "../../packages/sdk/src/client";
import type { RegisterOptions, SendTaskOptions } from "@/sdk/types";

// Robustness layer: per-request timeout + automatic retry with backoff for
// transient failures, but only for idempotent requests.

function resp(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("AxonClient retry / robustness", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: AxonClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new AxonClient();
    client.init({ endpoint: "https://x", retryBaseMs: 0, maxRetries: 2 }); // 0 backoff → fast tests
  });
  afterEach(() => vi.restoreAllMocks());

  it("retries a GET on 5xx, then succeeds", async () => {
    fetchMock.mockResolvedValueOnce(resp(503)).mockResolvedValueOnce(resp(503)).mockResolvedValueOnce(resp(200, { agentId: "a" }));
    const a = await client.getAgent("a");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((a as { agentId: string }).agentId).toBe("a");
  });

  it("gives up after maxRetries and throws AxonApiError", async () => {
    fetchMock.mockResolvedValue(resp(503, { error: "down" }));
    await expect(client.getAgent("a")).rejects.toBeInstanceOf(AxonApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does NOT retry a POST without an Idempotency-Key", async () => {
    fetchMock.mockResolvedValue(resp(503, { error: "down" }));
    await expect(client.register({ name: "x", capabilities: [] } as unknown as RegisterOptions)).rejects.toBeInstanceOf(AxonApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // side-effecting POST is not replayed
  });

  it("DOES retry a POST that carries an Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(resp(503)).mockResolvedValueOnce(resp(200, { taskId: "t" }));
    await client.sendTask({ idempotencyKey: "k1" } as unknown as SendTaskOptions);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a NETWORK-coded error after retrying a persistent connection failure", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(client.getAgent("a")).rejects.toMatchObject({ code: "NETWORK", status: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces a TIMEOUT-coded error when the request aborts on timeout", async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    await expect(client.getAgent("a")).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
