import { getTasksByAgent, startTask, completeTask, failTask } from "../lib/tasks";
import { refundPayment } from "../lib/payments";
import { settleCompletedTask } from "../lib/sla";
import { refundDebitForTask } from "../lib/mpp";
import { getAllAgents } from "../lib/agents";
import { runOrchestration } from "../lib/orchestrator";
import { getSubcontractsForParent } from "../lib/subcontracts";
import { getDb } from "../lib/db";
import { syncToTurso } from "../lib/db-turso";
import { listMcpServers, createMcpAgentHandler } from "../lib/mcp";
import { deliverPendingWebhooks } from "../lib/webhooks";
import { recordTaskLatency } from "../lib/metrics";
import { formatContext } from "../lib/formatContext";
import { runWithProvider, runWithProviderTools, getAgentMaxTokens } from "../lib/providers";
import type { ToolCallEvent } from "../lib/providers";
import { resolveAgentTools, hasTools } from "../lib/agentTools";
import { safeAppendTraceEvent, hashContent, estimateCostUsd, captureModelStep } from "../lib/traceEvents";
import { verifyAgentEndpoint } from "../lib/verification";
import { logger } from "../lib/logger";
import { runWithTraceId } from "../lib/tracing";
import { checkAllThresholds } from "../lib/spendThreshold";

// Agents that append live market prices to their task message
const PRICE_AGENTS = new Set(["crypto-agent", "trading-agent"]);

// 3s: a workflow step only exists after the previous one completes, so the
// poll gap is paid per step — at 15s a 3-step pipeline wasted ~45s just waiting.
const POLL_INTERVAL_MS = 3_000;
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const THRESHOLD_INTERVAL_MS = 5 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.AXON_WORKER_SHUTDOWN_TIMEOUT_MS ?? "25000", 10);
// 10 min. Sized for a single inference (up to 3 retries × 120 s provider
// timeout); a tool-granted agent spends it across several model calls plus the
// searches and fetches between them, so the ceiling is the whole loop, not one
// call. Hitting it fails and refunds the task, and now also aborts the loop.
const TASK_TIMEOUT_MS = Number.parseInt(process.env.AXON_TASK_TIMEOUT_MS ?? "600000", 10);
const MAX_CONCURRENT_PER_AGENT = Number.parseInt(process.env.AXON_MAX_CONCURRENT_PER_AGENT ?? "1", 10);
const MAX_STUCK_RESETS = Number.parseInt(process.env.AXON_MAX_STUCK_RESETS ?? "3", 10);
const CIRCUIT_FAILURE_THRESHOLD = Number.parseInt(process.env.AXON_CIRCUIT_FAILURE_THRESHOLD ?? "5", 10);
const CIRCUIT_RECOVERY_WINDOW_MS = Number.parseInt(process.env.AXON_CIRCUIT_RECOVERY_WINDOW_MS ?? "300000", 10); // 5 min

// ── Per-agent circuit breaker ──────────────────────────────────────────────────
type CircuitState = "closed" | "open" | "half-open";
interface Circuit { state: CircuitState; failures: number; openedAt: number; }
const circuits = new Map<string, Circuit>();

function getCircuit(agentId: string): Circuit {
  let c = circuits.get(agentId);
  if (!c) { c = { state: "closed", failures: 0, openedAt: 0 }; circuits.set(agentId, c); }
  return c;
}

function isCircuitOpen(agentId: string): boolean {
  const c = getCircuit(agentId);
  if (c.state === "closed") return false;
  if (c.state === "open" && Date.now() - c.openedAt >= CIRCUIT_RECOVERY_WINDOW_MS) {
    c.state = "half-open";
    logger.info("worker.circuit_half_open", "Circuit breaker half-open — allowing probe task", { agentId });
  }
  return c.state === "open";
}

function recordCircuitSuccess(agentId: string): void {
  const c = getCircuit(agentId);
  if (c.state !== "closed") logger.info("worker.circuit_closed", "Circuit breaker closed after successful task", { agentId });
  c.state = "closed";
  c.failures = 0;
}

function recordCircuitFailure(agentId: string): void {
  const c = getCircuit(agentId);
  if (c.state === "half-open") {
    c.state = "open";
    c.openedAt = Date.now();
    c.failures++;
    logger.error("worker.circuit_opened", "Circuit breaker re-opened after failed probe", { agentId, recoveryWindowMs: CIRCUIT_RECOVERY_WINDOW_MS });
    return;
  }
  c.failures++;
  if (c.state === "closed" && c.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    c.state = "open";
    c.openedAt = Date.now();
    logger.error("worker.circuit_opened", "Circuit breaker opened — agent failing repeatedly", {
      agentId, consecutiveFailures: c.failures, recoveryWindowMs: CIRCUIT_RECOVERY_WINDOW_MS,
    });
  }
}
// ─────────────────────────────────────────────────────────────────────────────
let pollRunning = false;
let shutdownRequested = false;
let pollTimer: NodeJS.Timeout | null = null;
let healthTimer: NodeJS.Timeout | null = null;
let thresholdTimer: NodeJS.Timeout | null = null;
let activePoll: Promise<void> | null = null;
let activeHealthCheck: Promise<void> | null = null;

async function fetchLivePrices(): Promise<string> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_7d_change=true",
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return "";
    const data = await res.json() as Record<string, { usd: number; usd_24h_change: number; usd_7d_change?: number }>;
    const lines = Object.entries(data).map(([coin, d]) =>
      `${coin}: $${d.usd?.toLocaleString()} | 24h: ${d.usd_24h_change?.toFixed(2)}%${d.usd_7d_change !== undefined ? ` | 7d: ${d.usd_7d_change.toFixed(2)}%` : ""}`
    );
    return `\n\nLive market data:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

async function processTasks() {
  // Reset worker-claimed tasks stuck in running longer than the task timeout.
  // HTTP streaming/gateway/manual tasks can legitimately run outside this worker.
  const stuckCutoff = new Date(Date.now() - TASK_TIMEOUT_MS).toISOString();

  // Dead-letter tasks that have hit the stuck-reset limit — they won't recover on their own.
  const deadLettered = getDb().prepare(
    "SELECT task_id FROM tasks WHERE status='running' AND started_by='worker' AND started_at < ? AND stuck_count >= ?"
  ).all(stuckCutoff, MAX_STUCK_RESETS) as { task_id: string }[];
  for (const { task_id } of deadLettered) {
    logger.warn("worker.task_dead_lettered", "Task dead-lettered after too many stuck resets", {
      taskId: task_id,
      maxStuckResets: MAX_STUCK_RESETS,
    });
    if (failTask(task_id, `Task dead-lettered after ${MAX_STUCK_RESETS} stuck resets`)) {
      refundPayment(task_id);
      refundDebitForTask(task_id);
    }
  }

  // Re-queue remaining stuck tasks and increment their reset counter.
  getDb().prepare(
    "UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL, stuck_count=stuck_count+1 WHERE status='running' AND started_by='worker' AND started_at < ? AND stuck_count < ?"
  ).run(stuckCutoff, MAX_STUCK_RESETS);

  void syncToTurso();

  // MCP servers have their own execution path (calls an external MCP endpoint)
  const mcpHandlers: Record<string, (task: string) => Promise<string>> = {};
  for (const server of listMcpServers("active")) {
    mcpHandlers[server.serverId] = createMcpAgentHandler(server.serverId);
  }

  // Gateway providers are handled synchronously in the HTTP layer — exclude them here
  // so their queued tasks aren't accidentally processed as inference tasks
  const gatewayIds = new Set(
    (getDb().prepare("SELECT provider_id FROM gateway_providers").all() as { provider_id: string }[])
      .map((r) => r.provider_id)
  );

  const agents = getAllAgents().filter((a) => !gatewayIds.has(a.agentId));

  // Only fetch live prices if a price agent actually has queued work
  const needsPrices = agents.some(
    (a) => PRICE_AGENTS.has(a.agentId) &&
      getTasksByAgent({ agentId: a.agentId, role: "recipient", status: "queued", limit: 1 }).length > 0
  );
  const livePrices = needsPrices ? await fetchLivePrices() : "";

  const processAgent = async (agent: (typeof agents)[number]) => {
    const mcpHandler = mcpHandlers[agent.agentId];
    // Endpoint agents run their own inference elsewhere, so the worker skips them —
    // EXCEPT orchestrators, which always run their hiring loop here (they think via
    // getProvider, which uses providerEndpoint, not this public endpoint). Without
    // this exception an orchestrator registered with an endpoint would silently
    // never run and every job hired to it would hang queued forever.
    if (agent.endpoint && !mcpHandler && !agent.orchestrator) return;

    if (isCircuitOpen(agent.agentId)) {
      logger.info("worker.circuit_skipped", "Skipping agent — circuit breaker open", { agentId: agent.agentId });
      return;
    }

    const queued = getTasksByAgent({
      agentId: agent.agentId,
      role: "recipient",
      status: "queued",
      limit: 5,
    });

    const getActiveCount = getDb().prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ? AND status = 'running'"
    );
    for (const task of queued) {
      // Concurrency guard: skip if agent already has too many running tasks
      const activeCount = (getActiveCount.get(agent.agentId) as { n: number }).n;
      if (activeCount >= MAX_CONCURRENT_PER_AGENT) {
        logger.info("worker.concurrency_limit", "Agent at concurrency limit, skipping task", {
          agentId: agent.agentId,
          activeCount,
          limit: MAX_CONCURRENT_PER_AGENT,
        });
        return;
      }

      // Orchestrator agents don't answer with one model call — they hire a team.
      // Fire the orchestration in the background (started as "orchestrator" so the
      // "worker"-only stuck reaper leaves it alone) and move on, so the worker's
      // next poll cycles execute the sub-hires it creates. It completes/fails the
      // task itself when the team's work is assembled.
      if (agent.orchestrator) {
        const started = startTask(task.taskId, "orchestrator");
        if (!started) continue;
        logger.info("worker.orchestration_picked", "Orchestrator agent picked up a job", {
          agentId: agent.agentId,
          taskId: task.taskId,
        });
        // Run under the parent's traceId so every specialist it hires inherits the
        // same trace — without this, createHiredTask → resolveTraceId() mints a
        // fresh trace per sub-hire and the flight recorder can't show the team.
        void runWithTraceId(task.traceId ?? task.taskId, () =>
          runOrchestration(agent, task).catch((err) => {
            logger.error("worker.orchestration_failed", "Orchestration crashed", {
              err,
              agentId: agent.agentId,
              taskId: task.taskId,
            });
            if (failTask(task.taskId, err instanceof Error ? err.message : "orchestration failed")) {
              refundPayment(task.taskId);
              refundDebitForTask(task.taskId);
            }
          }),
        );
        continue;
      }

      await runWithTraceId(task.traceId ?? task.taskId, async () => {
        const started = startTask(task.taskId, "worker");
        if (!started) return;
        logger.info("worker.task_picked", "Worker picked up task", {
          agentId: agent.agentId,
          taskId: task.taskId,
          hasMcpHandler: Boolean(mcpHandler),
        });

        try {
          const prices = PRICE_AGENTS.has(agent.agentId) ? livePrices : "";
          const fullMessage = task.task + formatContext(task.context) + prices;

          // Promise.race abandons the loser, it doesn't stop it. For a single
          // model call that's one wasted request; a tool loop is up to seven, so
          // the timeout also trips an abort the loop checks between rounds.
          const abort = new AbortController();
          const taskTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => {
              abort.abort();
              reject(new Error(`Task timed out after ${TASK_TIMEOUT_MS / 1000}s`));
            }, TASK_TIMEOUT_MS).unref()
          );

          // Granted tools: this agent may search, fetch, and call MCP tools before
          // it answers. Resolved per task so a newly synced MCP server is picked up
          // without a restart; unresolvable grants are dropped, never fatal.
          const tools = agent.tools?.length
            ? resolveAgentTools(agent.tools, { agentId: agent.agentId, taskId: task.taskId })
            : null;
          // Every call the agent makes goes into the flight recorder as it happens,
          // so the receipt shows what it did, not just what it said.
          const onToolCall = (ev: ToolCallEvent) => {
            safeAppendTraceEvent({
              traceId: task.traceId ?? task.taskId,
              taskId: task.taskId,
              kind: "tool.call",
              fromAgent: task.toAgent,
              toAgent: null,
              workflowId: task.workflowId ?? null,
              stepIndex: task.stepIndex ?? null,
              inputHash: hashContent(ev.input),
              outputHash: ev.output ? hashContent(ev.output) : null,
              latencyMs: ev.latencyMs,
              meta: {
                tool: ev.tool,
                toolKind: ev.kind,
                ok: ev.ok,
                ...(ev.error ? { error: ev.error.slice(0, 200) } : {}),
              },
            });
          };

          const step = await captureModelStep(() =>
            Promise.race([
              mcpHandler
                ? mcpHandler(fullMessage)
                : hasTools(tools)
                  ? runWithProviderTools(agent, fullMessage, getAgentMaxTokens(agent.agentId), tools, {
                      onToolCall,
                      signal: abort.signal,
                    })
                  : runWithProvider(agent, fullMessage, getAgentMaxTokens(agent.agentId)),
              taskTimeout,
            ]),
          );
          const output = step.result;

          // Flight recorder: the rich per-step event — input/output hashes, the
          // actually-used model, tokens, cost, and latency. Best-effort.
          safeAppendTraceEvent({
            traceId: task.traceId ?? task.taskId,
            taskId: task.taskId,
            kind: "step.model",
            fromAgent: task.fromAgent,
            toAgent: task.toAgent,
            workflowId: task.workflowId ?? null,
            stepIndex: task.stepIndex ?? null,
            inputHash: hashContent(fullMessage),
            outputHash: hashContent(output),
            model: step.model ?? (Boolean(mcpHandler) ? "mcp" : null),
            inputTokens: step.inputTokens || null,
            outputTokens: step.outputTokens || null,
            costUsd: estimateCostUsd(step.model, step.inputTokens, step.outputTokens),
            latencyMs: step.latencyMs,
          });

          if (completeTask(task.taskId, output)) {
            settleCompletedTask(task.taskId);
          }
          recordCircuitSuccess(agent.agentId);
          logger.info("worker.task_processed", "Worker processed task", {
            agentId: agent.agentId,
            taskId: task.taskId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Agent execution failed";
          if (failTask(task.taskId, msg)) {
            refundPayment(task.taskId);
            refundDebitForTask(task.taskId);
          }
          recordCircuitFailure(agent.agentId);
          logger.error("worker.task_failed", "Worker task execution failed", {
            err,
            agentId: agent.agentId,
            taskId: task.taskId,
          });
        }
      });
    }
  };

  // Agents run CONCURRENTLY (each agent's own queue stays sequential): one
  // slow inference must never serialize the whole network behind it.
  await Promise.allSettled(agents.map((a) => processAgent(a)));
}

async function poll() {
  if (shutdownRequested) return;
  if (pollRunning) return;
  pollRunning = true;
  try {
    // Record heartbeat so the health endpoint can confirm the worker is alive.
    getDb()
      .prepare("INSERT OR REPLACE INTO worker_state (key, value, updated_at) VALUES ('last_seen', 'ok', ?)")
      .run(new Date().toISOString());

    try {
      await deliverPendingWebhooks();
    } catch (err) {
      logger.error("webhook.delivery_cycle_failed", "Webhook delivery cycle failed", { err });
    }
    await processTasks();
  } finally {
    pollRunning = false;
  }
}

function runPoll(trigger: "startup" | "interval"): Promise<void> {
  if (shutdownRequested) return Promise.resolve();
  const current = poll().catch((err) => logger.error("worker.poll_failed", "Worker poll failed", { err, trigger }));
  activePoll = current;
  current.finally(() => {
    if (activePoll === current) activePoll = null;
  });
  return current;
}

// Verify registered agent endpoints for x402 compliance and uptime.
async function checkAgentHealth() {
  if (shutdownRequested) return;
  const agents = getAllAgents().filter((a) => a.endpoint);
  for (const agent of agents) {
    if (shutdownRequested) return;
    const result = await verifyAgentEndpoint(agent.agentId, agent.endpoint!);
    recordTaskLatency(agent.agentId, result.latencyMs ?? 5000, result.status !== "unreachable");
  }
}

function runHealthCheck(trigger: "startup" | "interval"): Promise<void> {
  if (shutdownRequested) return Promise.resolve();
  const current = checkAgentHealth()
    .catch((err) => logger.error("worker.health_check_failed", "Agent health check failed", { err, trigger }));
  activeHealthCheck = current;
  current.finally(() => {
    if (activeHealthCheck === current) activeHealthCheck = null;
  });
  return current;
}

function clearTimers(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (thresholdTimer) {
    clearInterval(thresholdTimer);
    thresholdTimer = null;
  }
}

async function waitForActiveWork(): Promise<void> {
  await Promise.allSettled([
    activePoll ?? Promise.resolve(),
    activeHealthCheck ?? Promise.resolve(),
  ]);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownRequested) return;
  shutdownRequested = true;
  clearTimers();

  logger.info("worker.shutdown_started", "Worker shutdown requested", {
    signal,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  const waitForShutdown = waitForActiveWork();
  if (SHUTDOWN_TIMEOUT_MS > 0) {
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS).unref();
    });
    const result = await Promise.race([waitForShutdown.then(() => "done" as const), timeout]);
    if (result === "timeout") {
      logger.error("worker.shutdown_timeout", "Worker shutdown timed out before active work finished", {
        signal,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
        pollRunning,
      });
      await syncToTurso(); // best-effort flush before forced exit
      process.exitCode = 1;
      process.exit();
    }
  } else {
    await waitForShutdown;
  }

  logger.info("worker.shutdown_complete", "Worker shutdown complete", { signal });
  await syncToTurso(); // flush any writes since the last fire-and-forget sync
  process.exit(0);
}

async function main() {
  // Crash guard. The worker does a lot of fire-and-forget async work (void
  // syncToTurso, interval polls, threshold checks); on Node 15+ a single stray
  // unhandled rejection would kill the worker process. Log and keep it alive —
  // mirrors the guard in instrumentation.ts (which only covers the web process).
  process.on("unhandledRejection", (reason) => {
    logger.error("worker.unhandled_rejection", "unhandled rejection (kept alive)", {
      err: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
  });
  process.on("uncaughtException", (err) => {
    logger.error("worker.uncaught_exception", "uncaught exception (kept alive)", {
      err: err.stack ?? err.message,
    });
  });

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn("worker.config_missing", "ANTHROPIC_API_KEY is not set; Anthropic-backed agents will fail until configured");
  }

  logger.info("worker.started", "Axon worker started", {
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
  });

  await startWorkerLoops();
}

// Starts the poll/health/threshold loops. Idempotent. Used by both the standalone
// worker process (main) and the web server's instrumentation hook — so a
// single-container deployment runs the worker in-process, sharing the same DB,
// without needing a separate worker service.
let loopsStarted = false;
export async function startWorkerLoops(): Promise<void> {
  if (loopsStarted) return;
  loopsStarted = true;

  // A fresh boot means every worker-claimed 'running' task is an orphan of the
  // previous process (deploys kill inference mid-flight). Requeue them NOW —
  // waiting for the 10-minute stuck timeout blocks their agents completely at
  // concurrency 1, which reads as "pipeline frozen on step N" after a deploy.
  const reclaimed = getDb()
    .prepare("UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL WHERE status='running' AND started_by='worker'")
    .run().changes;
  if (reclaimed > 0) {
    logger.info("worker.boot_reclaim", "Requeued running tasks orphaned by the previous process", { reclaimed });
  }

  // Orchestrator tasks run their hiring loop in memory, not as a re-runnable
  // worker step, so a process that died mid-orchestration can't resume one — and
  // re-running would double-hire (spend the balance twice). They're also exempt
  // from the stuck reaper (which only touches 'worker'), so nothing else recovers
  // them. Fail + refund the buyer here so the escrow can't sit locked forever.
  const orphanedOrchestrations = getDb()
    .prepare("SELECT task_id FROM tasks WHERE status='running' AND started_by='orchestrator'")
    .all() as { task_id: string }[];
  let reclaimedSubHires = 0;
  for (const { task_id } of orphanedOrchestrations) {
    // Reclaim the sub-hires this orchestration created — its polling loop is gone,
    // so nothing else will. A child still queued (especially one routed to an
    // endpoint specialist that never runs here) is never reaped, so its balance
    // escrow would stay locked forever, permanently shrinking the orchestrator's
    // available balance. failTask no-ops on already-terminal children (no double refund).
    for (const sub of getSubcontractsForParent(task_id)) {
      if (failTask(sub.childTaskId, "parent orchestration interrupted by a restart")) {
        refundPayment(sub.childTaskId);
        refundDebitForTask(sub.childTaskId);
        reclaimedSubHires++;
      }
    }
    if (failTask(task_id, "Orchestration interrupted by a restart")) {
      refundPayment(task_id);
      refundDebitForTask(task_id);
    }
  }
  if (orphanedOrchestrations.length > 0) {
    logger.info("worker.boot_reclaim_orchestrations", "Failed + refunded orchestrations orphaned by the previous process", {
      count: orphanedOrchestrations.length,
      reclaimedSubHires,
    });
  }

  await runPoll("startup");
  pollTimer = setInterval(() => {
    void runPoll("interval");
  }, POLL_INTERVAL_MS);

  void runHealthCheck("startup");
  healthTimer = setInterval(() => {
    void runHealthCheck("interval");
  }, HEALTH_INTERVAL_MS);

  checkAllThresholds();
  thresholdTimer = setInterval(() => {
    checkAllThresholds();
  }, THRESHOLD_INTERVAL_MS);
}

// Run the full standalone worker (own signal + crash handling) only when launched
// directly via `npm run worker`. When the module is imported (e.g. by the web
// server's instrumentation hook) nothing auto-starts — the caller invokes
// startWorkerLoops() so there's no duplicate process or signal-handler conflict.
if (process.env.AXON_WORKER_STANDALONE === "1") {
  main().catch((err) => logger.error("worker.crashed", "Axon worker crashed", { err }));
}
