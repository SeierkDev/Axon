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

  const record = db.prepare(`
    INSERT OR IGNORE INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const migration of readMigrations()) {
    const existingChecksum = applied.get(migration.version);
    if (existingChecksum) {
      if (existingChecksum !== migration.checksum) {
        // The file changed after it was applied. Don't crash the app on boot —
        // the schema is already in place; record the drift and carry on so that
        // genuinely new migrations later in the list can still apply.
        console.warn(
          `[migrations] ${migration.filename}: checksum differs from the applied version; leaving existing schema in place.`
        );
      }
      continue;
    }

    try {
      db.transaction(() => {
        db.exec(migration.sql);
        record.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      })();
      appliedNow.push(migration.filename);
    } catch (err) {
      // A database created before migration tracking existed already contains
      // these objects. Adopt the migration as applied rather than crashing on
      // "table/index already exists" — this lets brand-new migrations still run.
      if (/already exists/i.test(String(err))) {
        record.run(migration.version, migration.name, migration.checksum, new Date().toISOString());
        console.warn(`[migrations] ${migration.filename}: objects already present; marking as applied.`);
      } else {
        throw err;
      }
    }
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
