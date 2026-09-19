import { describe, it, expect } from "vitest";
import { hashSpec, verifyTaskSpec } from "@/lib/specCommitment";
import { createTask } from "@/lib/tasks";
import { getReceipt } from "@/lib/receipts";
import { getDb } from "@/lib/db";

describe("spec commitment (verifiable work)", () => {
  // The digest is SHA-256 over the same canonical JSON the trace hash chain uses, so anyone
  // holding a receipt can recompute it without this codebase.
  it("pins a job spec as sha256 over canonical JSON", async () => {
    const { createHash } = await import("crypto");
    const { canonicalStringify } = await import("@/lib/traceEvents");
    const spec = { fromAgent: "req", toAgent: "wrk", task: "t", context: { lang: "en" }, payment: "0.001 ETH" };
    const expected = createHash("sha256")
      .update(canonicalStringify({ from: "req", to: "wrk", task: "t", context: { lang: "en" }, payment: "0.001 ETH" }), "utf8")
      .digest("hex");
    expect(hashSpec(spec)).toBe(expected);
    expect(hashSpec(spec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a spec deterministically", () => {
    const spec = { fromAgent: "a", toAgent: "b", task: "summarize this", payment: "0.001 ETH" };
    expect(hashSpec(spec)).toBe(hashSpec(spec));
    expect(hashSpec(spec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of context key order", () => {
    const h1 = hashSpec({ fromAgent: "a", toAgent: "b", task: "t", context: { x: 1, y: 2 } });
    const h2 = hashSpec({ fromAgent: "a", toAgent: "b", task: "t", context: { y: 2, x: 1 } });
    expect(h1).toBe(h2);
  });

  it("changes when any part of the agreement changes", () => {
    const base = { fromAgent: "a", toAgent: "b", task: "t", payment: "0.001 ETH" };
    const h = hashSpec(base);
    expect(hashSpec({ ...base, task: "t2" })).not.toBe(h);
    expect(hashSpec({ ...base, payment: "0.002 ETH" })).not.toBe(h);
    expect(hashSpec({ ...base, toAgent: "c" })).not.toBe(h);
  });

  it("pins the spec hash at task creation and verifies", () => {
    const task = createTask({ fromAgent: "req", toAgent: "wrk", task: "do the thing", payment: "0.001 ETH" });
    expect(task.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(task.specHash).toBe(hashSpec({ fromAgent: "req", toAgent: "wrk", task: "do the thing", payment: "0.001 ETH" }));

    const v = verifyTaskSpec(task.taskId)!;
    expect(v.matches).toBe(true);
    expect(v.committed).toBe(v.recomputed);
  });

  it("detects tampering — altered rules no longer match the committed hash", () => {
    const task = createTask({ fromAgent: "req", toAgent: "wrk", task: "original rules" });
    expect(verifyTaskSpec(task.taskId)!.matches).toBe(true);

    // Someone edits the task text after the fact without re-committing.
    getDb().prepare("UPDATE tasks SET task = ? WHERE task_id = ?").run("sneakily changed rules", task.taskId);

    const v = verifyTaskSpec(task.taskId)!;
    expect(v.matches).toBe(false);
    expect(v.committed).not.toBe(v.recomputed);
  });

  it("surfaces spec verification on the receipt", () => {
    const task = createTask({ fromAgent: "req", toAgent: "wrk", task: "receipt task", payment: "0.001 ETH" });
    const receipt = getReceipt(task.taskId);
    expect(receipt.specVerification).toBeTruthy();
    expect(receipt.specVerification!.matches).toBe(true);
    expect(receipt.task!.specHash).toBe(task.specHash);
  });

  it("returns null when verifying a non-existent task", () => {
    expect(verifyTaskSpec("does-not-exist")).toBeNull();
  });
});
