// Turso embedded-replica adapter.
//
// How it works:
//   1. At app startup (instrumentation.ts), initTursoSync() pulls the remote
//      Turso database into a local SQLite replica file at DATABASE_PATH.
//   2. getDb() opens better-sqlite3 on that local file — all existing callers
//      work unchanged (sync reads/writes, zero refactor).
//   3. After the app has written data, call syncToTurso() to push local changes
//      back to the remote. The Turso client also syncs on its own interval.
//
// Environment variables:
//   DATABASE_URL=libsql://your-db.turso.io   ← remote Turso endpoint
//   DATABASE_AUTH_TOKEN=your-token            ← auth token from Turso dashboard
//   DATABASE_PATH=/data/axon.db              ← local replica file path
//
// Without DATABASE_URL the Turso path is skipped; the app uses SQLite directly.

import { createClient, type Client } from "@libsql/client";
import path from "path";

const SYNC_INTERVAL_SECONDS = 60;

let _tursoClient: Client | null = null;

function getReplicaPath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (configured) return configured;
  return path.join(process.cwd(), "axon.db");
}

export function isTursoConfigured(): boolean {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  return url.startsWith("libsql://") || url.startsWith("libsqls://");
}

export function getTursoClient(): Client | null {
  return _tursoClient;
}

// Call once at startup. Pulls the remote Turso DB into the local replica file.
export async function initTursoSync(): Promise<void> {
  if (!isTursoConfigured()) return;

  const syncUrl = process.env.DATABASE_URL!.trim();
  const authToken = process.env.DATABASE_AUTH_TOKEN?.trim();

  if (!authToken) {
    throw new Error(
      "DATABASE_AUTH_TOKEN is required when DATABASE_URL is a Turso libsql endpoint"
    );
  }

  const replicaPath = getReplicaPath();

  _tursoClient = createClient({
    url: `file:${replicaPath}`,
    syncUrl,
    authToken,
    syncInterval: SYNC_INTERVAL_SECONDS,
  });

  // Pull latest state from Turso into the local replica before the app starts serving
  await _tursoClient.sync();
}

// Push local writes to Turso. Safe to call fire-and-forget; errors are logged but not thrown.
export async function syncToTurso(): Promise<void> {
  if (!_tursoClient) return;
  try {
    await _tursoClient.sync();
  } catch (err) {
    // Non-fatal: local replica still has the data; will sync on next interval
    console.warn("[turso] Background sync failed:", err instanceof Error ? err.message : err);
  }
}

// Execute a query directly on the Turso client (async).
// Use this for write-critical paths where you need immediate remote durability.
export async function tursoExecute(
  sql: string,
  args?: (string | number | null | boolean)[]
): Promise<{ rows: Record<string, unknown>[] }> {
  if (!_tursoClient) {
    throw new Error("Turso client not initialised — call initTursoSync() first");
  }
  const result = await _tursoClient.execute({ sql, args: args ?? [] });
  const rows = result.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
  return { rows };
}
