// In-memory progress store for Axon Build generations.
//
// The build pipeline runs in the background (decoupled from the HTTP request)
// so a flaky long-lived SSE stream can't kill it — Railway's HTTP/2 proxy was
// resetting ~5-minute streaming responses. The client starts a build, gets a
// buildId, and POLLS short status requests instead of holding one connection.
//
// State lives in this process's memory. The FINAL game is also persisted to the
// DB (saveBuildGame), so a status poll that misses the in-memory job (process
// restart, TTL prune) still recovers the finished game from storage. Live
// per-agent progress is best-effort; correctness rests on the persisted game.

export interface BuildStep {
  status: "pending" | "running" | "done";
  attempt: number;
  passed?: boolean;
}

export interface BuildJob {
  buildId: string;
  signature: string;
  steps: Record<string, BuildStep>;
  html: string | null;
  passed: boolean;
  done: boolean;
  error: string | null;
  updatedAt: number;
}

const jobs = new Map<string, BuildJob>();
const buildIdBySignature = new Map<string, string>();

// Keep memory bounded — builds take a few minutes; 30 min covers reconnects.
const JOB_TTL_MS = 30 * 60_000;

function prune(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) {
      jobs.delete(id);
      if (job.signature && buildIdBySignature.get(job.signature) === id) {
        buildIdBySignature.delete(job.signature);
      }
    }
  }
}

export function createBuildJob(buildId: string, signature: string): BuildJob {
  prune();
  const job: BuildJob = {
    buildId,
    signature,
    steps: {},
    html: null,
    passed: false,
    done: false,
    error: null,
    updatedAt: Date.now(),
  };
  jobs.set(buildId, job);
  if (signature) buildIdBySignature.set(signature, buildId);
  return job;
}

export function getBuildJob(buildId: string): BuildJob | undefined {
  return jobs.get(buildId);
}

// Find an in-progress (or just-finished, not-yet-pruned) job for a payment, so
// a reconnect/resume polls the SAME build instead of starting a duplicate one.
export function getBuildJobBySignature(signature: string): BuildJob | undefined {
  const id = signature ? buildIdBySignature.get(signature) : undefined;
  return id ? jobs.get(id) : undefined;
}

export function setBuildStep(
  buildId: string,
  step: string,
  status: BuildStep["status"],
  attempt: number,
  passed?: boolean,
): void {
  const job = jobs.get(buildId);
  if (!job) return;
  job.steps[step] = { status, attempt, passed };
  job.updatedAt = Date.now();
}

export function finishBuildJob(buildId: string, html: string, passed: boolean): void {
  const job = jobs.get(buildId);
  if (!job) return;
  job.html = html;
  job.passed = passed;
  job.done = true;
  job.updatedAt = Date.now();
}

export function failBuildJob(buildId: string, error: string): void {
  const job = jobs.get(buildId);
  if (!job) return;
  job.error = error;
  job.done = true;
  job.updatedAt = Date.now();
}
