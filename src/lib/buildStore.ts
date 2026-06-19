// Persistence for generated Axon Build games. Games are stored server-side so
// they can be served from a real URL (the /play/<id> page and the download
// endpoint) — client-side blob:/data: URLs are blocked by the page CSP and by
// mobile browsers. Persisting also underpins paid generation and shareable links.

import { getDb } from "./db";

export interface BuildGame {
  buildId: string;
  prompt: string;
  html: string;
  qaPassed: boolean;
  createdAt: string;
}

interface BuildGameRow {
  build_id: string;
  prompt: string;
  html: string;
  qa_passed: number;
  created_at: string;
}

// Ensure the Build tables exist, in case migrations 021/022 didn't apply on the
// host (e.g. the migrations dir wasn't bundled). Idempotent and safe to call on
// every request; this is what makes payment tracking + game persistence work in
// production even when the migration step was skipped.
export function ensureBuildTables(): void {
  try {
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS build_games (
        build_id    TEXT PRIMARY KEY,
        prompt      TEXT NOT NULL,
        html        TEXT NOT NULL,
        qa_passed   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS build_payments (
        signature  TEXT PRIMARY KEY,
        payer      TEXT,
        build_id   TEXT,
        used_at    TEXT NOT NULL
      );
    `);
  } catch {
    /* best-effort */
  }
}

export function saveBuildGame(game: {
  buildId: string;
  prompt: string;
  html: string;
  qaPassed: boolean;
}): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO build_games (build_id, prompt, html, qa_passed, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(game.buildId, game.prompt, game.html, game.qaPassed ? 1 : 0, new Date().toISOString());
}

// Reserve a payment signature so it can only fund one generation.
// Returns false if the signature was already used (replay attempt).
export function reserveBuildPayment(
  signature: string,
  payer: string | undefined,
  buildId: string,
): boolean {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO build_payments (signature, payer, build_id, used_at) VALUES (?, ?, ?, ?)`,
      )
      .run(signature, payer ?? null, buildId, new Date().toISOString());
    return res.changes > 0;
  } catch {
    // PRIMARY KEY conflict — this signature has already been used.
    return false;
  }
}

// Release a reservation when on-chain verification fails, so a genuine retry
// (e.g. the payment confirmed a moment later) isn't permanently blocked.
export function releaseBuildPayment(signature: string): void {
  try {
    getDb().prepare(`DELETE FROM build_payments WHERE signature = ?`).run(signature);
  } catch {
    /* best-effort */
  }
}

// The game a payment already produced, if any. Lets a re-submitted (paid)
// signature return its existing game instead of being rejected or re-charged.
export function getGameForPayment(signature: string): BuildGame | null {
  try {
    const row = getDb()
      .prepare(`SELECT build_id FROM build_payments WHERE signature = ?`)
      .get(signature) as { build_id: string | null } | undefined;
    if (!row?.build_id) return null;
    return getBuildGame(row.build_id);
  } catch {
    return null;
  }
}

// Re-point a reservation at a new build attempt, so a successful retry of a
// previously-failed paid build is findable by its signature.
export function linkPaymentToBuild(signature: string, buildId: string): void {
  try {
    getDb()
      .prepare(`UPDATE build_payments SET build_id = ? WHERE signature = ?`)
      .run(buildId, signature);
  } catch {
    /* best-effort */
  }
}

export function getBuildGame(buildId: string): BuildGame | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT build_id, prompt, html, qa_passed, created_at FROM build_games WHERE build_id = ?`,
      )
      .get(buildId) as BuildGameRow | undefined;
    if (!row) return null;
    return {
      buildId: row.build_id,
      prompt: row.prompt,
      html: row.html,
      qaPassed: row.qa_passed === 1,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}
