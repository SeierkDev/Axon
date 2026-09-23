// Phase 9: public status page.
//
// A transparent, public view of whether the platform is healthy — derived from
// real, observable signals (database ping, the background worker's heartbeat,
// live throughput) rather than a hand-set status. Overall status is the worst of
// the components, so a degraded worker shows as degraded even while the API is up.

import { getDb } from "./db";
import { getNetworkStats } from "./analytics";
import { getSyncHealth } from "./db-turso";
import { jobHealth, type JobHealth } from "./cronRuns";

export type ComponentStatus = "operational" | "degraded" | "down";

export interface StatusComponent {
  name: string;
  status: ComponentStatus;
  detail?: string;
}

export interface SystemStatus {
  status: ComponentStatus;
  components: StatusComponent[];
  /** one line per scheduled job, so a job that quietly stopped is visible rather than inferred */
  jobs: JobHealth[];
  metrics: {
    queueDepth: number;
    runningTasks: number;
    tasksCompleted: number;
    successRate: number;
    successRateWindowHours: number;
    workerLastSeenAgeSeconds: number | null;
  };
  updatedAt: string;
}

// "down" if the local replica can't even be read; "degraded" if it reads fine
// but the Turso replica sync is failing (writes silently not propagating between
// processes — invisible to a plain local read, the real risk in this deployment).
function checkDatabase(): { status: ComponentStatus; detail: string } {
  try {
    const row = getDb().prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    if (row?.ok !== 1) return { status: "down", detail: "Unreachable" };
  } catch {
    return { status: "down", detail: "Unreachable" };
  }
  const sync = getSyncHealth();
  if (sync.configured && sync.lastError) {
    return { status: "degraded", detail: `Replica sync failing: ${sync.lastError.slice(0, 80)}` };
  }
  return { status: "operational", detail: sync.configured ? "Reachable, replica in sync" : "Reachable" };
}

function workerAgeSeconds(): number | null {
  try {
    const row = getDb()
      .prepare("SELECT updated_at FROM worker_state WHERE key = 'last_seen'")
      .get() as { updated_at: string } | undefined;
    if (!row) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 1000));
  } catch {
    return null;
  }
}

// The worker writes its heartbeat every 15s, but web and worker can be separate
// processes against Turso embedded replicas that sync ~every 60s — so the web's
// view of the heartbeat can lag 1-2 min even when the worker is healthy.
// Thresholds are deliberately lag-tolerant so the public page doesn't flash a
// false "degraded": >5 min silent = degraded, >15 min = down.
function checkWorker(ageSeconds: number | null): ComponentStatus {
  if (ageSeconds === null) return "degraded";
  if (ageSeconds > 900) return "down";
  if (ageSeconds > 300) return "degraded";
  return "operational";
}

const SEVERITY: ComponentStatus[] = ["operational", "degraded", "down"];

/** The status page must render even if the ledger table is missing on an older database. */
function safeJobHealth(): JobHealth[] {
  try {
    return jobHealth();
  } catch {
    return [];
  }
}

/**
 * The scheduled jobs, as one component.
 *
 * Silence is the signal. A job that errors and a job that was never scheduled both leave nothing
 * behind, which is how the autonomy pass managed to be dead for three days while every dashboard
 * showed green. One overdue job is degraded rather than down, because the site keeps working without
 * any single one of them; several at once means something common to them all has broken, which is
 * worth shouting about.
 */
function checkJobs(jobs: JobHealth[]): { status: ComponentStatus; detail: string } {
  const overdue = jobs.filter((j) => j.overdue);
  if (overdue.length === 0) {
    const reporting = jobs.filter((j) => !j.neverRun).length;
    return {
      status: "operational",
      detail: reporting === 0 ? "No runs recorded yet" : `${reporting} of ${jobs.length} reporting on time`,
    };
  }
  const names = overdue.map((j) => j.job).join(", ");
  return {
    status: overdue.length >= 3 ? "down" : "degraded",
    detail: `Overdue: ${names}`,
  };
}

export function getSystemStatus(): SystemStatus {
  const db = checkDatabase();
  const dbReadable = db.status !== "down";
  const ageSeconds = dbReadable ? workerAgeSeconds() : null;
  const workerStatus = dbReadable ? checkWorker(ageSeconds) : "down";

  const jobs = dbReadable ? safeJobHealth() : [];
  const jobsComponent = checkJobs(jobs);

  const components: StatusComponent[] = [
    { name: "API", status: "operational", detail: "Responding" },
    { name: "Database", status: db.status, detail: db.detail },
    {
      name: "Background worker",
      status: workerStatus,
      detail: ageSeconds === null ? "No heartbeat reported yet" : `Last heartbeat ${ageSeconds}s ago`,
    },
    { name: "Scheduled jobs", status: jobsComponent.status, detail: jobsComponent.detail },
  ];

  const overall = components.reduce<ComponentStatus>(
    (worst, c) => (SEVERITY.indexOf(c.status) > SEVERITY.indexOf(worst) ? c.status : worst),
    "operational"
  );

  let stats: ReturnType<typeof getNetworkStats> | null = null;
  try {
    stats = getNetworkStats();
  } catch {
    stats = null;
  }

  return {
    status: overall,
    components,
    jobs,
    metrics: {
      queueDepth: stats?.tasks.queued ?? 0,
      runningTasks: stats?.tasks.running ?? 0,
      tasksCompleted: stats?.tasks.completed ?? 0,
      successRate: stats?.tasks.successRate ?? 0,
      successRateWindowHours: stats?.tasks.successRateWindowHours ?? 24,
      workerLastSeenAgeSeconds: ageSeconds,
    },
    updatedAt: new Date().toISOString(),
  };
}
