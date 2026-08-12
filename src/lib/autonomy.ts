// Reading the record of Axon's maintenance passes over itself.
//
// The log is written by scripts/autonomy.mjs into autonomy/, and committed. It
// lives in git rather than the database on purpose: the claim being made is that
// the project keeps itself honest, and a claim like that is only worth something
// if an outsider can diff it. A row in our own database would be exactly the kind
// of number you have to take on trust.

import { readFileSync, existsSync } from "fs";
import { join } from "path";

export type Severity = "error" | "warn";

export interface Finding {
  severity: Severity;
  /** What is wrong, in one line. */
  what: string;
  /** Why it matters — so a reader can judge the finding, not just count it. */
  why: string;
  /** Repo-relative files the finding came from. */
  where: string[];
}

export interface CheckResult {
  id: string;
  title: string;
  ok: boolean;
  /** How many things this check looked at, so "0 findings" has a denominator. */
  checked: number;
  findings: Finding[];
  ms: number;
}

export interface AutonomyRun {
  startedAt: string;
  finishedAt: string;
  commit: string | null;
  checks: CheckResult[];
  errors: number;
  warnings: number;
  /** Whether the pass modified the repository. A checking pass records `false`. */
  changed: boolean;
  /**
   * Repairs the pass applied, as opposed to problems it merely found.
   *
   * Kept separate from `findings` on purpose: a pass reports what is wrong and,
   * when asked, fixes the subset a compiler can prove. Collapsing the two would
   * lose the only distinction that makes an automated change reviewable.
   */
  changes?: Change[];
}

export interface Change {
  /** The repair, in one line. */
  what: string;
  /** The file it was applied to. */
  where: string;
}

// Resolved per call rather than at module load: the log directory is relative to
// the working directory, and binding it once means the module answers for
// whatever directory it happened to be imported from.
const logDir = () => join(process.cwd(), "autonomy");

/** The most recent pass, or null before the first one has run. */
export function getLatestRun(): AutonomyRun | null {
  const p = join(logDir(), "latest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AutonomyRun;
  } catch {
    return null;
  }
}

/**
 * Recent passes, newest first.
 *
 * A malformed line is skipped rather than throwing: the history is append-only
 * and a truncated final write should cost you that one entry, not the page.
 */
export function getRunHistory(limit = 20): AutonomyRun[] {
  const p = join(logDir(), "history.jsonl");
  if (!existsSync(p)) return [];
  let lines: string[];
  try {
    lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const runs: AutonomyRun[] = [];
  for (const line of lines.slice(-limit).reverse()) {
    try {
      runs.push(JSON.parse(line) as AutonomyRun);
    } catch {
      /* skip a half-written line */
    }
  }
  return runs;
}

/** Every open finding in the latest pass, errors before warnings. */
export function openFindings(run: AutonomyRun | null): Finding[] {
  if (!run) return [];
  const all = run.checks.flatMap((c) => c.findings);
  return [...all.filter((f) => f.severity === "error"), ...all.filter((f) => f.severity === "warn")];
}
