import type { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { getDb } from "./db";
import { getClientIp } from "./rateLimit";

export type AuditAction =
  | "agent.created"
  | "budget.upserted"
  | "webhook.created"
  | "webhook.deleted"
  | "webhook.retried"
  | "gateway.created"
  | "gateway.deleted"
  | "mcp_server.created"
  | "mcp_server.deleted"
  | "mcp_server.synced"
  | "mpp_channel.opened"
  | "mpp_channel.topped_up"
  | "mpp_channel.closed"
  | "quorum.created";

export interface AuditEvent {
  auditId: string;
  actorWallet: string;
  actorKeyId?: string;
  action: AuditAction | string;
  resourceType: string;
  resourceId: string;
  ownerAgentId?: string;
  ownerWallet?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface AuditRow {
  audit_id: string;
  actor_wallet: string;
  actor_key_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  owner_agent_id: string | null;
  owner_wallet: string | null;
  ip: string | null;
  metadata: string | null;
  created_at: string;
}

function rowToAuditEvent(row: AuditRow): AuditEvent {
  return {
    auditId: row.audit_id,
    actorWallet: row.actor_wallet,
    actorKeyId: row.actor_key_id ?? undefined,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ownerAgentId: row.owner_agent_id ?? undefined,
    ownerWallet: row.owner_wallet ?? undefined,
    ip: row.ip ?? undefined,
    metadata: row.metadata ? (() => { try { return JSON.parse(row.metadata) as Record<string, unknown>; } catch { return undefined; } })() : undefined,
    createdAt: row.created_at,
  };
}

export function recordAuditEvent(opts: {
  req: NextRequest;
  actor: { walletAddress: string; keyId?: string };
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  ownerAgentId?: string;
  ownerWallet?: string;
  metadata?: Record<string, unknown>;
}): AuditEvent {
  const auditId = randomUUID();
  const createdAt = new Date().toISOString();
  const metadata = opts.metadata ? JSON.stringify(opts.metadata) : null;

  getDb().prepare(`
    INSERT INTO audit_events
      (audit_id, actor_wallet, actor_key_id, action, resource_type, resource_id, owner_agent_id, owner_wallet, ip, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    auditId,
    opts.actor.walletAddress,
    opts.actor.keyId ?? null,
    opts.action,
    opts.resourceType,
    opts.resourceId,
    opts.ownerAgentId ?? null,
    opts.ownerWallet ?? opts.actor.walletAddress,
    getClientIp(opts.req),
    metadata,
    createdAt
  );

  return getAuditEventById(auditId)!;
}

export function getAuditEventById(auditId: string): AuditEvent | null {
  const row = getDb()
    .prepare("SELECT * FROM audit_events WHERE audit_id = ?")
    .get(auditId) as AuditRow | undefined;
  return row ? rowToAuditEvent(row) : null;
}

export function listAuditEvents(opts: {
  ownerWallet?: string;
  ownerAgentId?: string;
  limit?: number;
}): AuditEvent[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const clauses: string[] = [];
  const args: unknown[] = [];

  if (opts.ownerWallet) {
    clauses.push("owner_wallet = ?");
    args.push(opts.ownerWallet);
  }
  if (opts.ownerAgentId) {
    clauses.push("owner_agent_id = ?");
    args.push(opts.ownerAgentId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = getDb()
    .prepare(`SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, limit) as AuditRow[];

  return rows.map(rowToAuditEvent);
}
