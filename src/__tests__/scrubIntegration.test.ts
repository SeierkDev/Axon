// Integration: the scrubber must actually run at the live write choke points, not
// just as a standalone function. These drive the real emitProgress / failTask and
// read the persisted rows back — so a refactor that drops the scrub call fails here.

import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { emitProgress } from "@/lib/progress";
import { failTask } from "@/lib/tasks";
import { randomUUID } from "crypto";

function runningTask(): string {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO agents (agent_id, name, capabilities, public_key, created_at)
     VALUES ('scrub-agent', 'Scrub Agent', '[]', 'pk-scrub', ?)`,
  ).run(now);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, started_at)
     VALUES (?, 'scrub-agent', 'scrub-agent', 'do work', 'running', ?, ?)`,
  ).run(id, now, now);
  return id;
}

describe("secrets scrubber — wired at the write choke points", () => {
  it("emitProgress persists a scrubbed message (task_progress row)", () => {
    const db = getDb();
    const id = runningTask();
    emitProgress(id, "calling api.x.ai with xai-abcdef1234567890ABCDEFGH now");
    const row = db
      .prepare("SELECT message FROM task_progress WHERE task_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(id) as { message: string } | undefined;
    expect(row?.message).toBeDefined();
    expect(row!.message).not.toContain("xai-abcdef");
    expect(row!.message).toContain("[REDACTED");
  });

  it("failTask persists a scrubbed error (feeds the receipt + task.failed webhook)", () => {
    const db = getDb();
    const id = runningTask();
    failTask(id, "auth failed: sk-ant-api03-AAAAAAAAAAAAAAAAAAAA — retry");
    const row = db.prepare("SELECT error FROM tasks WHERE task_id = ?").get(id) as { error: string | null } | undefined;
    expect(row?.error).toBeTruthy();
    expect(row!.error).not.toContain("sk-ant");
    expect(row!.error).toContain("[REDACTED");
  });
});
