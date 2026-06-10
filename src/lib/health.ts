import { getDb } from "./db";
import { listMigrations } from "./migrations";
import { getHeliusCircuitState } from "./solana";

type CheckStatus = "ok" | "warn" | "error";

export interface HealthCheck {
  name: string;
  status: CheckStatus;
  message?: string;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  ok: boolean;
  status: "live" | "ready" | "not_ready";
  service: "axon";
  timestamp: string;
  uptimeSeconds: number;
  checks: HealthCheck[];
}

function hasEnv(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function checkRuntime(): HealthCheck {
  return {
    name: "runtime",
    status: "ok",
    details: {
      nodeEnv: process.env.NODE_ENV ?? "development",
      nodeVersion: process.version,
    },
  };
}

function checkDatabase(): HealthCheck {
  try {
    const db = getDb();
    const row = db.prepare("SELECT 1 AS ok").get() as { ok: number };
    if (row.ok !== 1) {
      return { name: "database", status: "error", message: "SQLite ping returned an unexpected value" };
    }

    return { name: "database", status: "ok" };
  } catch (err) {
    return {
      name: "database",
      status: "error",
      message: err instanceof Error ? err.message : "Database check failed",
    };
  }
}

function checkMigrations(): HealthCheck {
  try {
    const migrations = listMigrations(getDb());
    return {
      name: "migrations",
      status: "ok",
      details: {
        applied: migrations.length,
        versions: migrations.map((migration) => migration.version),
      },
    };
  } catch (err) {
    return {
      name: "migrations",
      status: "error",
      message: err instanceof Error ? err.message : "Migration check failed",
    };
  }
}

function checkProductionConfig(): HealthCheck {
  if (process.env.NODE_ENV !== "production") {
    return {
      name: "production_config",
      status: "ok",
      message: "Production-only config checks skipped outside production",
    };
  }

  const missingRequired = [
    "NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS",
    ...(process.env.AXON_PAYMENT_VERIFIER === "mock" ? [] : ["HELIUS_API_KEY"]),
  ].filter((name) => !hasEnv(name));

  const missingRecommended = [
    "ANTHROPIC_API_KEY",
    "SEED_SECRET",
  ].filter((name) => !hasEnv(name));

  if (missingRequired.length > 0) {
    return {
      name: "production_config",
      status: "error",
      message: "Required production environment variables are missing",
      details: {
        missingRequired,
        missingRecommended,
      },
    };
  }

  if (missingRecommended.length > 0) {
    return {
      name: "production_config",
      status: "warn",
      message: "Recommended production environment variables are missing",
      details: { missingRecommended },
    };
  }

  return { name: "production_config", status: "ok" };
}

function buildReport(status: HealthReport["status"], checks: HealthCheck[]): HealthReport {
  const ok = checks.every((check) => check.status !== "error");
  return {
    ok,
    status: ok ? status : "not_ready",
    service: "axon",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks,
  };
}

function checkMemory(): HealthCheck {
  const mem = process.memoryUsage();
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  const status = heapUsedMb > 400 ? "error" : heapUsedMb > 300 ? "warn" : "ok";
  return {
    name: "memory",
    status,
    details: { heapUsedMb, heapTotalMb, rssMb, heapPercent: heapPct },
  };
}

function checkTaskStats(): HealthCheck {
  try {
    const db = getDb();
    const rows = db
      .prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
      .all() as { status: string; count: number }[];
    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r.count;

    const { stuckCount } = db
      .prepare(`
        SELECT COUNT(*) AS stuckCount FROM tasks
        WHERE status = 'running' AND started_at < ?
      `)
      .get(new Date(Date.now() - 30 * 60 * 1000).toISOString()) as { stuckCount: number };

    return {
      name: "tasks",
      status: stuckCount > 0 ? "warn" : "ok",
      details: { ...counts, stuckRunningGt30m: stuckCount },
    };
  } catch (err) {
    return {
      name: "tasks",
      status: "warn",
      message: err instanceof Error ? err.message : "Task stats unavailable",
    };
  }
}

function checkWorker(): HealthCheck {
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT value, updated_at FROM worker_state WHERE key = 'last_seen'")
      .get() as { value: string; updated_at: string } | undefined;

    if (!row) {
      return { name: "worker", status: "warn", message: "Worker has not reported in yet" };
    }

    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    const ageMins = Math.round(ageMs / 60_000);
    // Worker polls every 15 s — flag as warn if silent for >2 min, error if >10 min
    const status = ageMs > 10 * 60_000 ? "error" : ageMs > 2 * 60_000 ? "warn" : "ok";
    return {
      name: "worker",
      status,
      details: { lastSeenAt: row.updated_at, ageMinutes: ageMins },
    };
  } catch {
    return { name: "worker", status: "warn", message: "Worker state table not yet available" };
  }
}

function checkAgentStats(): HealthCheck {
  try {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) AS total FROM agents").get() as { total: number };
    return {
      name: "agents",
      status: "ok",
      details: { registered: row.total },
    };
  } catch (err) {
    return {
      name: "agents",
      status: "warn",
      message: err instanceof Error ? err.message : "Agent stats unavailable",
    };
  }
}

function checkHeliusCircuit(): HealthCheck {
  const { state, consecutiveFailures } = getHeliusCircuitState();
  return {
    name: "helius_circuit",
    status: state === "open" ? "error" : state === "half-open" ? "warn" : "ok",
    details: { state, consecutiveFailures },
  };
}

export function getHealthReport(): HealthReport {
  return buildReport("live", [
    checkRuntime(),
    checkDatabase(),
    checkMemory(),
    checkTaskStats(),
    checkAgentStats(),
    checkWorker(),
    checkHeliusCircuit(),
  ]);
}

export function getReadinessReport(): HealthReport {
  return buildReport("ready", [
    checkRuntime(),
    checkDatabase(),
    checkMigrations(),
    checkProductionConfig(),
  ]);
}
