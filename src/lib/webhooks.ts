import { randomUUID, randomBytes, createHmac } from "crypto";
import { getDb } from "./db";
import { publicHttpFetch } from "./urlSecurity";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
  "task.queued",
  "task.completed",
  "task.failed",
  "payment.settled",
  "payment.refunded",
  "spend.threshold_exceeded",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 5;
const MAX_PERMANENT_FAILURES = 3;
// Retry delays in ms: immediate → 1 min → 5 min → 30 min → 2 hr
const RETRY_DELAYS_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
const DELIVERY_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Webhook {
  webhookId: string;
  agentId: string;
  url: string;
  events: WebhookEventType[];
  status: "active" | "inactive";
  failureCount: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  disabledAt?: string;
  disabledReason?: string;
  createdAt: string;
}

export interface WebhookDelivery {
  deliveryId: string;
  webhookId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  responseStatus?: number;
  responseBody?: string;
  createdAt: string;
}

interface WebhookRow {
  webhook_id: string;
  agent_id: string;
  url: string;
  secret: string;
  events: string;
  status: string;
  failure_count: number | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
  created_at: string;
}

interface DeliveryRow {
  delivery_id: string;
  webhook_id: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  response_status: number | null;
  response_body: string | null;
  created_at: string;
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    webhookId: row.webhook_id,
    agentId: row.agent_id,
    url: row.url,
    events: (() => { try { return JSON.parse(row.events) as WebhookEventType[]; } catch { return []; } })(),
    status: row.status as Webhook["status"],
    failureCount: row.failure_count ?? 0,
    lastSuccessAt: row.last_success_at ?? undefined,
    lastFailureAt: row.last_failure_at ?? undefined,
    disabledAt: row.disabled_at ?? undefined,
    disabledReason: row.disabled_reason ?? undefined,
    createdAt: row.created_at,
  };
}

function rowToDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    deliveryId: row.delivery_id,
    webhookId: row.webhook_id,
    eventType: row.event_type as WebhookEventType,
    payload: (() => { try { return JSON.parse(row.payload) as Record<string, unknown>; } catch { return {}; } })(),
    status: row.status as WebhookDelivery["status"],
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    responseStatus: row.response_status ?? undefined,
    responseBody: row.response_body ?? undefined,
    createdAt: row.created_at,
  };
}

// ── Webhook CRUD ──────────────────────────────────────────────────────────────

export function createWebhook(opts: {
  agentId: string;
  url: string;
  events: WebhookEventType[];
}): Webhook {
  const db = getDb();
  const webhookId = randomUUID();
  const secret = randomBytes(32).toString("hex"); // 256-bit secret
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO webhooks (webhook_id, agent_id, url, secret, events, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(webhookId, opts.agentId, opts.url, secret, JSON.stringify(opts.events), createdAt);

  return getWebhookById(webhookId)!;
}

export function getWebhookById(webhookId: string): Webhook | null {
  const row = getDb()
    .prepare("SELECT * FROM webhooks WHERE webhook_id = ?")
    .get(webhookId) as WebhookRow | undefined;
  return row ? rowToWebhook(row) : null;
}

// Returns the secret for a webhook — only exposed at creation time via the API
export function getWebhookSecret(webhookId: string): string | null {
  const row = getDb()
    .prepare("SELECT secret FROM webhooks WHERE webhook_id = ?")
    .get(webhookId) as { secret: string } | undefined;
  return row?.secret ?? null;
}

export function listWebhooks(agentId: string): Webhook[] {
  const rows = getDb()
    .prepare("SELECT * FROM webhooks WHERE agent_id = ? ORDER BY created_at DESC")
    .all(agentId) as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function deleteWebhook(webhookId: string): void {
  getDb().prepare("DELETE FROM webhooks WHERE webhook_id = ?").run(webhookId);
}

export function getDeliveriesByWebhook(webhookId: string, limit = 20): WebhookDelivery[] {
  const rows = getDb()
    .prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(webhookId, limit) as DeliveryRow[];
  return rows.map(rowToDelivery);
}

export function getAgentIdByDeliveryId(deliveryId: string): string | null {
  const row = getDb()
    .prepare(`
      SELECT w.agent_id FROM webhook_deliveries d
      JOIN webhooks w ON w.webhook_id = d.webhook_id
      WHERE d.delivery_id = ?
    `)
    .get(deliveryId) as { agent_id: string } | undefined;

  return row?.agent_id ?? null;
}

export function getWebhookIdByDeliveryId(deliveryId: string): string | null {
  const row = getDb()
    .prepare("SELECT webhook_id FROM webhook_deliveries WHERE delivery_id = ?")
    .get(deliveryId) as { webhook_id: string } | undefined;
  return row?.webhook_id ?? null;
}

// Returns all failed deliveries across every webhook registered to an agent.
export function getFailedDeliveries(agentId: string, limit = 50): WebhookDelivery[] {
  const rows = getDb()
    .prepare(`
      SELECT d.* FROM webhook_deliveries d
      JOIN webhooks w ON w.webhook_id = d.webhook_id
      WHERE w.agent_id = ? AND d.status = 'failed'
      ORDER BY d.last_attempt_at DESC LIMIT ?
    `)
    .all(agentId, limit) as DeliveryRow[];
  return rows.map(rowToDelivery);
}

// Resets a failed delivery to pending so it will be retried on the next worker cycle.
// Returns false if the delivery doesn't exist or is not in 'failed' state.
export function retryDelivery(deliveryId: string): boolean {
  const db = getDb();
  const changes = db
    .prepare(`
      UPDATE webhook_deliveries
      SET status = 'pending', next_attempt_at = ?, attempts = 0
      WHERE delivery_id = ? AND status = 'failed'
    `)
    .run(new Date().toISOString(), deliveryId).changes;
  if (changes > 0) {
    db.prepare(`
      UPDATE webhooks
      SET status = 'active',
          failure_count = 0,
          disabled_at = NULL,
          disabled_reason = NULL
      WHERE webhook_id = (
        SELECT webhook_id FROM webhook_deliveries WHERE delivery_id = ?
      )
    `).run(deliveryId);
  }
  return changes > 0;
}

function markWebhookSuccess(webhookId: string, now: string): void {
  getDb().prepare(`
    UPDATE webhooks
    SET failure_count = 0,
        last_success_at = ?,
        disabled_at = NULL,
        disabled_reason = NULL
    WHERE webhook_id = ?
  `).run(now, webhookId);
}

function markWebhookPermanentFailure(webhookId: string, now: string, reason: string): void {
  const row = getDb().prepare(`
    UPDATE webhooks
    SET failure_count = failure_count + 1,
        last_failure_at = ?
    WHERE webhook_id = ?
    RETURNING failure_count
  `).get(now, webhookId) as { failure_count: number } | undefined;

  const failureCount = row?.failure_count ?? 0;
  if (failureCount < MAX_PERMANENT_FAILURES) return;

  getDb().prepare(`
    UPDATE webhooks
    SET status = 'inactive',
        disabled_at = ?,
        disabled_reason = ?
    WHERE webhook_id = ?
  `).run(now, reason, webhookId);

  logger.error("webhook.disabled", "Webhook disabled after repeated permanent delivery failures", {
    webhookId,
    failureCount,
    maxPermanentFailures: MAX_PERMANENT_FAILURES,
    reason,
  });
}

// ── Event queueing ────────────────────────────────────────────────────────────
// Called synchronously from tasks.ts / payments.ts when an event occurs.
// Writes delivery rows to the DB; actual HTTP delivery happens in the worker.

export function queueWebhookEvent(
  agentId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>
): void {
  const db = getDb();
  const webhooks = db
    .prepare("SELECT * FROM webhooks WHERE agent_id = ? AND status = 'active'")
    .all(agentId) as WebhookRow[];

  if (webhooks.length === 0) return;

  const now = new Date().toISOString();
  const payload = JSON.stringify({
    event: eventType,
    timestamp: Math.floor(Date.now() / 1000),
    data,
  });

  const insert = db.prepare(`
    INSERT INTO webhook_deliveries
      (delivery_id, webhook_id, event_type, payload, status, attempts, next_attempt_at, created_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
  `);

  let queued = 0;
  for (const webhook of webhooks) {
    let events: string[];
    try { events = JSON.parse(webhook.events) as string[]; } catch {
      logger.warn("webhook.events_parse_failed", "Skipped webhook with unparseable events filter", { webhookId: webhook.webhook_id });
      continue;
    }
    if (!events.includes(eventType)) continue;
    insert.run(randomUUID(), webhook.webhook_id, eventType, payload, now, now);
    queued += 1;
  }

  if (queued > 0) {
    logger.debug("webhook.queued", "Webhook deliveries queued", {
      agentId,
      eventType,
      deliveries: queued,
    });
  }
}

// ── Delivery ──────────────────────────────────────────────────────────────────

function sign(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

async function sendDelivery(
  delivery: DeliveryRow & { url: string; secret: string }
): Promise<void> {
  const db = getDb();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign(delivery.secret, timestamp, delivery.payload);
  const now = new Date().toISOString();

  // Record the attempt immediately before the HTTP call
  db.prepare(
    "UPDATE webhook_deliveries SET attempts = attempts + 1, last_attempt_at = ? WHERE delivery_id = ?"
  ).run(now, delivery.delivery_id);

  let responseStatus: number | undefined;
  let responseBody: string | undefined;

  try {
    const res = await publicHttpFetch(delivery.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Axon-Signature": `sha256=${signature}`,
        "X-Axon-Event": delivery.event_type,
        "X-Axon-Delivery": delivery.delivery_id,
        "X-Axon-Timestamp": String(timestamp),
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      maxResponseBytes: 64_000,
    });
    responseStatus = res.status;
    responseBody = (await res.text()).slice(0, MAX_RESPONSE_BODY);
  } catch (err) {
    responseBody = (err instanceof Error ? err.message : "network error").slice(0, MAX_RESPONSE_BODY);
  }

  const succeeded = responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300;
  const newAttempts = delivery.attempts + 1;

  if (succeeded) {
    db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'delivered', response_status = ?, response_body = ?
      WHERE delivery_id = ?
    `).run(responseStatus, responseBody ?? null, delivery.delivery_id);
    markWebhookSuccess(delivery.webhook_id, now);
    logger.info("webhook.delivered", "Webhook delivered", {
      deliveryId: delivery.delivery_id,
      webhookId: delivery.webhook_id,
      eventType: delivery.event_type,
      responseStatus,
      attempts: newAttempts,
    });
    return;
  }

  if (newAttempts >= MAX_ATTEMPTS) {
    db.prepare(`
      UPDATE webhook_deliveries
      SET status = 'failed', response_status = ?, response_body = ?
      WHERE delivery_id = ?
    `).run(responseStatus ?? null, responseBody ?? null, delivery.delivery_id);
    markWebhookPermanentFailure(
      delivery.webhook_id,
      now,
      responseStatus !== undefined ? `HTTP ${responseStatus}` : (responseBody ?? "network error")
    );
    logger.warn("webhook.failed", "Webhook delivery failed permanently", {
      deliveryId: delivery.delivery_id,
      webhookId: delivery.webhook_id,
      eventType: delivery.event_type,
      responseStatus,
      responseBody,
      attempts: newAttempts,
    });
    return;
  }

  // Schedule the next retry using the exponential backoff table
  const delayMs = RETRY_DELAYS_MS[newAttempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
  db.prepare(`
    UPDATE webhook_deliveries
    SET next_attempt_at = ?, response_status = ?, response_body = ?
    WHERE delivery_id = ?
  `).run(nextAttemptAt, responseStatus ?? null, responseBody ?? null, delivery.delivery_id);
  logger.warn("webhook.retry_scheduled", "Webhook delivery retry scheduled", {
    deliveryId: delivery.delivery_id,
    webhookId: delivery.webhook_id,
    eventType: delivery.event_type,
    responseStatus,
    responseBody,
    attempts: newAttempts,
    nextAttemptAt,
  });
}

// Called by the worker on each poll cycle to flush pending deliveries
export async function deliverPendingWebhooks(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const pending = db.prepare(`
    SELECT d.*, w.url, w.secret
    FROM webhook_deliveries d
    JOIN webhooks w ON w.webhook_id = d.webhook_id
    WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND w.status = 'active'
    LIMIT 20
  `).all(now) as (DeliveryRow & { url: string; secret: string })[];

  if (pending.length > 0) {
    logger.debug("webhook.flush", "Flushing pending webhook deliveries", {
      deliveries: pending.length,
    });
  }

  await Promise.allSettled(pending.map(sendDelivery));
}
