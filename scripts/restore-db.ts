// Restores the database from a backup file.
// Overwrites DATABASE_PATH with the contents of the specified backup.
// The server must be stopped before running this.
//
// Usage:
//   npm run restore:db -- /data/backups/axon-2026-06-19T16-00-00.db
//   npm run restore:db -- latest   ← restores the most recent backup

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

function getDbPath(): string {
  const p = process.env.DATABASE_PATH?.trim();
  if (!p) return path.join(process.cwd(), "axon.db");
  return p;
}

function resolveBackup(arg: string, backupDir: string): string {
  if (arg === "latest") {
    if (!fs.existsSync(backupDir)) {
      console.error("[restore] No backups directory found at", backupDir);
      process.exit(1);
    }
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("axon-") && f.endsWith(".db"))
      .sort();
    if (files.length === 0) {
      console.error("[restore] No backups found in", backupDir);
      process.exit(1);
    }
    return path.join(backupDir, files[files.length - 1]);
  }
  return path.isAbsolute(arg) ? arg : path.resolve(arg);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("[restore] Usage: npm run restore:db -- <backup-path|latest>");
    process.exit(1);
  }

  const dbPath = getDbPath();
  const backupDir = path.join(path.dirname(dbPath), "backups");
  const backupPath = resolveBackup(arg, backupDir);

  if (!fs.existsSync(backupPath)) {
    console.error(`[restore] Backup not found: ${backupPath}`);
    process.exit(1);
  }

  // Safety: copy current db aside before overwriting
  if (fs.existsSync(dbPath)) {
    const safeguard = `${dbPath}.pre-restore-${Date.now()}`;
    fs.copyFileSync(dbPath, safeguard);
    console.log(`[restore] Current database saved to ${safeguard}`);
  }

  const src = new Database(backupPath, { readonly: true });
  try {
    await src.backup(dbPath);
  } finally {
    src.close();
  }

  // Remove stale WAL and SHM files from the old database. If left in place,
  // SQLite would replay the old WAL against the restored database on next open.
  for (const suffix of ["-wal", "-shm"]) {
    const stale = `${dbPath}${suffix}`;
    if (fs.existsSync(stale)) {
      fs.unlinkSync(stale);
      console.log(`[restore] Removed stale ${suffix} file`);
    }
  }

  console.log(`[restore] Restored from ${backupPath} → ${dbPath}`);
}

main().catch((err) => {
  console.error("[restore] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
