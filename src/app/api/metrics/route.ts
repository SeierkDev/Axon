// GET /api/metrics — Prometheus text-format metrics for external scrapers (Grafana, etc.)
//
// Exposes counters and gauges derived from the SQLite DB plus in-process state.
// No authentication required — metrics contain no PII and are expected to be
// scraped by internal monitoring systems. Add network-layer auth (Railway
// internal services, IP allowlist) if you need to restrict access.

import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getHeliusCircuitState } from "@/lib/solana";
import { getGatewayCircuitState, listGatewayProviders } from "@/lib/gateway";

export const runtime = "nodejs";

type MetricType = "counter" | "gauge";

interface Metric {
  name: string;
  help: string;
  type: MetricType;
  samples: { labels?: Record<string, string>; value: number }[];
}

// Prometheus text format requires label values to escape \, ", and \n.
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatMetric(metric: Metric): string {
  const lines: string[] = [
    `# HELP ${metric.name} ${metric.help}`,
    `# TYPE ${metric.name} ${metric.type}`,
  ];
  for (const sample of metric.samples) {
    const labelStr = sample.labels
      ? `{${Object.entries(sample.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`
      : "";
    lines.push(`${metric.name}${labelStr} ${sample.value}`);
  }
  return lines.join("\n");
}

function taskMetrics(): Metric {
  const rows = getDb()
    .prepare("SELECT status, COUNT(*) AS count FROM tasks GROUP BY status")
    .all() as { status: string; count: number }[];

  return {
    name: "axon_tasks_total",
    help: "Total number of tasks by status",
    type: "gauge",
    samples: rows.map((r) => ({ labels: { status: r.status }, value: r.count })),
  };
}

function agentMetrics(): Metric {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS total FROM agents")
    .get() as { total: number };
  return {
    name: "axon_agents_registered",
    help: "Total number of registered agents",
    type: "gauge",
    samples: [{ value: row.total }],
  };
}

function webhookMetrics(): Metric[] {
  const webhookRows = getDb()
    .prepare("SELECT status, COUNT(*) AS count FROM webhooks GROUP BY status")
    .all() as { status: string; count: number }[];

  const deliveryRows = getDb()
    .prepare("SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status")
    .all() as { status: string; count: number }[];

  return [
    {
      name: "axon_webhooks_total",
      help: "Total webhooks by status",
      type: "gauge",
      samples: webhookRows.map((r) => ({ labels: { status: r.status }, value: r.count })),
    },
    {
      name: "axon_webhook_deliveries_total",
      help: "Total webhook deliveries by status",
      type: "gauge",
      samples: deliveryRows.map((r) => ({ labels: { status: r.status }, value: r.count })),
    },
  ];
}

function heliusCircuitMetric(): Metric {
  const { state, consecutiveFailures } = getHeliusCircuitState();
  const stateValue = state === "open" ? 2 : state === "half-open" ? 1 : 0;
  return {
    name: "axon_helius_circuit_state",
    help: "Helius RPC circuit breaker state: 0=closed, 1=half-open, 2=open",
    type: "gauge",
    samples: [
      { labels: { state }, value: stateValue },
      { labels: { metric: "consecutive_failures" }, value: consecutiveFailures },
    ],
  };
}

function gatewayCircuitMetrics(): Metric {
  const providers = listGatewayProviders();
  return {
    name: "axon_gateway_circuit_state",
    help: "Gateway circuit breaker state per provider: 0=closed, 1=half-open, 2=open",
    type: "gauge",
    samples: providers.map((p) => {
      const { state } = getGatewayCircuitState(p.providerId);
      const stateValue = state === "open" ? 2 : state === "half-open" ? 1 : 0;
      return { labels: { provider_id: p.providerId, provider_name: p.name, state }, value: stateValue };
    }),
  };
}

function mppMetrics(): Metric {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(balance_usdc), 0) AS locked_usdc FROM mpp_channels WHERE status = 'open'")
    .get() as { total: number; locked_usdc: number };
  return {
    name: "axon_mpp_channels_open",
    help: "Number of open MPP channels and total locked USDC",
    type: "gauge",
    samples: [
      { labels: { metric: "count" }, value: row.total },
      { labels: { metric: "locked_usdc" }, value: row.locked_usdc },
    ],
  };
}

function uptimeMetric(): Metric {
  return {
    name: "axon_uptime_seconds",
    help: "Process uptime in seconds",
    type: "gauge",
    samples: [{ value: Math.round(process.uptime()) }],
  };
}

export async function GET() {
  const db = getDb();

  // Verify DB is reachable before building metrics
  try {
    db.prepare("SELECT 1").get();
  } catch {
    return new NextResponse("# DB unavailable\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; version=0.0.4" },
    });
  }

  const metrics: Metric[] = [
    taskMetrics(),
    agentMetrics(),
    ...webhookMetrics(),
    heliusCircuitMetric(),
    gatewayCircuitMetrics(),
    mppMetrics(),
    uptimeMetric(),
  ];

  const body = metrics.map(formatMetric).join("\n\n") + "\n";

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
