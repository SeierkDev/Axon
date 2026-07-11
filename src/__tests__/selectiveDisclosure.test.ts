// Selective-disclosure receipts (Proof Layer #3). Contracts:
// (1) a disclosure of any subset folds to the SAME root the commitment publishes;
// (2) tampering with a disclosed value, salt, index or path breaks verification;
// (3) an unrevealed leaf can't be forged, and predicates prove a fact without
//     opening the underlying value (the amount leaf stays hidden);
// (4) verify() is pure + keyless — it needs only the bundle.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "crypto";
import {
  buildReceiptCommitment,
  discloseFields,
  verifyBundle,
  foldPath,
  leafHash,
  DisclosureError,
} from "@/lib/selectiveDisclosure";
import { createTask, completeTask, startTask } from "@/lib/tasks";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import type { Agent } from "@/sdk/types";

let worker: Agent;
let buyer: Agent;
let settledTaskId: string;

function mkAgent(name: string): Agent {
  const a: Agent = {
    agentId: `sd-${name}-${randomUUID().slice(0, 6)}`,
    name,
    capabilities: ["research"],
    publicKey: `pk-${name}`,
    provider: "anthropic",
    reputation: 0,
    category: "Research",
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a;
}

beforeAll(() => {
  worker = mkAgent("worker");
  buyer = mkAgent("buyer");
  const t = createTask({
    fromAgent: buyer.agentId,
    toAgent: worker.agentId,
    task: "research the thing",
    payment: "750 USDC",
  });
  settledTaskId = t.taskId;
  startTask(settledTaskId);
  completeTask(settledTaskId, "the answer");
  // pin hashes + a settled USDC transaction so predicates are meaningful
  getDb()
    .prepare("UPDATE tasks SET spec_hash = ?, output_hash = ? WHERE task_id = ?")
    .run("a".repeat(64), "b".repeat(64), settledTaskId);
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, currency, status, signature, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, 'USDC', 'settled', ?, ?, ?)`,
    )
    .run(randomUUID(), settledTaskId, buyer.agentId, worker.agentId, 750, "sig-" + randomUUID().slice(0, 8), new Date().toISOString(), new Date().toISOString());
});

describe("commitment", () => {
  it("is deterministic and lists disclosable fields + predicates", () => {
    const c1 = buildReceiptCommitment(settledTaskId)!;
    const c2 = buildReceiptCommitment(settledTaskId)!;
    expect(c1).not.toBeNull();
    expect(c1.root).toBe(c2.root);
    expect(c1.root).toMatch(/^[0-9a-f]{64}$/);
    expect(c1.disclosable.some((d) => d.field === "delivered_and_accepted" && d.predicate)).toBe(true);
    expect(c1.disclosable.some((d) => d.field === "earned_at_least_500_usdc" && d.predicate)).toBe(true);
  });

  it("returns null for a task with no receipt", () => {
    expect(buildReceiptCommitment("does-not-exist")).toBeNull();
  });

  it("facts lists only the TRUE predicates (never false ones)", () => {
    const c = buildReceiptCommitment(settledTaskId)!;
    expect(c.facts).toContain("delivered_and_accepted");
    expect(c.facts).toContain("earned_at_least_500_usdc");
    expect(c.facts).not.toContain("earned_at_least_1000_usdc"); // 750 < 1000
    // every listed fact really is a predicate that's true
    for (const f of c.facts) expect(c.disclosable.find((d) => d.field === f)?.predicate).toBe(true);
  });
});

describe("disclosure + verification", () => {
  it("any subset folds to the receipt's root and verifies", () => {
    const root = buildReceiptCommitment(settledTaskId)!.root;
    const bundle = discloseFields(settledTaskId, ["delivered_and_accepted", "earned_at_least_500_usdc"]);
    expect(bundle.root).toBe(root);
    const res = verifyBundle(bundle);
    expect(res.valid).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.verified.map((v) => v.field).sort()).toEqual(["delivered_and_accepted", "earned_at_least_500_usdc"]);
    // the true predicates carry value true
    for (const v of res.verified) expect(v.value).toBe(true);
  });

  it("a single-field disclosure verifies (the whole point)", () => {
    const b = discloseFields(settledTaskId, ["delivered_and_accepted"]);
    expect(verifyBundle(b).valid).toBe(true);
  });

  it("proves 'earned ≥ $500' without the amount leaf traveling in the bundle", () => {
    const b = discloseFields(settledTaskId, ["earned_at_least_500_usdc"]);
    // the exact amount is NOT in the disclosed set
    expect(b.disclosures.some((d) => d.field === "settlement_amount")).toBe(false);
    const res = verifyBundle(b);
    expect(res.valid).toBe(true);
    expect(res.verified[0].value).toBe(true);
  });

  it("thresholds are honest: below the bar is committed false", () => {
    const b = discloseFields(settledTaskId, ["earned_at_least_1000_usdc"]);
    const res = verifyBundle(b);
    expect(res.valid).toBe(true); // it still verifies…
    expect(res.verified[0].value).toBe(false); // …as false
  });

  it("rejects an unknown field", () => {
    expect(() => discloseFields(settledTaskId, ["totally_made_up"])).toThrow(DisclosureError);
  });
});

describe("tamper resistance", () => {
  it("flipping a disclosed value breaks the fold", () => {
    const b = discloseFields(settledTaskId, ["earned_at_least_1000_usdc"]);
    b.disclosures[0].value = true; // claim you cleared $1,000 when you didn't
    const res = verifyBundle(b);
    expect(res.valid).toBe(false);
    expect(res.errors.join(" ")).toMatch(/does not fold/);
  });

  it("swapping the salt breaks the fold", () => {
    const b = discloseFields(settledTaskId, ["delivered_and_accepted"]);
    b.disclosures[0].salt = "f".repeat(64);
    expect(verifyBundle(b).valid).toBe(false);
  });

  it("corrupting a path sibling breaks the fold", () => {
    const b = discloseFields(settledTaskId, ["status"]);
    if (b.disclosures[0].path.length > 0) b.disclosures[0].path[0].sibling = "0".repeat(64);
    expect(verifyBundle(b).valid).toBe(false);
  });

  it("a spoofed label/predicate on a GENUINE leaf can't mislead — verify uses the canonical registry", () => {
    const b = discloseFields(settledTaskId, ["earned_at_least_100_usdc"]);
    // the leaf is genuine (folds fine), but the bundle lies about what it means
    b.disclosures[0].label = "Earned at least $1,000,000";
    b.disclosures[0].predicate = false;
    const res = verifyBundle(b);
    expect(res.valid).toBe(true); // the crypto still checks out…
    // …but the reported meaning comes from the registry, not the bundle
    expect(res.verified[0].label).not.toContain("1,000,000");
    expect(res.verified[0].label).toContain("$100");
    expect(res.verified[0].predicate).toBe(true);
  });

  it("a leaf minted under a different index does not fold", () => {
    const b = discloseFields(settledTaskId, ["status"]);
    const d = b.disclosures[0];
    // forge a leaf claiming index 0 but keep the real path → mismatch
    const forged = leafHash(999, d.field, d.value, d.salt);
    expect(foldPath(forged, d.path)).not.toBe(b.root);
  });
});

describe("verifyBundle is defensive", () => {
  it("rejects non-objects and empty disclosures", () => {
    expect(verifyBundle(null).valid).toBe(false);
    expect(verifyBundle({ taskId: "x", root: "y", disclosures: [] }).valid).toBe(false);
  });

  it("never throws on adversarial path steps — returns invalid instead", () => {
    const root = "a".repeat(64);
    const bad = [null, 123, { dir: "L" }, { sibling: "z".repeat(64) }, { sibling: 5, dir: "R" }];
    for (const step of bad) {
      const bundle = { taskId: "t", root, disclosures: [{ field: "status", index: 0, salt: "0".repeat(64), value: "x", path: [step] }] };
      let res: ReturnType<typeof verifyBundle> | undefined;
      expect(() => { res = verifyBundle(bundle); }).not.toThrow();
      expect(res!.valid).toBe(false);
    }
  });

  it("rejects non-canonical node-hash inputs (root, salt, sibling must be 64-hex)", () => {
    // start from a genuine, verifying bundle, then break each hex field in turn
    const good = discloseFields(settledTaskId, ["status"]);
    expect(verifyBundle(good).valid).toBe(true);

    const badRoot = { ...good, root: "not-hex" };
    expect(verifyBundle(badRoot).valid).toBe(false);
    expect(verifyBundle(badRoot).errors.join(" ")).toMatch(/malformed root/);

    const badSalt = JSON.parse(JSON.stringify(good));
    badSalt.disclosures[0].salt = "Z".repeat(64); // right length, not hex
    expect(verifyBundle(badSalt).valid).toBe(false);

    const badSibling = JSON.parse(JSON.stringify(good));
    if (badSibling.disclosures[0].path.length > 0) {
      badSibling.disclosures[0].path[0].sibling = "g".repeat(64); // 'g' is not hex
      expect(verifyBundle(badSibling).valid).toBe(false);
    }
  });

  it("bounds the work: too many disclosures or an over-long path are rejected fast, not folded", () => {
    const root = "a".repeat(64);
    // a giant disclosures array is rejected without folding any of it
    const many = { taskId: "t", root, disclosures: Array.from({ length: 5000 }, () => ({ field: "status", index: 0, salt: "0".repeat(64), value: "x", path: [] })) };
    const r1 = verifyBundle(many);
    expect(r1.valid).toBe(false);
    expect(r1.errors.join(" ")).toMatch(/too many disclosures/);
    // a single disclosure carrying a million-step path is rejected, not walked
    const longPath = { taskId: "t", root, disclosures: [{ field: "status", index: 0, salt: "0".repeat(64), value: "x", path: Array.from({ length: 1_000_000 }, () => ({ sibling: "0".repeat(64), dir: "R" as const })) }] };
    const r2 = verifyBundle(longPath);
    expect(r2.valid).toBe(false);
    expect(r2.errors.join(" ")).toMatch(/over-long path/);
  });
});
