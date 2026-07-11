// Axon World Arcade — leaderboard storage for the world's minigames.
//
// Two metrics: TIME modes rank ascending (fastest run wins, stored in ms) and
// SCORE modes rank descending (highest wave/score wins, same column).
// Scores are client-reported (it's a casual in-world leaderboard, nothing pays
// out on it), so submissions are bounded to humanly-plausible values and names
// are sanitised hard. PLAYING is gated up-front (see arcadeGate.ts): the world
// only lets a Phantom-connected wallet holding $AXON enter a minigame at all.

import { getDb } from "./db";

export interface ArcadeModeDef {
  title: string;
  metric: "time" | "score";
  min: number; // fastest plausible ms / lowest score
  max: number; // slowest plausible ms / highest plausible score
}

export const ARCADE_MODES: Record<string, ArcadeModeDef> = {
  climb: { title: "Sky Climb", metric: "time", min: 25_000, max: 3_600_000 },
  gauntlet: { title: "The Gauntlet", metric: "time", min: 25_000, max: 3_600_000 },
  arena: { title: "Zombie Waves", metric: "score", min: 1, max: 200 },
};

const MAX_NAME = 24;
const WEEK_MS = 7 * 24 * 3_600_000;

export interface ArcadeEntry {
  player: string;
  ms: number; // ms for time modes; the wave/score for score modes
  at: string;
}

export interface ArcadeBoard {
  top: ArcadeEntry[];
  totalRuns: number;
}

// Strip control chars, collapse whitespace, cap length. Empty -> "traveler".
export function sanitizePlayer(raw: unknown): string {
  if (typeof raw !== "string") return "traveler";
  // Drop control characters by code point (no control-char regex literals).
  const stripped = [...raw].filter((ch) => { const c = ch.codePointAt(0) ?? 0; return c >= 32 && c !== 127; }).join("");
  const clean = stripped.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return clean || "traveler";
}

// Best entry per player: fastest for time modes, highest for kills modes.
export function arcadeBoard(mode: string, limit = 10, sinceIso?: string): ArcadeBoard {
  const def = ARCADE_MODES[mode];
  if (!def) return { top: [], totalRuns: 0 };
  const since = sinceIso ?? "";
  const agg = def.metric === "time" ? "MIN" : "MAX";
  const dir = def.metric === "time" ? "ASC" : "DESC";
  const rows = getDb()
    .prepare(
      `SELECT player, ${agg}(ms) AS ms, MIN(created_at) AS at FROM arcade_runs
       WHERE mode = ? AND created_at >= ? GROUP BY player ORDER BY ms ${dir}, at ASC LIMIT ?`,
    )
    .all(mode, since, limit) as { player: string; ms: number; at: string }[];
  const total = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM arcade_runs WHERE mode = ? AND created_at >= ?`)
    .get(mode, since) as { n: number };
  return { top: rows.map((r) => ({ player: r.player, ms: r.ms, at: r.at })), totalRuns: total.n };
}

// The full board payload: this week's race + the all-time greats + the crown.
export function arcadeBoards(mode: string): { week: ArcadeBoard; allTime: ArcadeBoard; lastWeekChampion: ArcadeEntry | null } {
  return {
    week: arcadeBoard(mode, 10, new Date(Date.now() - WEEK_MS).toISOString()),
    allTime: arcadeBoard(mode, 10),
    lastWeekChampion: lastWeekChampion(mode),
  };
}

/** LAST week's #1 — a real captured season moment, not a rolling window. The
 *  window is [2 weeks ago, 1 week ago): whoever topped it wears the crown. */
export function lastWeekChampion(mode: string): ArcadeEntry | null {
  const def = ARCADE_MODES[mode];
  if (!def) return null;
  const from = new Date(Date.now() - 2 * WEEK_MS).toISOString();
  const to = new Date(Date.now() - WEEK_MS).toISOString();
  const agg = def.metric === "time" ? "MIN" : "MAX";
  const dir = def.metric === "time" ? "ASC" : "DESC";
  const row = getDb()
    .prepare(
      `SELECT player, ${agg}(ms) AS ms, MIN(created_at) AS at FROM arcade_runs
       WHERE mode = ? AND created_at >= ? AND created_at < ? GROUP BY player ORDER BY ms ${dir}, at ASC LIMIT 1`,
    )
    .get(mode, from, to) as { player: string; ms: number; at: string } | undefined;
  return row ? { player: row.player, ms: row.ms, at: row.at } : null;
}

// ── Run tokens: the anti-cheat spine ─────────────────────────────────────────
// A run is OPENED on the server when it starts and CLOSED when it's submitted.
// The server measures its own elapsed wall-clock between the two, so a
// submitted time must match real time actually spent — a script can no longer
// invent a 25-second climb without genuinely waiting 25 seconds, and a token
// can never be replayed for a second entry.
function ensureTokenTable(): void {
  getDb().exec(
    `CREATE TABLE IF NOT EXISTS arcade_run_tokens (
       run_id     TEXT PRIMARY KEY,
       mode       TEXT NOT NULL,
       started_at TEXT NOT NULL,
       used       INTEGER NOT NULL DEFAULT 0
     )`,
  );
}

export function startArcadeRun(mode: string): { runId: string } {
  const def = ARCADE_MODES[mode];
  if (!def) throw new Error(`unknown arcade mode: ${String(mode).slice(0, 24)}`);
  ensureTokenTable();
  const db = getDb();
  // housekeeping: tokens older than 2h are dead runs
  db.prepare(`DELETE FROM arcade_run_tokens WHERE started_at < ?`).run(new Date(Date.now() - 2 * 3_600_000).toISOString());
  const runId = crypto.randomUUID();
  db.prepare(`INSERT INTO arcade_run_tokens (run_id, mode, started_at) VALUES (?, ?, ?)`).run(runId, mode, new Date().toISOString());
  return { runId };
}

// Mirror of arcadeLayout's wave pacing (kept in sync by the tests): reaching
// wave W means having CLEARED waves 1..W-1, and each cleared wave takes at
// least its spawn trickle plus the breather. A generous 0.85 slack keeps every
// legitimate run inside; a wave-50 claim after 40 seconds does not get in.
const waveSizeMirror = (w: number) => 3 + w * 2;
export function minArenaDurationMs(wave: number): number {
  let ms = 0;
  for (let i = 1; i < wave; i++) {
    ms += (waveSizeMirror(i) - 1) * 1400 * 0.85 + (i > 1 ? 3500 : 0);
  }
  return Math.round(ms);
}

/** Validate + consume a run token. Returns the server-side elapsed ms. */
export function consumeRunToken(runId: unknown, mode: string): number {
  if (typeof runId !== "string" || runId.length < 8 || runId.length > 64) throw new Error("missing run token");
  ensureTokenTable();
  const db = getDb();
  const row = db.prepare(`SELECT started_at, used, mode FROM arcade_run_tokens WHERE run_id = ?`).get(runId) as
    | { started_at: string; used: number; mode: string }
    | undefined;
  if (!row) throw new Error("unknown run token");
  if (row.used) throw new Error("run token already used");
  if (row.mode !== mode) throw new Error("run token is for a different mode");
  db.prepare(`UPDATE arcade_run_tokens SET used = 1 WHERE run_id = ?`).run(runId);
  return Math.max(0, Date.now() - new Date(row.started_at).getTime());
}

// Record a finished run. Returns the player's all-time rank among
// best-per-player entries (1 = best). Throws on an unknown mode or an
// implausible value — the route maps that to a 400.
//
// With a runId (the route REQUIRES one), the run is also checked against the
// server's own clock: timed runs must match real elapsed time to within 3.5s,
// and a wave count must have taken at least the waves' minimum real duration.
export function submitArcadeRun(opts: { mode: string; player: unknown; ms: unknown; runId?: unknown }): { rank: number; board: ArcadeBoard } {
  const def = ARCADE_MODES[opts.mode];
  if (!def) throw new Error(`unknown arcade mode: ${String(opts.mode).slice(0, 24)}`);
  const ms = typeof opts.ms === "number" && Number.isFinite(opts.ms) ? Math.round(opts.ms) : NaN;
  if (!Number.isInteger(ms) || ms < def.min || ms > def.max) {
    throw new Error(def.metric === "time" ? "implausible run time" : "implausible score");
  }
  if (opts.runId !== undefined) {
    const serverElapsed = consumeRunToken(opts.runId, opts.mode);
    if (def.metric === "time") {
      if (Math.abs(serverElapsed - ms) > 3500) throw new Error("run time does not match the server clock");
    } else if (serverElapsed < minArenaDurationMs(ms)) {
      throw new Error("wave count arrived faster than the waves can spawn");
    }
  }
  const player = sanitizePlayer(opts.player);

  getDb()
    .prepare(`INSERT INTO arcade_runs (mode, player, ms, created_at) VALUES (?, ?, ?, ?)`)
    .run(opts.mode, player, ms, new Date().toISOString());

  // Rank = players whose best beats this entry, plus one.
  const agg = def.metric === "time" ? "MIN" : "MAX";
  const cmp = def.metric === "time" ? "<" : ">";
  const better = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT player, ${agg}(ms) AS best FROM arcade_runs WHERE mode = ? AND player <> ? GROUP BY player
       ) WHERE best ${cmp} ?`,
    )
    .get(opts.mode, player, ms) as { n: number };

  return { rank: better.n + 1, board: arcadeBoard(opts.mode) };
}
