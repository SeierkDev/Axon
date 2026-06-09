import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  withHelius,
  getHeliusCircuitState,
  resetHeliusCircuit,
  CircuitOpenError,
  isTransientHeliusError,
} from "@/lib/solana";

// getConnection() calls getHeliusUrl() which throws if HELIUS_API_KEY is absent.
// A fake key lets Connection be constructed without making real network calls —
// the actual RPC only fires when fn() uses the connection, which our test fns don't.
beforeEach(() => {
  resetHeliusCircuit();
  process.env.HELIUS_API_KEY = "test-key-for-circuit-breaker-tests";
});

// ── Closed state ──────────────────────────────────────────────────────────────

describe("circuit breaker: closed state", () => {
  it("starts in closed state with 0 failures", () => {
    const { state, consecutiveFailures } = getHeliusCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });

  it("passes through a successful call and stays closed", async () => {
    const result = await withHelius(async () => "ok");
    expect(result).toBe("ok");
    const { state, consecutiveFailures } = getHeliusCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });

  it("increments failure count below threshold without opening", async () => {
    for (let i = 0; i < 4; i++) {
      await expect(
        withHelius(async () => { throw new Error("rpc error"); })
      ).rejects.toThrow("rpc error");
    }
    const { state, consecutiveFailures } = getHeliusCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(4);
  });

  it("resets failure count to 0 after a success", async () => {
    await expect(withHelius(async () => { throw new Error("fail"); })).rejects.toThrow();
    await expect(withHelius(async () => { throw new Error("fail"); })).rejects.toThrow();
    await withHelius(async () => "recovered");
    expect(getHeliusCircuitState().consecutiveFailures).toBe(0);
  });
});

// ── Opening after threshold ───────────────────────────────────────────────────

describe("circuit breaker: opening after threshold", () => {
  it("opens after 5 consecutive failures", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withHelius(async () => { throw new Error("rpc error"); })
      ).rejects.toThrow("rpc error");
    }
    expect(getHeliusCircuitState().state).toBe("open");
  });

  it("fails fast with CircuitOpenError when open — fn is never called", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withHelius(async () => { throw new Error("rpc error"); })
      ).rejects.toThrow();
    }

    const called = { value: false };
    await expect(
      withHelius(async () => { called.value = true; return "x"; })
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called.value).toBe(false);
  });

  it("CircuitOpenError carries a positive retryAfterMs", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withHelius(async () => { throw new Error("x"); })
      ).rejects.toThrow();
    }

    try {
      await withHelius(async () => "x");
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
          withHelius(async () => { throw new Error("x"); })
        ).rejects.toThrow();
      }
      expect(getHeliusCircuitState().state).toBe("open");

      // Advance past the 60-second recovery window
      vi.advanceTimersByTime(61_000);

      expect(getHeliusCircuitState().state).toBe("half-open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("probe success closes the circuit from half-open", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) {
        await expect(
          withHelius(async () => { throw new Error("x"); })
        ).rejects.toThrow();
      }
      vi.advanceTimersByTime(61_000);
      expect(getHeliusCircuitState().state).toBe("half-open");

      const result = await withHelius(async () => "probe success");
      expect(result).toBe("probe success");
      const { state, consecutiveFailures } = getHeliusCircuitState();
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
          withHelius(async () => { throw new Error("x"); })
        ).rejects.toThrow();
      }
      vi.advanceTimersByTime(61_000);
      expect(getHeliusCircuitState().state).toBe("half-open");

      await expect(
        withHelius(async () => { throw new Error("still failing"); })
      ).rejects.toThrow("still failing");

      expect(getHeliusCircuitState().state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Retry with exponential backoff ───────────────────────────────────────────

describe("withHelius: retry on transient errors", () => {
  it("does not retry non-transient errors — exactly 1 attempt", async () => {
    let callCount = 0;
    await expect(
      withHelius(async () => { callCount++; throw new Error("unknown RPC error"); })
    ).rejects.toThrow("unknown RPC error");
    expect(callCount).toBe(1);
    expect(getHeliusCircuitState().consecutiveFailures).toBe(1);
  });

  it("retries transient errors up to 3 times, success on retry clears failures", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const p = withHelius(async () => {
        callCount++;
        if (callCount < 3) throw new Error("503 Service Unavailable");
        return "recovered";
      });
      await vi.runAllTimersAsync();
      const result = await p;
      expect(result).toBe("recovered");
      expect(callCount).toBe(3);
      expect(getHeliusCircuitState().consecutiveFailures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts only one circuit failure after all 3 retries exhausted", async () => {
    vi.useFakeTimers();
    try {
      let callCount = 0;
      const p = withHelius(async () => {
        callCount++;
        throw new Error("502 Bad Gateway");
      });
      void p.catch(() => {}); // prevent unhandled rejection before we await
      await vi.runAllTimersAsync();
      await expect(p).rejects.toThrow("502 Bad Gateway");
      expect(callCount).toBe(3);
      expect(getHeliusCircuitState().consecutiveFailures).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry in half-open state — one probe only", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) {
        const p = withHelius(async () => { throw new Error("x"); });
        void p.catch(() => {});
        await vi.runAllTimersAsync();
        await expect(p).rejects.toThrow();
      }
      vi.advanceTimersByTime(61_000);
      expect(getHeliusCircuitState().state).toBe("half-open");

      let callCount = 0;
      const probeP = withHelius(async () => {
        callCount++;
        throw new Error("502 Bad Gateway"); // transient but half-open = no retry
      });
      void probeP.catch(() => {});
      await vi.runAllTimersAsync();
      await expect(probeP).rejects.toThrow("502 Bad Gateway");
      expect(callCount).toBe(1);
      expect(getHeliusCircuitState().state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── isTransientHeliusError ────────────────────────────────────────────────────

describe("isTransientHeliusError", () => {
  it("flags ECONNRESET as transient", () => {
    expect(isTransientHeliusError(new Error("read ECONNRESET"))).toBe(true);
  });
  it("flags ETIMEDOUT as transient", () => {
    expect(isTransientHeliusError(new Error("connect ETIMEDOUT 1.2.3.4"))).toBe(true);
  });
  it("flags 429 / 502 / 503 / 504 as transient", () => {
    expect(isTransientHeliusError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isTransientHeliusError(new Error("502 Bad Gateway"))).toBe(true);
    expect(isTransientHeliusError(new Error("503 Service Unavailable"))).toBe(true);
    expect(isTransientHeliusError(new Error("504 Gateway Timeout"))).toBe(true);
  });
  it("does not flag non-transient errors", () => {
    expect(isTransientHeliusError(new Error("invalid pubkey"))).toBe(false);
    expect(isTransientHeliusError(new Error("Account not found"))).toBe(false);
    expect(isTransientHeliusError("string error")).toBe(false);
    expect(isTransientHeliusError(null)).toBe(false);
  });
});

// ── resetHeliusCircuit ────────────────────────────────────────────────────────

describe("resetHeliusCircuit", () => {
  it("clears open state and failure count", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withHelius(async () => { throw new Error("x"); })
      ).rejects.toThrow();
    }
    expect(getHeliusCircuitState().state).toBe("open");

    resetHeliusCircuit();
    const { state, consecutiveFailures } = getHeliusCircuitState();
    expect(state).toBe("closed");
    expect(consecutiveFailures).toBe(0);
  });

  it("allows successful calls again after reset from open", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(
        withHelius(async () => { throw new Error("x"); })
      ).rejects.toThrow();
    }
    resetHeliusCircuit();

    const result = await withHelius(async () => 42);
    expect(result).toBe(42);
    expect(getHeliusCircuitState().state).toBe("closed");
  });
});
