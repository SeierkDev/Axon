import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { logger } from "./logger";
import { queueWebhookEvent } from "./webhooks";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpendThreshold {
  thresholdId: string;
  agentId: string;
  thresholdUsdc: number;
  windowHours: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SpendAlert {
  alertId: string;
  agentId: string;
  thresholdId: string;
  amountUsdc: number;
  thresholdUsdc: number;
  windowHours: number;
  firedAt: string;
}

export interface ThresholdStatus {
  threshold: SpendThreshold;
  windowSpendUsdc: number;
  lastAlert: SpendAlert | null;
}

interface ThresholdRow {
  threshold_id: string;
  agent_id: string;
  threshold_usdc: number;
  window_hours: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface AlertRow {
  alert_id: string;
  agent_id: string;
  threshold_id: string;
  amount_usdc: number;
  threshold_usdc: number;
  window_hours: number;
  fired_at: string;
}

function rowToThreshold(row: ThresholdRow): SpendThreshold {
  return {
    thresholdId: row.threshold_id,
    agentId: row.agent_id,
    thresholdUsdc: row.threshold_usdc,
    windowHours: row.window_hours,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAlert(row: AlertRow): SpendAlert {
  return {
    alertId: row.alert_id,
    agentId: row.agent_id,
    thresholdId: row.threshold_id,
    amountUsdc: row.amount_usdc,
    thresholdUsdc: row.threshold_usdc,
    windowHours: row.window_hours,
    firedAt: row.fired_at,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function getWindowSpend(agentId: string, windowHours: number): number {
  const row = getDb()
    .prepare(`
      SELECT COALESCE(SUM(amount_sol), 0) AS spent
      FROM transactions
      WHERE from_agent = ? AND currency = 'USDC' AND status = 'completed'
        AND settled_at >= datetime('now', '-' || ? || ' hours')
    `)
    .get(agentId, windowHours) as { spent: number };
  return Math.round(row.spent * 10000) / 10000;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getThreshold(agentId: string): SpendThreshold | null {
  const row = getDb()
    .prepare("SELECT * FROM spend_thresholds WHERE agent_id = ?")
    .get(agentId) as ThresholdRow | undefined;
  return row ? rowToThreshold(row) : null;
}

export function setThreshold(
  agentId: string,
  thresholdUsdc: number,
  windowHours: number,
  enabled: boolean
): SpendThreshold {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT threshold_id FROM spend_thresholds WHERE agent_id = ?")
    .get(agentId) as { threshold_id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE spend_thresholds
      SET threshold_usdc = ?, window_hours = ?, enabled = ?, updated_at = ?
      WHERE agent_id = ?
    `).run(thresholdUsdc, windowHours, enabled ? 1 : 0, now, agentId);
  } else {
    db.prepare(`
      INSERT INTO spend_thresholds (threshold_id, agent_id, threshold_usdc, window_hours, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), agentId, thresholdUsdc, windowHours, enabled ? 1 : 0, now, now);
  }

  return getThreshold(agentId)!;
}

export function deleteThreshold(agentId: string): void {
  getDb().prepare("DELETE FROM spend_thresholds WHERE agent_id = ?").run(agentId);
}

export function getThresholdStatus(agentId: string): ThresholdStatus | null {
  const threshold = getThreshold(agentId);
  if (!threshold) return null;

  const windowSpendUsdc = getWindowSpend(agentId, threshold.windowHours);
  const lastAlertRow = getDb()
    .prepare("SELECT * FROM spend_alerts WHERE agent_id = ? ORDER BY fired_at DESC LIMIT 1")
    .get(agentId) as AlertRow | undefined;

  return {
    threshold,
    windowSpendUsdc,
    lastAlert: lastAlertRow ? rowToAlert(lastAlertRow) : null,
  };
}

export function getRecentAlerts(limit = 100): SpendAlert[] {
  const rows = getDb()
    .prepare("SELECT * FROM spend_alerts ORDER BY fired_at DESC LIMIT ?")
    .all(limit) as AlertRow[];
  return rows.map(rowToAlert);
}

// Checks a single agent's threshold and fires an alert if exceeded.
// Deduplicates: only one alert per window period.
export function checkThreshold(agentId: string): void {
  const threshold = getThreshold(agentId);
  if (!threshold || !threshold.enabled) return;

  const windowSpend = getWindowSpend(agentId, threshold.windowHours);
  if (windowSpend < threshold.thresholdUsdc) return;

  const alreadyFired = getDb()
    .prepare(`
      SELECT 1 FROM spend_alerts
      WHERE agent_id = ? AND fired_at >= datetime('now', '-' || ? || ' hours')
      LIMIT 1
    `)
    .get(agentId, threshold.windowHours);

  if (alreadyFired) return;

  const now = new Date().toISOString();
  const alertId = randomUUID();

  getDb().prepare(`
    INSERT INTO spend_alerts (alert_id, agent_id, threshold_id, amount_usdc, threshold_usdc, window_hours, fired_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(alertId, agentId, threshold.thresholdId, windowSpend, threshold.thresholdUsdc, threshold.windowHours, now);

  logger.warn("spend.threshold_exceeded", "Agent spend threshold exceeded", {
    agentId,
    windowSpendUsdc: windowSpend,
    thresholdUsdc: threshold.thresholdUsdc,
    windowHours: threshold.windowHours,
  });

  queueWebhookEvent(agentId, "spend.threshold_exceeded", {
    alertId,
    agentId,
    windowSpendUsdc: windowSpend,
    thresholdUsdc: threshold.thresholdUsdc,
    windowHours: threshold.windowHours,
    firedAt: now,
  });
}

export function checkAllThresholds(): void {
  const rows = getDb()
    .prepare("SELECT agent_id FROM spend_thresholds WHERE enabled = 1")
    .all() as { agent_id: string }[];

  for (const row of rows) {
    try {
      checkThreshold(row.agent_id);
    } catch (err) {
      logger.error("spend.threshold_check_failed", "Failed to check spend threshold", {
        agentId: row.agent_id,
        err,
      });
    }
  }
}
