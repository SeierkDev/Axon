// ── DB adapter selection ──────────────────────────────────────────────────────
//
// Supported backends (set via environment variables):
//
//   SQLite on a local/mounted file (default):
//     DATABASE_PATH=/data/axon.db
//
//   Turso (hosted libsql — recommended for production):
//     DATABASE_URL=libsql://your-db.turso.io
//     DATABASE_AUTH_TOKEN=your-token-from-turso-dashboard
//     DATABASE_PATH=/data/axon-replica.db   ← local embedded replica
//
//   Postgres / Supabase (planned):
//     DATABASE_URL=postgresql://user:pass@host/db
//     (requires async refactor — not yet supported)
//
// Turso mode: initTursoSync() in instrumentation.ts pulls the remote DB into
// a local SQLite replica at DATABASE_PATH on startup. getDb() opens that
// replica via better-sqlite3, so all callers work unchanged (sync API).
// Writes are pushed back to Turso by syncToTurso() in the background.

import Database from "better-sqlite3";
import path from "path";
import { seedBuiltinAgents, backfillAgentHistory, backfillDemoSettlementAmounts } from "./agentSeed";
import { applyMigrations } from "./migrations";
import { backfillSpecHashes } from "./specCommitment";
import { isTursoConfigured, syncToTurso, closeTursoClient } from "./db-turso";

const DEFAULT_DB_PATH = path.join(process.cwd(), "axon.db");

export function getDbPath(): string {
  return process.env.DATABASE_PATH?.trim() ?? DEFAULT_DB_PATH;
}

let _db: Database.Database | null = null;

function isExplicitlyAllowed(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function assertProductionDatabase(): void {
  if (process.env.NODE_ENV !== "production") return;
  if (isExplicitlyAllowed(process.env.AXON_ALLOW_EPHEMERAL_DB)) return;

  // Turso mode: DATABASE_URL is set — replica path still needs to be durable
  if (isTursoConfigured()) {
    const replicaPath = process.env.DATABASE_PATH?.trim();
    if (!replicaPath || !path.isAbsolute(replicaPath)) {
      throw new Error(
        "When using Turso (DATABASE_URL=libsql://...), DATABASE_PATH must be set to an absolute path for the local replica (e.g. /data/axon-replica.db)."
      );
    }
    return;
  }

  // SQLite file mode
  const configuredPath = process.env.DATABASE_PATH?.trim();
  if (!configuredPath) {
    throw new Error(
      "DATABASE_PATH is required in production. Set it to a durable absolute path, such as a mounted volume. " +
      "For Turso, set DATABASE_URL=libsql://... instead."
    );
  }
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(
      "DATABASE_PATH must be an absolute durable path in production. Relative SQLite paths can be lost across deploys."
    );
  }
  if (path.resolve(configuredPath) === DEFAULT_DB_PATH) {
    throw new Error(
      "DATABASE_PATH points at the default local axon.db in production. Use a durable mounted volume path or Turso (DATABASE_URL=libsql://...)."
    );
  }

  // Postgres not yet supported
  const dbUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (dbUrl.startsWith("postgresql://") || dbUrl.startsWith("postgres://")) {
    throw new Error(
      "PostgreSQL is not yet supported. Use DATABASE_PATH for SQLite or DATABASE_URL=libsql://... for Turso."
    );
  }
}

// Close the DB cleanly when the process exits so WAL is checkpointed and
// in-flight SQLite transactions are not left dangling (critical for Railway).
// Syncs to Turso first so writes from the last sync window are not lost.
async function closeDb(): Promise<void> {
  await syncToTurso();
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
    _db = null;
  }
  closeTursoClient(); // stop auto-sync interval so the event loop can drain
}
process.once("SIGTERM", () => void closeDb());
process.once("SIGINT", () => void closeDb());

export function getDb(): Database.Database {
  if (_db) return _db;

  assertProductionDatabase();

  const dbPath = getDbPath();
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  // SQLite concurrency model: one writer, concurrent readers via WAL.
  // busy_timeout lets write contention queue for up to 5 s instead of
  // throwing SQLITE_BUSY immediately — critical under concurrent API traffic.
  _db.pragma("busy_timeout = 5000");
  // NORMAL is the WAL-mode default: safe (no data loss on OS crash) and faster
  // than FULL since WAL already provides durability guarantees.
  _db.pragma("synchronous = NORMAL");
  // 8 MB page cache — reduces disk I/O for repeated reads of tasks/agents.
  _db.pragma("cache_size = -8000");

  applyMigrations(_db);
  seedBuiltinAgents(_db);
  backfillAgentHistory(_db);
  // Pin AgenC canonical spec hashes for any tasks created before the spec_hash
  // column existed (idempotent — no-op once all rows have one).
  backfillSpecHashes(_db);
  // Correct old flat-rate demo settlements to each agent's real listed price.
  backfillDemoSettlementAmounts(_db);

  return _db;
}
