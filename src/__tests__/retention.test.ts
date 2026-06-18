import { describe, it, expect, beforeEach } from "vitest";
import { runRetentionCleanup } from "@/lib/retention";
import { getDb } from "@/lib/db";
import { randomUUID } from "crypto";

const OLD = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
const RECENT = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();  // 5 days ago
function seedParents(db: ReturnType<typeof getDb>) {
  db.prepare(`INSERT OR IGNORE INTO agents
    (agent_id, name, capabilities, public_key, created_at)
    VALUES ('agent-x', 'Test Agent', '[]', 'pk-x', ?)`
  ).run(OLD);

  db.prepare(`INSERT OR IGNORE INTO webhooks
    (webhook_id, agent_id, url, secret, events, created_at)
    VALUES ('wh-1', 'agent-x', 'https://example.com/hook', 'secret', '["task.completed"]', ?)`
  ).run(OLD);
}

function seed() {
  const db = getDb();
  seedParents(db);

  // ── webhook_deliveries ───────────────────────────────────────────────────
  db.prepare(`INSERT INTO webhook_deliveries
    (delivery_id, webhook_id, event_type, payload, status, attempts, next_attempt_at, created_at)
    VALUES (?, 'wh-1', 'task.completed', '{}', 'delivered', 1, ?, ?)`
  ).run("d-old-delivered", OLD, OLD);

  db.prepare(`INSERT INTO webhook_deliveries
    (delivery_id, webhook_id, event_type, payload, status, attempts, next_attempt_at, created_at)
    VALUES (?, 'wh-1', 'task.completed', '{}', 'failed', 3, ?, ?)`
  ).run("d-old-failed", OLD, OLD);

  // pending old delivery — must NOT be deleted
  db.prepare(`INSERT INTO webhook_deliveries
    (delivery_id, webhook_id, event_type, payload, status, attempts, next_attempt_at, created_at)
    VALUES (?, 'wh-1', 'task.completed', '{}', 'pending', 0, ?, ?)`
  ).run("d-old-pending", OLD, OLD);

  // recent delivered — must NOT be deleted
  db.prepare(`INSERT INTO webhook_deliveries
    (delivery_id, webhook_id, event_type, payload, status, attempts, next_attempt_at, created_at)
    VALUES (?, 'wh-1', 'task.completed', '{}', 'delivered', 1, ?, ?)`
  ).run("d-recent-delivered", RECENT, RECENT);

  // ── audit_events ─────────────────────────────────────────────────────────
  db.prepare(`INSERT INTO audit_events
    (audit_id, actor_wallet, action, resource_type, resource_id, created_at)
    VALUES (?, '11111111111111111111111111111111', 'task.create', 'task', 't1', ?)`
  ).run("ae-old", OLD);

  db.prepare(`INSERT INTO audit_events
    (audit_id, actor_wallet, action, resource_type, resource_id, created_at)
    VALUES (?, '11111111111111111111111111111111', 'task.create', 'task', 't2', ?)`
  ).run("ae-recent", RECENT);

  // ── agent_metrics ─────────────────────────────────────────────────────────
  db.prepare(`INSERT INTO agent_metrics
    (agent_id, window_start, total_tasks, completed, failed, total_latency_ms)
    VALUES (?, ?, 10, 9, 1, 5000)`
  ).run("agent-x", OLD);

  db.prepare(`INSERT INTO agent_metrics
    (agent_id, window_start, total_tasks, completed, failed, total_latency_ms)
    VALUES (?, ?, 2, 2, 0, 1000)`
  ).run("agent-x", RECENT);

  // ── spend_alerts ──────────────────────────────────────────────────────────
  db.prepare(`INSERT INTO spend_alerts
    (alert_id, agent_id, threshold_id, amount_usdc, threshold_usdc, window_hours, fired_at)
    VALUES (?, 'agent-x', 'th-1', 50.0, 40.0, 24, ?)`
  ).run("sa-old", OLD);

  db.prepare(`INSERT INTO spend_alerts
    (alert_id, agent_id, threshold_id, amount_usdc, threshold_usdc, window_hours, fired_at)
    VALUES (?, 'agent-x', 'th-1', 50.0, 40.0, 24, ?)`
  ).run("sa-recent", RECENT);

  // ── telegram_posts ────────────────────────────────────────────────────────
  db.prepare(`INSERT INTO telegram_posts (post_id, type, content, created_at) VALUES (?, 'snapshot', 'msg', ?)`)
    .run("tp-old", OLD);

  db.prepare(`INSERT INTO telegram_posts (post_id, type, content, created_at) VALUES (?, 'snapshot', 'msg', ?)`)
    .run("tp-recent", RECENT);

  // ── error_log ─────────────────────────────────────────────────────────────
  db.prepare(`INSERT INTO error_log
    (error_id, ts, level, event, message, created_at)
    VALUES (?, ?, 'error', 'test.error', 'boom', ?)`
  ).run("el-old", OLD, OLD);

  db.prepare(`INSERT INTO error_log
    (error_id, ts, level, event, message, created_at)
    VALUES (?, ?, 'error', 'test.error', 'boom', ?)`
  ).run("el-recent", RECENT, RECENT);

  // ── rate_limit_windows ────────────────────────────────────────────────────
  const expiredMs = Date.now() - 60_000;
  const futureMs  = Date.now() + 60_000;

  db.prepare(`INSERT INTO rate_limit_windows (key, count, reset_at) VALUES (?, 5, ?)`)
    .run("rl-expired", expiredMs);

  db.prepare(`INSERT INTO rate_limit_windows (key, count, reset_at) VALUES (?, 5, ?)`)
    .run("rl-active", futureMs);

  // ── task_progress ─────────────────────────────────────────────────────────
  const oldTaskId    = `task-old-${randomUUID()}`;
  const activeTaskId = `task-active-${randomUUID()}`;

  db.prepare(`INSERT INTO tasks
    (task_id, from_agent, to_agent, task, status, created_at, completed_at)
    VALUES (?, 'a', 'b', 'do something', 'completed', ?, ?)`
  ).run(oldTaskId, OLD, OLD);

  db.prepare(`INSERT INTO tasks
    (task_id, from_agent, to_agent, task, status, created_at)
    VALUES (?, 'a', 'b', 'do something', 'active', ?)`
  ).run(activeTaskId, RECENT);

  db.prepare(`INSERT INTO task_progress (task_id, sequence, message, emitted_at) VALUES (?, 1, 'step 1', ?)`)
    .run(oldTaskId, OLD);

  db.prepare(`INSERT INTO task_progress (task_id, sequence, message, emitted_at) VALUES (?, 1, 'step 1', ?)`)
    .run(activeTaskId, RECENT);

  return { oldTaskId, activeTaskId };
}

function count(table: string, where = "1=1") {
  return (getDb().prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

describe("runRetentionCleanup", () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM webhook_deliveries").run();
    db.prepare("DELETE FROM webhooks").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("DELETE FROM agent_metrics").run();
    db.prepare("DELETE FROM spend_alerts").run();
    db.prepare("DELETE FROM telegram_posts").run();
    db.prepare("DELETE FROM error_log").run();
    db.prepare("DELETE FROM rate_limit_windows").run();
    db.prepare("DELETE FROM task_progress").run();
    db.prepare("DELETE FROM tasks").run();
    db.prepare("DELETE FROM agents WHERE agent_id = 'agent-x'").run();
  });

  it("deletes old resolved webhook deliveries and keeps pending and recent", () => {
    seed();
    runRetentionCleanup();
    expect(count("webhook_deliveries", "delivery_id = 'd-old-delivered'")).toBe(0);
    expect(count("webhook_deliveries", "delivery_id = 'd-old-failed'")).toBe(0);
    expect(count("webhook_deliveries", "delivery_id = 'd-old-pending'")).toBe(1);
    expect(count("webhook_deliveries", "delivery_id = 'd-recent-delivered'")).toBe(1);
  });

  it("deletes old audit events and keeps recent ones", () => {
    seed();
    runRetentionCleanup();
    expect(count("audit_events", "audit_id = 'ae-old'")).toBe(0);
    expect(count("audit_events", "audit_id = 'ae-recent'")).toBe(1);
  });

  it("deletes old agent_metrics windows and keeps recent ones", () => {
    seed();
    runRetentionCleanup();
    expect(count("agent_metrics", "window_start = '" + OLD + "'")).toBe(0);
    expect(count("agent_metrics", "window_start = '" + RECENT + "'")).toBe(1);
  });

  it("deletes old spend_alerts and keeps recent ones", () => {
    seed();
    runRetentionCleanup();
    expect(count("spend_alerts", "alert_id = 'sa-old'")).toBe(0);
    expect(count("spend_alerts", "alert_id = 'sa-recent'")).toBe(1);
  });

  it("deletes old telegram_posts and keeps recent ones", () => {
    seed();
    runRetentionCleanup();
    expect(count("telegram_posts", "post_id = 'tp-old'")).toBe(0);
    expect(count("telegram_posts", "post_id = 'tp-recent'")).toBe(1);
  });

  it("deletes old error_log entries and keeps recent ones", () => {
    seed();
    runRetentionCleanup();
    expect(count("error_log", "error_id = 'el-old'")).toBe(0);
    expect(count("error_log", "error_id = 'el-recent'")).toBe(1);
  });

  it("deletes expired rate_limit_windows and keeps active ones", () => {
    seed();
    runRetentionCleanup();
    expect(count("rate_limit_windows", "key = 'rl-expired'")).toBe(0);
    expect(count("rate_limit_windows", "key = 'rl-active'")).toBe(1);
  });

  it("deletes task_progress for old completed tasks and keeps progress for active tasks", () => {
    const { oldTaskId, activeTaskId } = seed();
    runRetentionCleanup();
    expect(count("task_progress", `task_id = '${oldTaskId}'`)).toBe(0);
    expect(count("task_progress", `task_id = '${activeTaskId}'`)).toBe(1);
  });

  it("returns accurate deleted counts", () => {
    seed();
    const result = runRetentionCleanup();
    expect(result.webhook_deliveries).toBe(2);
    expect(result.audit_events).toBe(1);
    expect(result.agent_metrics).toBe(1);
    expect(result.spend_alerts).toBe(1);
    expect(result.telegram_posts).toBe(1);
    expect(result.error_log).toBe(1);
    expect(result.rate_limit_windows).toBe(1);
    expect(result.task_progress).toBe(1);
  });
});
