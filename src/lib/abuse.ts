// Phase 9: abuse reporting and moderation queue.
//
// Any authenticated agent can report another for spam, scam, non-delivery, or
// abuse. Reports enter a queue (open -> reviewing -> resolved/dismissed) that a
// moderator works through. Reporting is attributable (the reporter's identity is
// recorded) to discourage frivolous reports; moderation actions are gated by a
// separate moderator secret.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { getAgentById } from "./agents";
import { logger } from "./logger";

export const ABUSE_REASONS = ["spam", "scam", "non_delivery", "abuse", "other"] as const;
export type AbuseReason = (typeof ABUSE_REASONS)[number];

export const ABUSE_STATUSES = ["open", "reviewing", "resolved", "dismissed"] as const;
export type AbuseStatus = (typeof ABUSE_STATUSES)[number];

export interface AbuseReport {
  reportId: string;
  targetAgent: string;
  reporter?: string;
  reason: AbuseReason;
  details?: string;
  status: AbuseStatus;
  resolution?: string;
  createdAt: string;
  resolvedAt?: string;
}

interface AbuseRow {
  report_id: string;
  target_agent: string;
  reporter: string | null;
  reason: AbuseReason;
  details: string | null;
  status: AbuseStatus;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

function rowToReport(row: AbuseRow): AbuseReport {
  return {
    reportId: row.report_id,
    targetAgent: row.target_agent,
    reporter: row.reporter ?? undefined,
    reason: row.reason,
    details: row.details ?? undefined,
    status: row.status,
    resolution: row.resolution ?? undefined,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

export type AbuseErrorCode = "INVALID" | "NOT_FOUND" | "DUPLICATE";
export type FileReportResult =
  | { success: true; report: AbuseReport }
  | { success: false; error: string; code: AbuseErrorCode };

export interface FileReportInput {
  targetAgent: string;
  reporter?: string;
  reason: AbuseReason;
  details?: string;
}

export function fileReport(input: FileReportInput): FileReportResult {
  const target = getAgentById(input.targetAgent);
  if (!target) {
    return { success: false, error: `Agent '${input.targetAgent}' not found`, code: "NOT_FOUND" };
  }
  if (!ABUSE_REASONS.includes(input.reason)) {
    return { success: false, error: `reason must be one of: ${ABUSE_REASONS.join(", ")}`, code: "INVALID" };
  }
  // The reporter is identified by wallet — block an owner reporting their own agent.
  if (input.reporter && target.walletAddress && input.reporter === target.walletAddress) {
    return { success: false, error: "An agent's owner cannot report their own agent", code: "INVALID" };
  }

  const db = getDb();
  // One open report per reporter+target, so a single reporter can't flood an
  // agent's moderation queue.
  if (input.reporter) {
    const existing = db
      .prepare("SELECT 1 FROM abuse_reports WHERE target_agent = ? AND reporter = ? AND status IN ('open','reviewing') LIMIT 1")
      .get(input.targetAgent, input.reporter);
    if (existing) {
      return { success: false, error: "You already have an open report against this agent", code: "DUPLICATE" };
    }
  }
  const reportId = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    "INSERT INTO abuse_reports (report_id, target_agent, reporter, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)"
  ).run(reportId, input.targetAgent, input.reporter ?? null, input.reason, input.details ?? null, createdAt);
  void syncToTurso();
  logger.info("abuse.reported", "Abuse report filed", { reportId, targetAgent: input.targetAgent, reason: input.reason });
  return { success: true, report: getReportById(reportId)! };
}

export function getReportById(reportId: string): AbuseReport | null {
  const row = getDb().prepare("SELECT * FROM abuse_reports WHERE report_id = ?").get(reportId) as AbuseRow | undefined;
  return row ? rowToReport(row) : null;
}

const MAX_REPORTS_RETURNED = 200;

export function listReports(opts: { status?: AbuseStatus; targetAgent?: string; limit?: number } = {}): AbuseReport[] {
  const requested = Number.isFinite(opts.limit) ? (opts.limit as number) : 100;
  const limit = Math.min(Math.max(requested, 1), MAX_REPORTS_RETURNED);
  const rows = getDb()
    .prepare(
      `SELECT * FROM abuse_reports
        WHERE (? IS NULL OR status = ?)
          AND (? IS NULL OR target_agent = ?)
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(opts.status ?? null, opts.status ?? null, opts.targetAgent ?? null, opts.targetAgent ?? null, limit) as AbuseRow[];
  return rows.map(rowToReport);
}

export function getOpenReportCount(targetAgent: string): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM abuse_reports WHERE target_agent = ? AND status IN ('open','reviewing')")
      .get(targetAgent) as { n: number }
  ).n;
}

export type ResolveResult =
  | { success: true; report: AbuseReport }
  | { success: false; error: string; code: AbuseErrorCode };

// Moderator action: move a report to a terminal state with a note, or back to
// 'reviewing' while it's being worked.
export function resolveReport(reportId: string, status: AbuseStatus, resolution?: string): ResolveResult {
  const report = getReportById(reportId);
  if (!report) return { success: false, error: "Report not found", code: "NOT_FOUND" };
  if (!ABUSE_STATUSES.includes(status)) {
    return { success: false, error: `status must be one of: ${ABUSE_STATUSES.join(", ")}`, code: "INVALID" };
  }

  // Only a terminal state carries a resolution + timestamp; moving back to
  // open/reviewing clears them so an "open" report never holds a stale note.
  const terminal = status === "resolved" || status === "dismissed";
  getDb()
    .prepare("UPDATE abuse_reports SET status = ?, resolution = ?, resolved_at = ? WHERE report_id = ?")
    .run(status, terminal ? (resolution ?? report.resolution ?? null) : null, terminal ? new Date().toISOString() : null, reportId);
  void syncToTurso();
  logger.info("abuse.moderated", "Abuse report moderated", { reportId, status });
  return { success: true, report: getReportById(reportId)! };
}
