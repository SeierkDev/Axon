// Phase 6 (Marketplace Trust Layer): endpoint uptime history.
//
// Every time the gateway calls an agent's endpoint it records one observation
// here (ok = it responded, fail = it errored/timed out). From that history we
// compute a real uptime percentage so a user can see how reliable an endpoint
// has actually been before routing paid work to it. All operations are
// best-effort — uptime tracking must never break the gateway hot path.

import { getDb } from "./db";

export interface EndpointUptime {
  checks: number; // observations in the window
  up: number; // successful observations
  uptime: number; // 0..1 (0 when there are no observations)
  lastCheckedAt: string | null;
  lastStatus: "up" | "down" | null;
}

const EMPTY: EndpointUptime = { checks: 0, up: 0, uptime: 0, lastCheckedAt: null, lastStatus: null };

// Self-heal the table in case the migrations dir wasn't bundled on the host — the
// same failure the Build tables hit in production. Runs its CREATE once per
// process; without it, uptime would silently stay empty where migrations didn't apply.
let tableEnsured = false;
function ensureTable(): void {
  if (tableEnsured) return;
  try {
    getDb().exec(
      `CREATE TABLE IF NOT EXISTS endpoint_checks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        ok          INTEGER NOT NULL,
        checked_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_endpoint_checks_provider ON endpoint_checks (provider_id, checked_at);`,
    );
    tableEnsured = true;
  } catch {
    /* best-effort — retry on the next call */
  }
}

// Record one endpoint observation. Never throws — called from the gateway path.
export function recordEndpointCheck(providerId: string, ok: boolean): void {
  if (!providerId) return;
  ensureTable();
  try {
    getDb()
      .prepare("INSERT INTO endpoint_checks (provider_id, ok, checked_at) VALUES (?, ?, ?)")
      .run(providerId, ok ? 1 : 0, new Date().toISOString());
  } catch {
    /* best-effort — table may not exist yet on a fresh/misprovisioned DB */
  }
}

// Uptime over the trailing window (default 7 days): share of recorded calls that
// succeeded, plus the most recent observed status.
export function getEndpointUptime(providerId: string, windowHours = 168): EndpointUptime {
  if (!providerId) return EMPTY;
  try {
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
    const db = getDb();
    const agg = db
      .prepare(
        "SELECT COUNT(*) AS checks, COALESCE(SUM(ok), 0) AS up FROM endpoint_checks WHERE provider_id = ? AND checked_at >= ?",
      )
      .get(providerId, since) as { checks: number; up: number };
    const last = db
      .prepare("SELECT ok, checked_at FROM endpoint_checks WHERE provider_id = ? ORDER BY checked_at DESC LIMIT 1")
      .get(providerId) as { ok: number; checked_at: string } | undefined;

    const lastStatus = last ? (last.ok ? "up" : "down") : null;
    const lastCheckedAt = last ? last.checked_at : null;

    if (agg.checks === 0) {
      return { ...EMPTY, lastCheckedAt, lastStatus };
    }
    return {
      checks: agg.checks,
      up: agg.up,
      uptime: Math.round((agg.up / agg.checks) * 1000) / 1000,
      lastCheckedAt,
      lastStatus,
    };
  } catch {
    return EMPTY;
  }
}

// Batched uptime for many endpoints at once (one query) so a provider LIST can
// show reliability for comparison without an N+1. Omits last-status (use the
// per-provider call for that). Endpoints with no observations are simply absent.
export function getEndpointUptimeMap(
  providerIds: string[],
  windowHours = 168,
): Map<string, { checks: number; up: number; uptime: number }> {
  const map = new Map<string, { checks: number; up: number; uptime: number }>();
  if (providerIds.length === 0) return map;
  try {
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
    const placeholders = providerIds.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT provider_id, COUNT(*) AS checks, COALESCE(SUM(ok), 0) AS up
         FROM endpoint_checks
         WHERE provider_id IN (${placeholders}) AND checked_at >= ?
         GROUP BY provider_id`,
      )
      .all(...providerIds, since) as { provider_id: string; checks: number; up: number }[];
    for (const r of rows) {
      map.set(r.provider_id, {
        checks: r.checks,
        up: r.up,
        uptime: r.checks > 0 ? Math.round((r.up / r.checks) * 1000) / 1000 : 0,
      });
    }
    return map;
  } catch {
    return map;
  }
}

// Retention: drop observations older than the window so the table stays bounded.
// Returns the number of rows removed.
export function pruneEndpointChecks(olderThanDays = 30): number {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    return getDb().prepare("DELETE FROM endpoint_checks WHERE checked_at < ?").run(cutoff).changes;
  } catch {
    return 0;
  }
}
