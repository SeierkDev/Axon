// Creates a timestamped SQLite backup in a backups/ subdirectory next to the
// database file. Keeps the most recent MAX_BACKUPS copies and deletes older
// ones. Safe to run while the server is live — better-sqlite3 .backup() uses
// SQLite's online backup API so no reads are blocked.
//
// Usage:
//   npm run backup:db
//   DATABASE_PATH=/data/axon.db npm run backup:db

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const MAX_BACKUPS = 7;

function getDbPath(): string {
  const p = process.env.DATABASE_PATH?.trim();
  if (!p) {
    return path.join(process.cwd(), "axon.db");
  }
  return p;
}

async function main(): Promise<void> {
  const dbPath = getDbPath();

  if (!fs.existsSync(dbPath)) {
    console.error(`[backup] Database not found at ${dbPath}`);
    process.exit(1);
  }

  const backupDir = path.join(path.dirname(dbPath), "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(backupDir, `axon-${timestamp}.db`);

  const db = new Database(dbPath, { readonly: true });
  try {
    await db.backup(backupPath);
    console.log(`[backup] Saved to ${backupPath}`);
  } finally {
    db.close();
  }

  // Rotate — delete oldest backups beyond MAX_BACKUPS
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith("axon-") && f.endsWith(".db"))
    .sort();

  const toDelete = files.slice(0, Math.max(0, files.length - MAX_BACKUPS));
  for (const f of toDelete) {
    const target = path.join(backupDir, f);
    fs.unlinkSync(target);
    console.log(`[backup] Rotated old backup: ${f}`);
  }

  console.log(`[backup] Done. ${Math.min(files.length, MAX_BACKUPS)} backup(s) kept.`);
}

main().catch((err) => {
  console.error("[backup] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
