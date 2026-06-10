import { getTasksByAgent, startTask, completeTask, failTask } from "../lib/tasks";
import { refundPayment, releasePayment } from "../lib/payments";
import { refundDebitForTask } from "../lib/mpp";
import { getAllAgents } from "../lib/agents";
import { getDb } from "../lib/db";
import { listMcpServers, createMcpAgentHandler } from "../lib/mcp";
import { deliverPendingWebhooks } from "../lib/webhooks";
import { recordTaskLatency } from "../lib/metrics";
import { formatContext } from "../lib/formatContext";
import { runWithProvider } from "../lib/providers";
import { verifyAgentEndpoint } from "../lib/verification";
import { logger } from "../lib/logger";

// Agents that append live market prices to their task message
const PRICE_AGENTS = new Set(["crypto-agent", "trading-agent"]);

const POLL_INTERVAL_MS = 15_000;
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.AXON_WORKER_SHUTDOWN_TIMEOUT_MS ?? "25000", 10);
let pollRunning = false;
let shutdownRequested = false;
let pollTimer: NodeJS.Timeout | null = null;
let healthTimer: NodeJS.Timeout | null = null;
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
  // Reset only worker-claimed tasks stuck in 'running' for over 5 minutes.
  // HTTP streaming/gateway/manual tasks can legitimately run outside this worker.
  const stuckCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  getDb().prepare(
    "UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL WHERE status='running' AND started_by='worker' AND started_at < ?"
  ).run(stuckCutoff);

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

  for (const agent of agents) {
    const mcpHandler = mcpHandlers[agent.agentId];
    if (agent.endpoint && !mcpHandler) {
      continue;
    }

    const queued = getTasksByAgent({
      agentId: agent.agentId,
      role: "recipient",
      status: "queued",
      limit: 5,
    });

    for (const task of queued) {
      const started = startTask(task.taskId, "worker");
      if (!started) continue;
      logger.info("worker.task_picked", "Worker picked up task", {
        agentId: agent.agentId,
        taskId: task.taskId,
        hasMcpHandler: Boolean(mcpHandler),
      });

      try {
        // Combine task text, user-supplied context, and live prices into one message
        const prices = PRICE_AGENTS.has(agent.agentId) ? livePrices : "";
        const fullMessage = task.task + formatContext(task.context) + prices;

        const output = mcpHandler
          ? await mcpHandler(fullMessage)
          : await runWithProvider(agent, fullMessage);

        if (completeTask(task.taskId, output)) {
          releasePayment(task.taskId);
        }
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
        logger.error("worker.task_failed", "Worker task execution failed", {
          err,
          agentId: agent.agentId,
          taskId: task.taskId,
        });
      }
    }
  }
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
      process.exitCode = 1;
      process.exit();
    }
  } else {
    await waitForShutdown;
  }

  logger.info("worker.shutdown_complete", "Worker shutdown complete", { signal });
  process.exit(0);
}

async function main() {
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

  await runPoll("startup");
  pollTimer = setInterval(() => {
    void runPoll("interval");
  }, POLL_INTERVAL_MS);

  void runHealthCheck("startup");
  healthTimer = setInterval(() => {
    void runHealthCheck("interval");
  }, HEALTH_INTERVAL_MS);
}

main().catch((err) => logger.error("worker.crashed", "Axon worker crashed", { err }));
