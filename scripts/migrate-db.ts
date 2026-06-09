import { getDb } from "../src/lib/db";
import { listMigrations } from "../src/lib/migrations";

const migrations = listMigrations(getDb());

console.log(JSON.stringify({
  ok: true,
  applied: migrations.length,
  migrations: migrations.map((migration) => migration.version),
}, null, 2));
