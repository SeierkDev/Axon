import { randomUUID } from "crypto";
import { getDb } from "./db";
import { logger } from "./logger";

export type QuorumStatus = "pending" | "completed" | "failed";

export interface QuorumTask {
  quorumId: string;
  fromAgent: string;
  taskContent: string;
  threshold: number;
  agentCount: number;
  status: QuorumStatus;
  acceptedResult?: string;
  acceptedAgent?: string;
  createdAt: string;
  completedAt?: string;
}

export interface QuorumResult {
  taskId: string;
  agentId: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: string;
  completedAt?: string;
}

interface QuorumRow {
  quorum_id: string;
  from_agent: string;
  task_content: string;
  threshold: number;
  agent_count: number;
  status: string;
  accepted_result: string | null;
  accepted_agent: string | null;
  created_at: string;
  completed_at: string | null;
}

function rowToQuorum(row: QuorumRow): QuorumTask {
  return {
    quorumId: row.quorum_id,
    fromAgent: row.from_agent,
    taskContent: row.task_content,
    threshold: row.threshold,
    agentCount: row.agent_count,
    status: row.status as QuorumStatus,
    acceptedResult: row.accepted_result ?? undefined,
    acceptedAgent: row.accepted_agent ?? undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export function createQuorumRecord(opts: {
  fromAgent: string;
  taskContent: string;
  threshold: number;
  agentCount: number;
}): QuorumTask {
  const db = getDb();
  const quorumId = randomUUID();
  const createdAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO quorum_tasks (quorum_id, from_agent, task_content, threshold, agent_count, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(quorumId, opts.fromAgent, opts.taskContent, opts.threshold, opts.agentCount, createdAt);

  return getQuorumTask(quorumId)!;
}

export function getQuorumTask(quorumId: string): QuorumTask | null {
  const row = getDb()
    .prepare("SELECT * FROM quorum_tasks WHERE quorum_id = ?")
    .get(quorumId) as QuorumRow | undefined;
  return row ? rowToQuorum(row) : null;
}

export function getQuorumResults(quorumId: string): QuorumResult[] {
  const rows = getDb().prepare(`
    SELECT task_id, to_agent, status, output, completed_at
    FROM tasks
    WHERE quorum_id = ?
    ORDER BY created_at ASC
  `).all(quorumId) as {
    task_id: string;
    to_agent: string;
    status: string;
    output: string | null;
    completed_at: string | null;
  }[];

  return rows.map((r) => ({
    taskId: r.task_id,
    agentId: r.to_agent,
    status: r.status as QuorumResult["status"],
    result: r.output ?? undefined,
    completedAt: r.completed_at ?? undefined,
  }));
}

// Called by tasks.ts after a child task completes.
// Checks whether the quorum threshold has been reached and picks a winner.
// Winner = highest-reputation completed agent; ties broken by earliest completion.
export function onChildTaskCompleted(quorumId: string): void {
  const db = getDb();

  const quorum = db.prepare(
    "SELECT * FROM quorum_tasks WHERE quorum_id = ? AND status = 'pending'"
  ).get(quorumId) as QuorumRow | undefined;
  if (!quorum) return;

  const { completed_count } = db.prepare(
    "SELECT COUNT(*) AS completed_count FROM tasks WHERE quorum_id = ? AND status = 'completed'"
  ).get(quorumId) as { completed_count: number };

  if (completed_count < quorum.threshold) return;

  const winner = db.prepare(`
    SELECT t.task_id, t.to_agent, t.output
    FROM tasks t
    LEFT JOIN agents a ON a.agent_id = t.to_agent
    WHERE t.quorum_id = ? AND t.status = 'completed'
    ORDER BY COALESCE(a.reputation, 0) DESC, t.completed_at ASC
    LIMIT 1
  `).get(quorumId) as { task_id: string; to_agent: string; output: string } | undefined;

  if (!winner) return;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE quorum_tasks
    SET status = 'completed', accepted_result = ?, accepted_agent = ?, completed_at = ?
    WHERE quorum_id = ? AND status = 'pending'
  `).run(winner.output, winner.to_agent, now, quorumId);

  logger.info("quorum.completed", "Quorum reached threshold — result accepted", {
    quorumId,
    acceptedAgent: winner.to_agent,
    completedCount: completed_count,
    threshold: quorum.threshold,
  });
}

// Called by tasks.ts after a child task fails.
// Marks the quorum as failed if the remaining agents can no longer meet the threshold.
export function onChildTaskFailed(quorumId: string): void {
  const db = getDb();

  const quorum = db.prepare(
    "SELECT * FROM quorum_tasks WHERE quorum_id = ? AND status = 'pending'"
  ).get(quorumId) as QuorumRow | undefined;
  if (!quorum) return;

  const { failed_count } = db.prepare(
    "SELECT COUNT(*) AS failed_count FROM tasks WHERE quorum_id = ? AND status = 'failed'"
  ).get(quorumId) as { failed_count: number };

  // Still achievable if remaining non-failed agents >= threshold
  const maxPossible = quorum.agent_count - failed_count;
  if (maxPossible >= quorum.threshold) return;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE quorum_tasks SET status = 'failed', completed_at = ?
    WHERE quorum_id = ? AND status = 'pending'
  `).run(now, quorumId);

  logger.warn("quorum.failed", "Quorum failed — too many agent failures to meet threshold", {
    quorumId,
    failedCount: failed_count,
    agentCount: quorum.agent_count,
    threshold: quorum.threshold,
  });
}
