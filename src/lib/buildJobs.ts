// Durable progress store for Axon Build generations.
//
// The build pipeline runs in the background (decoupled from the HTTP request)
// so a flaky long-lived SSE stream can't kill it — Railway's HTTP/2 proxy was
// resetting ~5-minute streaming responses. The client starts a build, gets a
// buildId, and POLLS short status requests instead of holding one connection.
//
// Jobs persist in SQLite (build_jobs, migration 038) so a server restart
// mid-build — a redeploy, a crash — no longer loses the job: on boot,
// resumeInterruptedBuilds() re-runs every unfinished job automatically instead
// of making the customer notice and click Resume. The finished game is ALSO
// persisted separately (saveBuildGame), which remains the source of truth for
// serving /play/<id>.

import { getDb } from "./db";

export interface BuildStep {
  status: "pending" | "running" | "done";
  attempt: number;
  passed?: boolean;
}

export interface BuildJob {
  buildId: string;
  signature: string;
  prompt: string;
  steps: Record<string, BuildStep>;
  html: string | null;
  passed: boolean;
  done: boolean;
  error: string | null;
  updatedAt: number;
}

// Finished jobs older than this are pruned (the game itself lives on in
// build_games). Unfinished jobs older than this are marked failed rather than
// auto-resumed — the customer is long gone; their saved payment still lets
// them resume manually.
const JOB_TTL_MS = 24 * 60 * 60_000;

interface Row {
  build_id: string;
  signature: string;
  prompt: string;
  steps: string;
  html: string | null;
  passed: number;
  done: number;
  error: string | null;
  updated_at: number;
}

function fromRow(row: Row): BuildJob {
  let steps: Record<string, BuildStep> = {};
  try {
    steps = JSON.parse(row.steps) as Record<string, BuildStep>;
  } catch {
    /* corrupt steps JSON — progress display degrades, the job itself is fine */
  }
  return {
    buildId: row.build_id,
    signature: row.signature,
    prompt: row.prompt,
    steps,
    html: row.html,
    passed: row.passed === 1,
    done: row.done === 1,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

// Self-heal like ensureBuildTables: keeps Build working even if the migrations
// dir wasn't bundled on the host. Idempotent, ran once per process.
let ensured = false;
export function ensureBuildJobsTable(): void {
  if (ensured) return;
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS build_jobs (
        build_id    TEXT PRIMARY KEY,
        signature   TEXT NOT NULL DEFAULT '',
        prompt      TEXT NOT NULL DEFAULT '',
        steps       TEXT NOT NULL DEFAULT '{}',
        html        TEXT,
        passed      INTEGER NOT NULL DEFAULT 0,
        done        INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        updated_at  INTEGER NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_build_jobs_signature ON build_jobs (signature);
      CREATE INDEX IF NOT EXISTS idx_build_jobs_done_updated ON build_jobs (done, updated_at);
    `);
    ensured = true;
  } catch {
    /* best-effort */
  }
}

function prune(): void {
  try {
    getDb()
      .prepare(`DELETE FROM build_jobs WHERE done = 1 AND updated_at < ?`)
      .run(Date.now() - JOB_TTL_MS);
  } catch {
    /* best-effort */
  }
}

export function createBuildJob(buildId: string, signature: string, prompt: string): BuildJob {
  ensureBuildJobsTable();
  prune();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO build_jobs (build_id, signature, prompt, steps, html, passed, done, error, updated_at, created_at)
       VALUES (?, ?, ?, '{}', NULL, 0, 0, NULL, ?, ?)`,
    )
    .run(buildId, signature, prompt, now, new Date(now).toISOString());
  return {
    buildId,
    signature,
    prompt,
    steps: {},
    html: null,
    passed: false,
    done: false,
    error: null,
    updatedAt: now,
  };
}

export function getBuildJob(buildId: string): BuildJob | undefined {
  ensureBuildJobsTable();
  try {
    const row = getDb()
      .prepare(`SELECT * FROM build_jobs WHERE build_id = ?`)
      .get(buildId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  } catch {
    return undefined;
  }
}

// Find the latest job for a payment, so a reconnect/resume polls the SAME
// build instead of starting a duplicate one.
export function getBuildJobBySignature(signature: string): BuildJob | undefined {
  if (!signature) return undefined;
  ensureBuildJobsTable();
  try {
    const row = getDb()
      .prepare(`SELECT * FROM build_jobs WHERE signature = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(signature) as Row | undefined;
    return row ? fromRow(row) : undefined;
  } catch {
    return undefined;
  }
}

// Unfinished jobs, oldest first — what a booting server needs to pick back up.
export function getUnfinishedBuildJobs(): BuildJob[] {
  ensureBuildJobsTable();
  try {
    const rows = getDb()
      .prepare(`SELECT * FROM build_jobs WHERE done = 0 ORDER BY updated_at ASC`)
      .all() as Row[];
    return rows.map(fromRow);
  } catch {
    return [];
  }
}

export function setBuildStep(
  buildId: string,
  step: string,
  status: BuildStep["status"],
  attempt: number,
  passed?: boolean,
): void {
  const job = getBuildJob(buildId);
  if (!job) return;
  job.steps[step] = { status, attempt, passed };
  try {
    getDb()
      .prepare(`UPDATE build_jobs SET steps = ?, updated_at = ? WHERE build_id = ?`)
      .run(JSON.stringify(job.steps), Date.now(), buildId);
  } catch {
    /* progress display is best-effort */
  }
}

export function finishBuildJob(buildId: string, html: string, passed: boolean): void {
  try {
    getDb()
      .prepare(`UPDATE build_jobs SET html = ?, passed = ?, done = 1, updated_at = ? WHERE build_id = ?`)
      .run(html, passed ? 1 : 0, Date.now(), buildId);
  } catch {
    /* the finished game is persisted separately in build_games */
  }
}

export function failBuildJob(buildId: string, error: string): void {
  try {
    getDb()
      .prepare(`UPDATE build_jobs SET error = ?, done = 1, updated_at = ? WHERE build_id = ?`)
      .run(error, Date.now(), buildId);
  } catch {
    /* best-effort */
  }
}

export { JOB_TTL_MS };
