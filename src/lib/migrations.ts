import Database from "better-sqlite3";
import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

interface AppliedMigration {
  version: string;
  checksum: string;
}

interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function readMigrations(): MigrationFile[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];

  return readdirSync(MIGRATIONS_DIR)
    .filter((filename) => /^\d+_[a-z0-9_-]+\.sql$/i.test(filename))
    .sort()
    .map((filename) => {
      const version = filename.split("_")[0];
      const sql = readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
      return {
        version,
        name: filename.replace(/^\d+_/, "").replace(/\.sql$/i, ""),
        filename,
        sql,
        checksum: checksum(sql),
      };
    });
}

export function applyMigrations(db: Database.Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Map(
    (db.prepare("SELECT version, checksum FROM schema_migrations").all() as AppliedMigration[])
      .map((row) => [row.version, row.checksum])
  );
  const appliedNow: string[] = [];

  for (const migration of readMigrations()) {
    const existingChecksum = applied.get(migration.version);
    if (existingChecksum) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.filename} checksum changed after it was applied. Create a new migration instead.`
        );
      }
      continue;
    }

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(`
        INSERT INTO schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    })();

    appliedNow.push(migration.filename);
  }

  return appliedNow;
}

export function listMigrations(db: Database.Database): AppliedMigration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  return db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as AppliedMigration[];
}
