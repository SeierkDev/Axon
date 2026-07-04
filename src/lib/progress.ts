import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { emitAxonEvent } from "./eventBus";
import { safeAppendTraceEvent, traceIdForTask, hashContent } from "./traceEvents";

export interface TaskProgressEntry {
  id: number;
  taskId: string;
  sequence: number;
  message: string;
  emittedAt: string;
}

interface ProgressRow {
  id: number;
  task_id: string;
  sequence: number;
  message: string;
  emitted_at: string;
}

function rowToEntry(row: ProgressRow): TaskProgressEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    message: row.message,
    emittedAt: row.emitted_at,
  };
}

// Emits a progress update for a running task.
// Returns null if the task doesn't exist or is not in 'running' status.
export function emitProgress(taskId: string, message: string): TaskProgressEntry | null {
  const db = getDb();

  const taskRow = db
    .prepare("SELECT task_id, to_agent, from_agent, status FROM tasks WHERE task_id = ?")
    .get(taskId) as { task_id: string; to_agent: string; from_agent: string; status: string } | undefined;

  if (!taskRow || taskRow.status !== "running") return null;

  const entry = db.transaction((): TaskProgressEntry => {
    const { max_seq } = db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM task_progress WHERE task_id = ?")
      .get(taskId) as { max_seq: number };

    const sequence = max_seq + 1;
    const emittedAt = new Date().toISOString();

    const result = db
      .prepare("INSERT INTO task_progress (task_id, sequence, message, emitted_at) VALUES (?, ?, ?, ?)")
      .run(taskId, sequence, message, emittedAt);

    return {
      id: Number(result.lastInsertRowid),
      taskId,
      sequence,
      message,
      emittedAt,
    };
  })();

  emitAxonEvent({
    type: "task.progress",
    data: {
      taskId,
      agentId: taskRow.to_agent,
      fromAgent: taskRow.from_agent,
      message,
      sequence: entry.sequence,
    },
  });

  // Flight recorder: commit the progress update into the trace's hash chain. The
  // message is stored as a hash only — the chain proves what was reported without
  // exposing content on the public timeline.
  safeAppendTraceEvent({
    traceId: traceIdForTask(taskId),
    taskId,
    kind: "progress",
    fromAgent: taskRow.from_agent,
    toAgent: taskRow.to_agent,
    outputHash: hashContent(message),
    meta: { sequence: entry.sequence },
  });

  logger.info("task.progress", "Task progress emitted", { taskId, sequence: entry.sequence, message });
  void syncToTurso();

  return entry;
}

export function getTaskProgress(taskId: string): TaskProgressEntry[] {
  return (
    getDb()
      .prepare("SELECT * FROM task_progress WHERE task_id = ? ORDER BY sequence ASC")
      .all(taskId) as ProgressRow[]
  ).map(rowToEntry);
}
