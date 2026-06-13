import { randomUUID } from "crypto";
import { getDb } from "./db";

type LogFields = Record<string, unknown>;

function inferSource(event: string, requestId: string | undefined): string | null {
  if (event.startsWith("worker.")) return "worker";
  if (event.startsWith("webhook.")) return "webhook";
  if (requestId) return "api";
  return null;
}

export function recordErrorLog(
  level: "error" | "warn",
  event: string,
  message: string,
  requestId: string | undefined,
  traceId: string | undefined,
  fields: LogFields | undefined
): void {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const agentId = (fields?.agentId ?? fields?.agent_id ?? null) as string | null;
    const taskId = (fields?.taskId ?? fields?.task_id ?? null) as string | null;
    const source = inferSource(event, requestId);
    const details = fields ? JSON.stringify(fields) : null;

    db.prepare(`
      INSERT INTO error_log (error_id, ts, level, event, message, source, agent_id, task_id, trace_id, request_id, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), now, level, event, message,
      source, agentId, taskId,
      traceId ?? null, requestId ?? null,
      details, now
    );
  } catch {
    // Never let DB errors break logging
  }
}
