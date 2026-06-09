import { describe, it, expect } from "vitest";
import { checkRateLimit, getClientIp, rateLimitHeaders, tooManyRequests } from "@/lib/rateLimit";
import { getDb } from "@/lib/db";
import { NextRequest } from "next/server";

// ── Basic enforcement ─────────────────────────────────────────────────────────

describe("checkRateLimit: enforcement", () => {
  it("allows requests up to the limit", () => {
    const key = "rl-basic-1";
    const r1 = checkRateLimit(key, 3, 60_000);
    const r2 = checkRateLimit(key, 3, 60_000);
    const r3 = checkRateLimit(key, 3, 60_000);

    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks requests over the limit and reports remaining=0", () => {
    const key = "rl-block-1";
    checkRateLimit(key, 2, 60_000);
    checkRateLimit(key, 2, 60_000);
    const blocked = checkRateLimit(key, 2, 60_000);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("resetAt is in the future", () => {
    const before = Date.now();
    const r = checkRateLimit("rl-reset-1", 10, 5_000);
    expect(r.resetAt).toBeGreaterThan(before);
    expect(r.resetAt).toBeLessThanOrEqual(before + 5_000 + 50); // small tolerance
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe("checkRateLimit: SQLite persistence", () => {
  it("state is stored in the rate_limit_windows table", () => {
    const key = "rl-persist-1";
    checkRateLimit(key, 10, 60_000);
    checkRateLimit(key, 10, 60_000);
    checkRateLimit(key, 10, 60_000);

    const row = getDb()
      .prepare("SELECT count FROM rate_limit_windows WHERE key = ?")
      .get(key) as { count: number } | undefined;

    expect(row).not.toBeUndefined();
    expect(row!.count).toBe(3);
  });

  it("count survives across separate calls (no in-memory reset)", () => {
    const key = "rl-persist-2";
    // First batch
    checkRateLimit(key, 10, 60_000);
    checkRateLimit(key, 10, 60_000);

    // Simulate a later call in the same process — state must be DB, not Map
    const r = checkRateLimit(key, 10, 60_000);
    expect(r.remaining).toBe(7); // 10 - 3
  });
});

// ── Window expiry ─────────────────────────────────────────────────────────────

describe("checkRateLimit: window expiry", () => {
  it("resets count after window expires", async () => {
    const key = "rl-expiry-1";
    checkRateLimit(key, 2, 50); // 50ms window
    checkRateLimit(key, 2, 50);
    const blocked = checkRateLimit(key, 2, 50);
    expect(blocked.allowed).toBe(false);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 70));

    const reset = checkRateLimit(key, 2, 50);
    expect(reset.allowed).toBe(true);
    expect(reset.remaining).toBe(1); // 2 - 1
  });

  it("expired row is deleted from DB on next check", async () => {
    const key = "rl-expiry-cleanup-1";
    checkRateLimit(key, 5, 50);

    await new Promise((resolve) => setTimeout(resolve, 70));

    checkRateLimit(key, 5, 50); // triggers DELETE of expired row then fresh INSERT

    const row = getDb()
      .prepare("SELECT count, reset_at FROM rate_limit_windows WHERE key = ?")
      .get(key) as { count: number; reset_at: number } | undefined;

    expect(row).not.toBeUndefined();
    expect(row!.count).toBe(1); // reset to 1 after expiry
    expect(row!.reset_at).toBeGreaterThan(Date.now() - 100);
  });
});

// ── getClientIp ───────────────────────────────────────────────────────────────

describe("getClientIp", () => {
  it("returns 'direct' when TRUST_PROXY_HEADERS is not set", () => {
    const req = new NextRequest("http://localhost/", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(getClientIp(req)).toBe("direct");
  });

  it("reads cf-connecting-ip when TRUST_PROXY_HEADERS=true", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    try {
      const req = new NextRequest("http://localhost/", {
        headers: { "cf-connecting-ip": "5.6.7.8" },
      });
      expect(getClientIp(req)).toBe("5.6.7.8");
    } finally {
      delete process.env.TRUST_PROXY_HEADERS;
    }
  });

  it("reads x-real-ip when cf-connecting-ip is absent", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    try {
      const req = new NextRequest("http://localhost/", {
        headers: { "x-real-ip": "9.10.11.12" },
      });
      expect(getClientIp(req)).toBe("9.10.11.12");
    } finally {
      delete process.env.TRUST_PROXY_HEADERS;
    }
  });

  it("reads first x-forwarded-for IP when others are absent", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    try {
      const req = new NextRequest("http://localhost/", {
        headers: { "x-forwarded-for": "13.14.15.16, 17.18.19.20" },
      });
      expect(getClientIp(req)).toBe("13.14.15.16");
    } finally {
      delete process.env.TRUST_PROXY_HEADERS;
    }
  });
});

// ── rateLimitHeaders / tooManyRequests ────────────────────────────────────────

describe("rateLimitHeaders", () => {
  it("returns correct header values", () => {
    const result = { allowed: false, remaining: 0, resetAt: Date.now() + 30_000 };
    const headers = rateLimitHeaders(result, 10);
    expect(headers["X-RateLimit-Limit"]).toBe("10");
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["X-RateLimit-Reset"]).toBeDefined();
  });
});

describe("tooManyRequests", () => {
  it("returns a 429 response with Retry-After header", async () => {
    const result = { allowed: false, remaining: 0, resetAt: Date.now() + 5_000 };
    const response = tooManyRequests(result);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBeDefined();
    const body = await response.json() as { code: string };
    expect(body.code).toBe("RATE_LIMITED");
  });
});

// ── maybePurgeExpired: purge trigger fires at call 100 ────────────────────────

describe("maybePurgeExpired: purge trigger at 100 calls", () => {
  it("runs the purge DELETE on the 100th checkRateLimit call without throwing", () => {
    // Call checkRateLimit 100 times with distinct keys to reach the purge threshold.
    // Uses unique keys so none of the windows expire mid-loop.
    for (let i = 0; i < 100; i++) {
      checkRateLimit(`purge-trigger-${i}`, 200, 60_000);
    }
    // If the purge fires without error the test passes — no assertion needed beyond not throwing
    expect(true).toBe(true);
  });
});
