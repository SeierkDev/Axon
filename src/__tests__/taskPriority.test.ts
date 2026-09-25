// Where a task sits in the queue.
//
// Priority is only priority if it changes the order work is taken in, so these test the ordering
// rather than the column. The other half is that it must not change anything for the people who
// hold nothing: a queue of zeroes has to come out in exactly the order it always did.

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createTask, getTasksByAgent } from "@/lib/tasks";

const AGENT = "queue-agent";

const hire = (task: string, priority?: number) =>
  createTask({ fromAgent: "anonymous", toAgent: AGENT, task, priority });

describe("queue order", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM tasks WHERE to_agent = ?").run(AGENT);
  });

  it("puts a holder's work ahead of work queued before it", async () => {
    hire("queued first, holds nothing");
    hire("queued second, holds nothing");
    hire("queued last, but holds $AXON", 3);

    const queue = getTasksByAgent({ agentId: AGENT, role: "recipient", status: "queued", limit: 10 });
    expect(queue[0]!.task).toContain("holds $AXON");
  });

  it("keeps newest-first among equals, exactly as before", async () => {
    // Everything defaults to 0, so a queue nobody has priority in must be untouched by this.
    hire("older");
    hire("newer");

    const queue = getTasksByAgent({ agentId: AGENT, role: "recipient", status: "queued", limit: 10 });
    expect(queue.map((t) => t.task)).toEqual(["newer", "older"]);
  });

  it("orders the tiers against each other", async () => {
    hire("base", 0);
    hire("operator", 3);
    hire("holder", 1);
    hire("builder", 2);

    const queue = getTasksByAgent({ agentId: AGENT, role: "recipient", status: "queued", limit: 10 });
    expect(queue.map((t) => t.task)).toEqual(["operator", "builder", "holder", "base"]);
  });

  it("defaults to the back of the queue", async () => {
    hire("explicit zero", 0);
    hire("no priority given");

    const queue = getTasksByAgent({ agentId: AGENT, role: "recipient", status: "queued", limit: 10 });
    // Both are 0, so recency decides and nothing has been promoted by omission.
    expect(queue[0]!.task).toBe("no priority given");
  });

  it("clamps a nonsense priority instead of letting it jump the whole queue", async () => {
    hire("sane", 3);
    hire("absurd", 999_999);

    const queue = getTasksByAgent({ agentId: AGENT, role: "recipient", status: "queued", limit: 10 });
    const absurd = queue.find((t) => t.task === "absurd")!;
    const db = getDb().prepare("SELECT priority FROM tasks WHERE task_id = ?").get(absurd.taskId) as { priority: number };
    expect(db.priority).toBe(10);
  });

  it("refuses a negative priority rather than burying somebody", async () => {
    hire("negative", -5);
    const row = getDb()
      .prepare("SELECT priority FROM tasks WHERE to_agent = ? AND task = ?")
      .get(AGENT, "negative") as { priority: number };

    // Priority may only ever move work up. Nothing in this system should be able to push a task
    // behind the default.
    expect(row.priority).toBe(0);
  });

  it("does not reorder anything that is not queued", async () => {
    // Priority is about waiting. Finished work is history and its ordering is a different question.
    const a = createTask({ fromAgent: "anonymous", toAgent: AGENT, task: "done low", priority: 0 });
    const b = createTask({ fromAgent: "anonymous", toAgent: AGENT, task: "done high", priority: 3 });
    const db = getDb();
    db.prepare("UPDATE tasks SET status = 'completed' WHERE task_id IN (?, ?)").run(a.taskId, b.taskId);

    const done = getTasksByAgent({ agentId: AGENT, role: "recipient", status: "completed", limit: 10 });
    expect(done.length).toBe(2);
  });
});
