// Removing records is the one operation that has to be narrow, so the guards are the test.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { pruneOutageTasks } from "@/lib/pruneOutageTasks";

const AUTH_ERR = '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}';
let n = 0;

function task(status: string, error: string | null) {
  const id = `pr-${++n}`;
  getDb()
    .prepare(
      `INSERT INTO tasks (task_id, from_agent, to_agent, task, status, error, completed_at, created_at)
       VALUES (?, 'a', 'b', 't', ?, ?, ?, ?)`,
    )
    .run(id, status, error, new Date().toISOString(), new Date().toISOString());
  return id;
}
function payFor(taskId: string) {
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status,
         incoming_signature, fee_amount, currency, created_at)
       VALUES (?, ?, 'a', 'b', 0.0002, 'completed', NULL, 0, 'ETH', ?)`,
    )
    .run(`ptx-${++n}`, taskId, new Date().toISOString());
}
const alive = (id: string) =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_id = ?").get(id) as { n: number }).n === 1;

describe("pruning the outage", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM transactions").run();
    getDb().prepare("DELETE FROM tasks").run();
  });

  it("removes a task that failed on the platform's own key", () => {
    const id = task("failed", AUTH_ERR);
    const r = pruneOutageTasks(getDb(), { apply: true });
    expect(r.removedTasks).toBe(1);
    expect(alive(id)).toBe(false);
  });

  it("changes nothing on a dry run, and reports the same scope", () => {
    const id = task("failed", AUTH_ERR);
    const dry = pruneOutageTasks(getDb(), { apply: false });
    expect(dry.inScope).toBe(1);
    expect(dry.applied).toBe(false);
    expect(dry.removedTasks).toBe(0);
    expect(alive(id)).toBe(true);
  });

  it("keeps every failure that was not this incident", () => {
    const rate = task("failed", "429 rate_limit_error");
    const timeout = task("failed", "Request timed out after 60000ms");
    const model = task("failed", "The model `gpt5.5` does not exist");
    const none = task("failed", null);

    pruneOutageTasks(getDb(), { apply: true });

    for (const id of [rate, timeout, model, none]) expect(alive(id)).toBe(true);
  });

  it("never removes a completed task, whatever is in its error column", () => {
    const done = task("completed", AUTH_ERR);
    pruneOutageTasks(getDb(), { apply: true });
    expect(alive(done)).toBe(true);
  });

  it("never removes a task that had money attached to it", () => {
    const paid = task("failed", AUTH_ERR);
    payFor(paid);
    const free = task("failed", AUTH_ERR);

    const r = pruneOutageTasks(getDb(), { apply: true });

    expect(alive(paid)).toBe(true); // a payment is a record, not noise
    expect(alive(free)).toBe(false);
    expect(r.removedTasks).toBe(1);
  });

  it("leaves nothing pointing at a task that is gone", () => {
    const id = task("failed", AUTH_ERR);
    getDb()
      .prepare("INSERT INTO task_progress (task_id, sequence, message, emitted_at) VALUES (?, 1, 'x', ?)")
      .run(id, new Date().toISOString());

    pruneOutageTasks(getDb(), { apply: true });

    const orphans = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM task_progress p
         LEFT JOIN tasks t ON t.task_id = p.task_id WHERE t.task_id IS NULL`,
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it("is a no-op when there is nothing from the incident", () => {
    task("failed", "429 rate_limit_error");
    const r = pruneOutageTasks(getDb(), { apply: true });
    expect(r.inScope).toBe(0);
    expect(r.removedTasks).toBe(0);
  });
});
