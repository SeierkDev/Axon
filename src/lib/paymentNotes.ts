// Phase 6 (Marketplace Trust Layer): dispute and refund notes attached to receipts.
//
// A receipt records WHAT happened to a paid task (task -> payment -> webhooks).
// These notes record WHY around the money: the reason a payment was refunded, or
// a dispute one of the parties wants attached to the record. They show up on the
// task's receipt so a settlement can be understood after the fact instead of
// being a bare "refunded" status with no context.

import { getDb } from "./db";

export type PaymentNoteKind = "dispute" | "refund" | "note";
export const PAYMENT_NOTE_KINDS: PaymentNoteKind[] = ["dispute", "refund", "note"];
const MAX_NOTE_LEN = 2000;

export interface PaymentNote {
  id: number;
  taskId: string;
  kind: PaymentNoteKind;
  note: string;
  author: string | null; // wallet that attached it; null = system-generated
  createdAt: string;
}

// Self-heal the table if the migrations dir wasn't bundled on the host (same
// safeguard the Build/endpoint-uptime tables use). Runs its CREATE once per process.
let tableEnsured = false;
function ensureTable(): void {
  if (tableEnsured) return;
  try {
    getDb().exec(
      `CREATE TABLE IF NOT EXISTS payment_notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        note        TEXT NOT NULL,
        author      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_payment_notes_task ON payment_notes (task_id, created_at);`,
    );
    tableEnsured = true;
  } catch {
    /* best-effort */
  }
}

// Attach a note to a task's payment. Throws on invalid input (so an API route can
// surface a 400); the kind must be one of PAYMENT_NOTE_KINDS.
export function addPaymentNote(
  taskId: string,
  kind: PaymentNoteKind,
  note: string,
  author: string | null = null,
): PaymentNote {
  ensureTable();
  const text = note.trim().slice(0, MAX_NOTE_LEN);
  if (!taskId) throw new Error("taskId is required");
  if (!text) throw new Error("note text is required");
  if (!PAYMENT_NOTE_KINDS.includes(kind)) throw new Error(`invalid note kind: ${kind}`);
  const createdAt = new Date().toISOString();
  const res = getDb()
    .prepare("INSERT INTO payment_notes (task_id, kind, note, author, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(taskId, kind, text, author, createdAt);
  return { id: Number(res.lastInsertRowid), taskId, kind, note: text, author, createdAt };
}

// System-generated refund note. Best-effort — never let note-keeping break a refund.
export function recordRefundNote(taskId: string, reason?: string | null): void {
  try {
    const detail = (reason ?? "").trim();
    addPaymentNote(taskId, "refund", detail ? `Refunded: ${detail}` : "Payment refunded to sender", null);
  } catch {
    /* best-effort */
  }
}

// All notes for a task, oldest first.
export function getPaymentNotes(taskId: string): PaymentNote[] {
  ensureTable();
  if (!taskId) return [];
  try {
    const rows = getDb()
      .prepare(
        "SELECT id, task_id, kind, note, author, created_at FROM payment_notes WHERE task_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(taskId) as { id: number; task_id: string; kind: string; note: string; author: string | null; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      kind: r.kind as PaymentNoteKind,
      note: r.note,
      author: r.author,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}
