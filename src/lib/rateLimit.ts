import { NextResponse } from "next/server";
import { apiError } from "./apiError";
import { getDb } from "./db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // epoch ms
}

// Purge all expired windows every 100 checkRateLimit calls — avoids unbounded table growth
// without needing a background timer.
let purgeCounter = 0;
function maybePurgeExpired(): void {
  if (++purgeCounter % 100 === 0) {
    getDb()
      .prepare("DELETE FROM rate_limit_windows WHERE reset_at < ?")
      .run(Date.now());
  }
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const db = getDb();
  const now = Date.now();
  const newResetAt = now + windowMs;

  // Atomic: delete the expired window for this key (if any), then upsert.
  // Runs in a single SQLite transaction so concurrent requests can't interleave.
  const row = db.transaction(() => {
    db.prepare("DELETE FROM rate_limit_windows WHERE key = ? AND reset_at <= ?")
      .run(key, now);
    db.prepare(`
      INSERT INTO rate_limit_windows (key, count, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = count + 1
    `).run(key, newResetAt);
    return db.prepare("SELECT count, reset_at FROM rate_limit_windows WHERE key = ?")
      .get(key) as { count: number; reset_at: number };
  })();

  maybePurgeExpired();

  return {
    allowed: row.count <= limit,
    remaining: Math.max(0, limit - row.count),
    resetAt: row.reset_at,
  };
}

// Give back a consumed slot — for endpoints where the limit should count
// SUCCESSFUL uses, not attempts (e.g. the world pipeline showcase: a failed
// validation shouldn't burn the visitor's hourly runs).
export function refundRateLimit(key: string): void {
  getDb()
    .prepare("UPDATE rate_limit_windows SET count = MAX(0, count - 1) WHERE key = ? AND reset_at > ?")
    .run(key, Date.now());
}

export function getClientIp(req: Request): string {
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const cf = req.headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;

    const real = req.headers.get("x-real-ip")?.trim();
    if (real) return real;

    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) {
      const first = fwd.split(",")[0]?.trim();
      if (first) return first;
    }
  }

  return "direct";
}

export function rateLimitHeaders(
  result: RateLimitResult,
  limit: number
): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
  };
}

export function tooManyRequests(result: RateLimitResult): NextResponse {
  const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
  return apiError(
    "RATE_LIMITED",
    "Rate limit exceeded. Please retry after the window resets.",
    429,
    { resetAt: result.resetAt },
    {
      headers: {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
      },
    }
  );
}
