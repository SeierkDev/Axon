import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  withRpc,
  getRpcCircuitState,
  resetRpcCircuit,
  CircuitOpenError,
  isTransientRpcError,
  describeRpcError,
  rpcUrl,
} from "@/lib/evm";
import { logger } from "@/lib/logger";

// The test functions below never use the request function they are handed, so nothing here reaches
// a node: what is under test is the breaker's own bookkeeping, not the transport.
beforeEach(() => {
  resetRpcCircuit();
});

// ── Closed state ──────────────────────────────────────────────────────────────

describe("circuit breaker: closed state", () => {
  it("starts in closed state with 0 failures", () => {
    const { state, consecutiveFailures } = getRpcCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });

  it("passes through a successful call and stays closed", async () => {
    const result = await withRpc(async () => "ok");
    expect(result).toBe("ok");
    const { state, consecutiveFailures } = getRpcCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });

  it("increments failure count below threshold without opening", async () => {
    for (let i = 0; i < 4; i++) {
      await expect(
        withRpc(async () => { throw new Error("rpc error"); })
      ).rejects.toThrow("rpc error");
    }
    const { state, consecutiveFailures } = getRpcCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(4);
  });

  it("resets failure count to 0 after a success", async () => {
    await expect(withRpc(async () => { throw new Error("fail"); })).rejects.toThrow();
    await expect(withRpc(async () => { throw new Error("fail"); })).rejects.toThrow();
    await withRpc(async () => "recovered");
    expect(getRpcCircuitState().consecutiveFailures).toBe(0);
  });
});

// ── Opening after threshold ───────────────────────────────────────────────────

describe("circuit breaker: opening after threshold", () => {
  it("opens after 5 consecutive failures", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withRpc(async () => { throw new Error("rpc error"); })
      ).rejects.toThrow("rpc error");
    }
    expect(getRpcCircuitState().state).toBe("open");
  });

  it("fails fast with CircuitOpenError when open — fn is never called", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withRpc(async () => { throw new Error("rpc error"); })
      ).rejects.toThrow();
    }

    const called = { value: false };
    await expect(
      withRpc(async () => { called.value = true; return "x"; })
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called.value).toBe(false);
  });

  it("CircuitOpenError carries a positive retryAfterMs", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withRpc(async () => { throw new Error("x"); })
      ).rejects.toThrow();
    }

    try {
      await withRpc(async () => "x");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
    }
  });
});

// ── Half-open probe and recovery ──────────────────────────────────────────────

describe("circuit breaker: half-open after recovery window", () => {
  it("transitions to half-open when recovery window elapses", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) {
        await expect(
          withRpc(async () => { throw new Error("x"); })
        ).rejects.toThrow();
      }
      expect(getRpcCircuitState().state).toBe("open");

      // Advance past the 60-second recovery window
      vi.advanceTimersByTime(61_000);

      expect(getRpcCircuitState().state).toBe("half-open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("probe success closes the circuit from half-open", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) {
        await expect(
          withRpc(async () => { throw new Error("x"); })
        ).rejects.toThrow();
      }
      vi.advanceTimersByTime(61_000);
      expect(getRpcCircuitState().state).toBe("half-open");

      const result = await withRpc(async () => "probe success");
      expect(result).toBe("probe success");
      const { state, consecutiveFailures } = getRpcCircuitState();
      expect(state).toBe("closed");
      expect(consecutiveFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("probe failure re-opens the circuit from half-open", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) {
        await expect(
          withRpc(async () => { throw new Error("x"); })
        ).rejects.toThrow();
      }
      vi.advanceTimersByTime(61_000);
      expect(getRpcCircuitState().state).toBe("half-open");

      await expect(
        withRpc(async () => { throw new Error("still failing"); })
      ).rejects.toThrow("still failing");

      expect(getRpcCircuitState().state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Retry with exponential backoff ───────────────────────────────────────────

describe("withRpc: retry on transient errors", () => {
  it("does not retry non-transient errors — exactly 1 attempt", async () => {
    let callCount = 0;
    await expect(
      withRpc(async () => { callCount++; throw new Error("unknown RPC error"); })
    ).rejects.toThrow("unknown RPC error");
    expect(callCount).toBe(1);
    expect(getRpcCircuitState().consecutiveFailures).toBe(1);
  });

  it("retries transient errors up to 3 times, success on retry clears failures", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const p = withRpc(async () => {
        callCount++;
        if (callCount < 3) throw new Error("503 Service Unavailable");
        return "recovered";
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result).toBe("recovered");
      expect(callCount).toBe(3);
      expect(getRpcCircuitState().consecutiveFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts only one circuit failure after all 3 retries exhausted", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const p = withRpc(async () => {
        callCount++;
        throw new Error("502 Bad Gateway");
      });
      void p.catch(() => {}); // prevent unhandled rejection before we await
      await vi.runAllTimersAsync();
      await expect(p).rejects.toThrow("502 Bad Gateway");
      expect(callCount).toBe(3);
      expect(getRpcCircuitState().consecutiveFailures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry in half-open state — one probe only", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) {
        const p = withRpc(async () => { throw new Error("x"); });
        void p.catch(() => {});
        await vi.runAllTimersAsync();
        await expect(p).rejects.toThrow();
      }
      vi.advanceTimersByTime(61_000);
      expect(getRpcCircuitState().state).toBe("half-open");

      let callCount = 0;
      const probeP = withRpc(async () => {
        callCount++;
        throw new Error("502 Bad Gateway"); // transient but half-open = no retry
      });
      void probeP.catch(() => {});
      await vi.runAllTimersAsync();
      await expect(probeP).rejects.toThrow("502 Bad Gateway");
      expect(callCount).toBe(1);
      expect(getRpcCircuitState().state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── isTransientRpcError ────────────────────────────────────────────────────

describe("isTransientRpcError", () => {
  it("flags ECONNRESET as transient", () => {
    expect(isTransientRpcError(new Error("read ECONNRESET"))).toBe(true);
  });
  it("flags ETIMEDOUT as transient", () => {
    expect(isTransientRpcError(new Error("connect ETIMEDOUT 1.2.3.4"))).toBe(true);
  });
  it("flags 429 / 502 / 503 / 504 as transient", () => {
    expect(isTransientRpcError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isTransientRpcError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isTransientRpcError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientRpcError(new Error("504 Gateway Timeout"))).toBe(true);
  });
  it("does not flag non-transient errors", () => {
    expect(isTransientRpcError(new Error("invalid pubkey"))).toBe(false);
    expect(isTransientRpcError(new Error("Account not found"))).toBe(false);
    expect(isTransientRpcError("string error")).toBe(false);
    expect(isTransientRpcError(null)).toBe(false);
  });
});

// ── resetRpcCircuit ────────────────────────────────────────────────────────

describe("resetRpcCircuit", () => {
  it("clears open state and failure count", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withRpc(async () => { throw new Error("x"); })
      ).rejects.toThrow();
    }
    expect(getRpcCircuitState().state).toBe("open");

    resetRpcCircuit();
    const { state, consecutiveFailures } = getRpcCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });

  it("allows successful calls again after reset from open", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withRpc(async () => { throw new Error("x"); })
      ).rejects.toThrow();
    }
    resetRpcCircuit();

    const result = await withRpc(async () => 42);
    expect(result).toBe(42);
    expect(getRpcCircuitState().state).toBe("closed");
  });
});

// ── the breaker says why it opened ────────────────────────────────────────────

describe("circuit breaker: the open log names its cause", () => {
  it("records the last method and error when it opens", async () => {
    const error = vi.spyOn(logger, "error");
    // The node answers with a JSON-RPC error; nothing leaves the process.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "query returned more than 10000 results" } })),
    );
    try {
      for (let i = 0; i < 5; i++) {
        await expect(withRpc((request) => request("eth_getLogs", []))).rejects.toThrow();
      }
      const opened = error.mock.calls.find((c) => c[0] === "rpc.circuit_opened");
      expect(opened?.[2]).toMatchObject({ method: "eth_getLogs", lastError: "query returned more than 10000 results" });
    } finally {
      error.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("keeps the node URL out of the logged error", () => {
    const line = describeRpcError(new Error(`request to ${rpcUrl()} failed`));
    expect(line).not.toContain(rpcUrl());
    expect(line).toContain("<rpc>");
  });
});

// ── errors the caller expects ─────────────────────────────────────────────────

describe("withRpc: expected errors are not the node's fault", () => {
  // Measured on the live node: a getLogs range over the result cap is REFUSED, not truncated. Each
  // refusal used to count as a failure, so a sweep that was splitting exactly as designed would
  // open the circuit on its fifth split and abandon the rest.
  it("does not count an expected error toward the circuit", async () => {
    const overLimit = (e: unknown) => e instanceof Error && /exceeds limit/.test(e.message);
    for (let i = 0; i < 10; i++) {
      await expect(
        withRpc(async () => { throw new Error("logs matched by query exceeds limit of 10000"); }, { expected: overLimit }),
      ).rejects.toThrow(/exceeds limit/);
    }
    const { state, consecutiveFailures } = getRpcCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });

  it("still counts an error the caller did not expect", async () => {
    const overLimit = (e: unknown) => e instanceof Error && /exceeds limit/.test(e.message);
    for (let i = 0; i < 5; i++) {
      await expect(
        withRpc(async () => { throw new Error("node exploded"); }, { expected: overLimit }),
      ).rejects.toThrow("node exploded");
    }
    expect(getRpcCircuitState().state).toBe("open");
  });

  it("hands the expected error back without retrying it", async () => {
    let calls = 0;
    await expect(
      withRpc(async () => { calls++; throw new Error("ECONNRESET, exceeds limit of 10000"); },
        { expected: (e) => e instanceof Error && /exceeds limit/.test(e.message) }),
    ).rejects.toThrow(/exceeds limit/);
    expect(calls).toBe(1); // transient-looking, but the caller claimed it
  });
});
