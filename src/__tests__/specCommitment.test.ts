import { describe, it, expect } from "vitest";
import { hashSpec, verifyTaskSpec } from "@/lib/specCommitment";
import { agencJobSpecHashAsync } from "@/lib/integrations/agenc";
import { createTask } from "@/lib/tasks";
import { getReceipt } from "@/lib/receipts";
import { getDb } from "@/lib/db";

describe("spec commitment (verifiable work)", () => {
  it("pins job specs with AgenC's canonical hash — byte-parity with their SDK", async () => {
    const ours = hashSpec({ fromAgent: "req", toAgent: "wrk", task: "t", context: { lang: "en" }, payment: "1 USDC" });
    // AgenC's own async digest function must produce the identical hash.
    const theirs = await agencJobSpecHashAsync({ from: "req", to: "wrk", task: "t", context: { lang: "en" }, payment: "1 USDC" });
    expect(ours).toBe(theirs);
    expect(ours).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a spec deterministically", () => {
    const spec = { fromAgent: "a", toAgent: "b", task: "summarize this", payment: "1 USDC" };
    expect(hashSpec(spec)).toBe(hashSpec(spec));
    expect(hashSpec(spec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is independent of context key order", () => {
    const h1 = hashSpec({ fromAgent: "a", toAgent: "b", task: "t", context: { x: 1, y: 2 } });
    const h2 = hashSpec({ fromAgent: "a", toAgent: "b", task: "t", context: { y: 2, x: 1 } });
    expect(h1).toBe(h2);
  });

  it("changes when any part of the agreement changes", () => {
    const base = { fromAgent: "a", toAgent: "b", task: "t", payment: "1 USDC" };
    const h = hashSpec(base);
    expect(hashSpec({ ...base, task: "t2" })).not.toBe(h);
    expect(hashSpec({ ...base, payment: "2 USDC" })).not.toBe(h);
    expect(hashSpec({ ...base, toAgent: "c" })).not.toBe(h);
  });

  it("pins the spec hash at task creation and verifies", () => {
    const task = createTask({ fromAgent: "req", toAgent: "wrk", task: "do the thing", payment: "1 USDC" });
    expect(task.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(task.specHash).toBe(hashSpec({ fromAgent: "req", toAgent: "wrk", task: "do the thing", payment: "1 USDC" }));

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
    const task = createTask({ fromAgent: "req", toAgent: "wrk", task: "receipt task", payment: "1 USDC" });
    const receipt = getReceipt(task.taskId);
    expect(receipt.specVerification).toBeTruthy();
    expect(receipt.specVerification!.matches).toBe(true);
    expect(receipt.task!.specHash).toBe(task.specHash);
  });

  it("returns null when verifying a non-existent task", () => {
    expect(verifyTaskSpec("does-not-exist")).toBeNull();
  });
});
