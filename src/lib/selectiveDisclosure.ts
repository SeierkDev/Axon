// Selective-disclosure receipts — Proof Layer #3.
//
// A receipt proves a task ran and settled. A reproducibility proof proves it ran
// right. Selective disclosure changes what you have to REVEAL to prove a fact
// from a receipt: today it's all-or-nothing — to prove one thing you hand over
// the whole receipt (the counterparty, the price, the hashes). This commits
// every field of a receipt as a leaf in a Merkle tree, so an agent can open ONE
// leaf — "delivered and accepted", "earned at least $500" — and a third party
// verifies it against the receipt's root WITHOUT the rest of the receipt: every
// other field stays an opaque hash in the shared proof.
//
//   - Each field (and each derived predicate, like "earned ≥ $500") is a salted
//     leaf: leaf = SHA-256("L:"||index||":"||field||":"||JSON(value)||":"||salt).
//     The salt = HMAC-SHA256(server key, taskId||":"||field) so unrevealed leaves
//     can't be brute-forced from a small value space (booleans, round amounts).
//   - Internal node = SHA-256("N:"||left||":"||right); an odd node carries up.
//   - A DISCLOSURE opens chosen leaves: {field, value, salt, index, path}. Anyone
//     recomputes the leaf and folds the path to the root — no server, no key.
//   - PREDICATE leaves let you prove a fact without the underlying value: the
//     "earned_at_least_500_usdc = true" leaf can be opened while the exact
//     settlement_amount leaf stays hidden.
//
// Privacy face matches the receipt: predicates are computed by the issuer from
// the same data the receipt already reflects; the disclosed bundle is minimal
// and self-verifying. Deterministic — the same receipt always yields the same
// root, recomputable by the issuer at any time.

import { createHash, createHmac } from "crypto";
import { getPublicReceipt } from "./receipts";

export type LeafValue = string | number | boolean | null;

export interface DisclosableField {
  field: string;
  label: string;
  /** Present in the public catalogue only for derived predicates (booleans). */
  predicate?: boolean;
}

export interface CommitmentMethod {
  algorithm: string;
  note: string;
}

export interface ReceiptCommitment {
  taskId: string;
  root: string;
  disclosable: DisclosableField[];
  /** Predicate field names that are TRUE for this receipt — the actually-provable
   *  facts (so a UI never offers "prove X" for a predicate that's false). */
  facts: string[];
  method: CommitmentMethod;
}

export interface PathStep {
  sibling: string;
  /** Side the sibling sits on: "L" → node = H(sibling, acc); "R" → H(acc, sibling). */
  dir: "L" | "R";
}

export interface Disclosure {
  field: string;
  label: string;
  index: number;
  value: LeafValue;
  salt: string;
  path: PathStep[];
  predicate: boolean;
}

export interface DisclosureBundle {
  taskId: string;
  root: string;
  algorithm: string;
  disclosures: Disclosure[];
}

// ── Canonical value encoding (stable across the wire) ────────────────────────
function canonicalValue(v: LeafValue): string {
  return JSON.stringify(v ?? null);
}

// ── Salts: HMAC-keyed so unrevealed leaves resist brute force ────────────────
// Domain-separated from other SEED_SECRET uses (crypto.ts, mcpServer.ts). Mirrors
// crypto.ts in reading SEED_SECRET (boot config requires it in production).
function saltFor(taskId: string, field: string): string {
  const seed = process.env.SEED_SECRET ?? "";
  return createHmac("sha256", `axon-receipt-disclosure:${seed}`).update(`${taskId}:${field}`).digest("hex");
}

// ── Hashing ──────────────────────────────────────────────────────────────────
export function leafHash(index: number, field: string, value: LeafValue, salt: string): string {
  return createHash("sha256").update(`L:${index}:${field}:${canonicalValue(value)}:${salt}`, "utf8").digest("hex");
}

export function nodeHash(left: string, right: string): string {
  return createHash("sha256").update(`N:${left}:${right}`, "utf8").digest("hex");
}

// Levels of the tree, bottom-up; levels[last] === [root]. Odd node carries up.
function merkleLevels(leaves: string[]): string[][] {
  const levels: string[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]);
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

function merklePath(levels: string[][], index: number): PathStep[] {
  const path: PathStep[] = [];
  let idx = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : idx + 1;
    if (sibIdx < level.length) path.push({ sibling: level[sibIdx], dir: isRight ? "L" : "R" });
    // else: this node was carried up alone — no sibling at this level.
    idx = Math.floor(idx / 2);
  }
  return path;
}

// Fold a leaf up its path to a root — the whole verifier, pure and keyless.
export function foldPath(leaf: string, path: PathStep[]): string {
  let acc = leaf;
  for (const step of path) acc = step.dir === "L" ? nodeHash(step.sibling, acc) : nodeHash(acc, step.sibling);
  return acc;
}

// ── The receipt's leaf set (fixed order → stable indices) ────────────────────
interface LeafSpec {
  field: string;
  label: string;
  value: LeafValue;
  predicate: boolean;
}

const ALGORITHM =
  "leaf = SHA-256('L:'||index||':'||field||':'||JSON(value)||':'||salt); node = SHA-256('N:'||left||':'||right); an odd node carries up; salt = HMAC-SHA256(issuer key, taskId||':'||field). Verify a disclosure by recomputing its leaf and folding the path to the root: for each step, sibling on 'L' → node = H(sibling, acc), on 'R' → H(acc, sibling).";

const METHOD_NOTE =
  "Selective disclosure: every field of the receipt — and a set of derived predicates (delivered/accepted, settled on-chain, output committed, spec verified, earned-at-least thresholds) — is committed as a salted Merkle leaf. An agent opens only the leaves it chooses; the disclosure carries just those facts plus their Merkle paths, and any third party folds each path to the receipt's published root with no key and no access to the rest of the receipt. Predicate leaves prove a fact (e.g. 'earned at least $500') without opening the underlying value leaf (the exact amount). The root is deterministic and recomputable by the issuer from the receipt; salts are issuer-keyed so unrevealed leaves resist brute force.";

// The canonical field registry — the SINGLE source of truth for order, label and
// predicate flag. Order fixes each leaf's index; label + predicate are the
// authoritative meaning of a field and are NEVER trusted from a bundle (an
// attacker-crafted bundle could otherwise relabel a genuine leaf, e.g. open
// "earned_at_least_100_usdc = true" while labelling it "$1,000,000"). verifyBundle
// resolves the human meaning from HERE, not from the bundle.
const FIELD_META: { field: string; label: string; predicate: boolean }[] = [
  // ── raw fields ──────────────────────────────────────────────────────────────
  { field: "task_id", label: "Task ID", predicate: false },
  { field: "from_agent", label: "Requester agent", predicate: false },
  { field: "to_agent", label: "Worker agent", predicate: false },
  { field: "status", label: "Status", predicate: false },
  { field: "created_at", label: "Created at", predicate: false },
  { field: "completed_at", label: "Completed at", predicate: false },
  { field: "payment_terms", label: "Payment terms", predicate: false },
  { field: "spec_hash", label: "Spec hash", predicate: false },
  { field: "output_hash", label: "Output hash", predicate: false },
  { field: "spec_verified", label: "Spec verified", predicate: false },
  { field: "settlement_amount", label: "Settlement amount", predicate: false },
  { field: "settlement_currency", label: "Settlement currency", predicate: false },
  { field: "settlement_signature", label: "Settlement signature", predicate: false },
  { field: "settled_at", label: "Settled at", predicate: false },
  // ── derived predicates (prove the fact without the value) ────────────────────
  { field: "delivered_and_accepted", label: "Delivered and accepted", predicate: true },
  { field: "settled_on_chain", label: "Settled on-chain", predicate: true },
  { field: "output_committed", label: "Output committed (hash on record)", predicate: true },
  { field: "spec_verified_true", label: "Job spec verified against its pinned hash", predicate: true },
  { field: "earned_at_least_100_usdc", label: "Settled for at least $100 (USDC)", predicate: true },
  { field: "earned_at_least_500_usdc", label: "Settled for at least $500 (USDC)", predicate: true },
  { field: "earned_at_least_1000_usdc", label: "Settled for at least $1,000 (USDC)", predicate: true },
];
const META_BY_FIELD = new Map(FIELD_META.map((m) => [m.field, m]));

// Build the ordered leaf specs for a task's receipt, or null if there's no
// receipt. Values are computed here and zipped onto FIELD_META (order === index).
function receiptLeafSpecs(taskId: string): LeafSpec[] | null {
  const r = getPublicReceipt(taskId);
  if (!r) return null;

  const amount = r.settlement?.amount ?? null;
  const currency = r.settlement?.currency ?? null;
  const usdc = currency === "USDC" && typeof amount === "number" ? amount : null;
  const atLeast = (t: number): boolean => usdc !== null && usdc >= t;

  const values: Record<string, LeafValue> = {
    task_id: r.taskId,
    from_agent: r.fromAgent,
    to_agent: r.toAgent,
    status: r.status,
    created_at: r.createdAt,
    completed_at: r.completedAt,
    payment_terms: r.payment,
    spec_hash: r.specHash,
    output_hash: r.outputHash,
    spec_verified: r.specVerified,
    settlement_amount: amount,
    settlement_currency: currency,
    settlement_signature: r.settlement?.signature ?? null,
    settled_at: r.settlement?.settledAt ?? null,
    delivered_and_accepted: r.status === "completed",
    settled_on_chain: !!r.settlement?.signature,
    output_committed: !!r.outputHash,
    spec_verified_true: r.specVerified === true,
    earned_at_least_100_usdc: atLeast(100),
    earned_at_least_500_usdc: atLeast(500),
    earned_at_least_1000_usdc: atLeast(1000),
  };
  // `?? null` never clobbers a legitimate false/0 (nullish only) — it only maps a
  // genuinely-absent field to null.
  return FIELD_META.map((m) => ({ field: m.field, label: m.label, predicate: m.predicate, value: values[m.field] ?? null }));
}

// ── Public API ────────────────────────────────────────────────────────────────

// The receipt's Merkle commitment + the catalogue of what can be disclosed.
// Null when the task has no receipt.
export function buildReceiptCommitment(taskId: string): ReceiptCommitment | null {
  const specs = receiptLeafSpecs(taskId);
  if (!specs) return null;
  const leaves = specs.map((s, i) => leafHash(i, s.field, s.value, saltFor(taskId, s.field)));
  const levels = merkleLevels(leaves);
  const root = levels[levels.length - 1][0];
  return {
    taskId,
    root,
    disclosable: specs.map((s) => ({ field: s.field, label: s.label, predicate: s.predicate })),
    facts: specs.filter((s) => s.predicate && s.value === true).map((s) => s.field),
    method: { algorithm: ALGORITHM, note: METHOD_NOTE },
  };
}

export class DisclosureError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 400,
  ) {
    super(message);
    this.name = "DisclosureError";
  }
}

// Open the chosen fields into a self-verifying, shareable bundle.
export function discloseFields(taskId: string, fields: string[]): DisclosureBundle {
  const specs = receiptLeafSpecs(taskId);
  if (!specs) throw new DisclosureError(`no receipt for task '${taskId}'`, 404);
  if (!Array.isArray(fields) || fields.length === 0) throw new DisclosureError("no fields requested", 400);

  const index = new Map(specs.map((s, i) => [s.field, i]));
  const leaves = specs.map((s, i) => leafHash(i, s.field, s.value, saltFor(taskId, s.field)));
  const levels = merkleLevels(leaves);
  const root = levels[levels.length - 1][0];

  const seen = new Set<string>();
  const disclosures: Disclosure[] = [];
  for (const field of fields) {
    if (seen.has(field)) continue;
    seen.add(field);
    const i = index.get(field);
    if (i === undefined) throw new DisclosureError(`unknown field '${String(field).slice(0, 40)}'`, 400);
    const spec = specs[i];
    disclosures.push({
      field: spec.field,
      label: spec.label,
      index: i,
      value: spec.value,
      salt: saltFor(taskId, spec.field),
      path: merklePath(levels, i),
      predicate: spec.predicate,
    });
  }
  return { taskId, root, algorithm: ALGORITHM, disclosures };
}

// Work bounds for verifying an UNTRUSTED bundle. A genuine receipt has 21 leaves,
// so a bundle opens ≤21 fields with paths of ≤~6 steps; these ceilings are far
// above any honest value and cap adversarial CPU/memory.
const MAX_DISCLOSURES = 64;
const MAX_PATH = 64;

// Every value fed to nodeHash (the root, path siblings) and every salt is a
// SHA-256 / HMAC-SHA-256 digest — canonical lowercase 64-hex. Enforcing that on
// an untrusted bundle keeps nodeHash's ':'-delimited preimage unambiguous (a
// hex string can't contain the delimiter) and rejects malformed input outright.
const HEX64 = /^[0-9a-f]{64}$/;

export interface VerifyResult {
  valid: boolean;
  taskId: string | null;
  root: string | null;
  verified: { field: string; label: string; value: LeafValue; predicate: boolean }[];
  errors: string[];
}

// Pure verification of a bundle against ITS OWN root: recompute each leaf and
// fold its path. Confirms the openings are internally consistent; the route
// additionally re-derives the receipt's real root to confirm authenticity.
export function verifyBundle(bundle: unknown): VerifyResult {
  const errors: string[] = [];
  const b = bundle as Partial<DisclosureBundle> | null;
  if (!b || typeof b !== "object") return { valid: false, taskId: null, root: null, verified: [], errors: ["not an object"] };
  const taskId = typeof b.taskId === "string" ? b.taskId : null;
  const root = typeof b.root === "string" && HEX64.test(b.root) ? b.root : null;
  if (!root) errors.push("missing or malformed root");
  if (!Array.isArray(b.disclosures) || b.disclosures.length === 0) {
    return { valid: false, taskId, root, verified: [], errors: [...errors, "no disclosures"] };
  }
  // Bound the work an untrusted bundle can force: a real receipt has MAX_LEAVES
  // fields and any honest path is a handful of steps. Reject anything past a
  // generous ceiling so a single request can't pin a CPU folding millions of
  // hashes (the per-IP rate limit doesn't cap per-request cost).
  if (b.disclosures.length > MAX_DISCLOSURES) {
    return { valid: false, taskId, root, verified: [], errors: [...errors, "too many disclosures"] };
  }

  const verified: VerifyResult["verified"] = [];
  for (const d of b.disclosures) {
    if (!d || typeof d.field !== "string" || typeof d.index !== "number" || typeof d.salt !== "string" || !HEX64.test(d.salt) || !Array.isArray(d.path)) {
      errors.push(`malformed disclosure${d && typeof d.field === "string" ? ` '${d.field}'` : ""}`);
      continue;
    }
    if (d.path.length > MAX_PATH) {
      errors.push(`field '${d.field}' has an over-long path`);
      continue;
    }
    // Validate every path step BEFORE folding: a well-formed step is a 64-hex
    // sibling with an L/R side. This can't throw on adversarial input and keeps
    // every nodeHash preimage canonical (fixed-width hex, no stray delimiter).
    const pathOk = (d.path as unknown[]).every(
      (s) => !!s && typeof s === "object" && typeof (s as PathStep).sibling === "string" && HEX64.test((s as PathStep).sibling) && ((s as PathStep).dir === "L" || (s as PathStep).dir === "R"),
    );
    if (!pathOk) {
      errors.push(`field '${d.field}' has a malformed path`);
      continue;
    }
    const leaf = leafHash(d.index, d.field, (d.value ?? null) as LeafValue, d.salt);
    const computed = foldPath(leaf, d.path as PathStep[]);
    if (root && computed === root) {
      // The human meaning (label, predicate flag) is resolved from the canonical
      // registry — NEVER from the bundle — so a genuine leaf can't be relabelled.
      const meta = META_BY_FIELD.get(d.field);
      verified.push({
        field: d.field,
        label: meta?.label ?? d.field,
        value: (d.value ?? null) as LeafValue,
        predicate: meta?.predicate ?? false,
      });
    } else {
      errors.push(`field '${d.field}' does not fold to the root`);
    }
  }
  return { valid: errors.length === 0 && verified.length > 0, taskId, root, verified, errors };
}
