// Noticing when everything is failing for the same reason.
//
// Between 26 August and 19 September the provider key configured for the platform was rejected on
// every call. The generated activity kept producing its few hundred tasks a day and every one of
// them failed on the same error, for three and a half weeks, until somebody looked at the success
// rate and asked why it was seven percent. Five and a half thousand tasks.
//
// Nothing was broken in a way that anything watched for. The site was up, the worker had a
// heartbeat, the queue drained. Each task failed on its own and no single failure was remarkable.
// What was remarkable was that they all failed the *same way*, and nothing was looking at that.
//
// So this looks at that. It groups recent failures by what actually went wrong and asks whether
// one cause has taken over. A handful of agents with a bad model name is ordinary and stays quiet;
// four fifths of everything failing on one authentication error is not.

import { getDb } from "./db";
import { isoHoursAgo } from "./sqlTime";

/** The window to judge. Long enough to be a pattern, short enough to still be news. */
const WINDOW_HOURS = Number(process.env.AXON_FAILURE_WINDOW_HOURS ?? 2);
/** Below this many failures there is no pattern to find, only noise. */
const MIN_FAILURES = 12;
/** One cause owning this much of the failures is systemic rather than incidental. */
const DOMINANT_SHARE = 0.6;

export interface FailurePattern {
  /** what went wrong, in the provider's words, normalised */
  signature: string;
  count: number;
  share: number;
  agentsAffected: number;
  example: string;
}

export interface FailureReport {
  ok: boolean;
  windowHours: number;
  failures: number;
  completed: number;
  /** the causes, largest first */
  patterns: FailurePattern[];
  /** set when one cause has taken over, in words worth reading at 3am */
  alert: string | null;
}

/**
 * Reduce an error to what it is, rather than what it said.
 *
 * Provider errors carry ids, timestamps, model names and token counts, so the same fault never
 * arrives twice with the same text. Grouping needs the shape, so the parts that vary are removed
 * and the recognisable faults are named outright.
 */
export function failureSignature(raw: string | null): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "no error recorded";

  if (/authentication_error|api key is invalid|invalid_api_key|\bunauthorized\b/i.test(text)) {
    return "provider rejected the API key";
  }
  if (/credit balance is too low|insufficient[_ ]quota|billing/i.test(text)) return "provider account out of credit";
  if (/\bmodel\b[^\n]{0,60}?does not exist|does not exist or you do not have access|model_not_found|\binvalid model\b/i.test(text)) {
    return "model does not exist";
  }
  if (/\brate[ _]?limit|\b429\b/i.test(text)) return "provider rate limit";
  if (/overloaded|\b529\b|\b503\b/i.test(text)) return "provider overloaded";
  if (/timed? ?out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)) return "timed out";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(text)) return "agent endpoint unreachable";

  // Anything else: strip the parts that make every occurrence unique.
  return text
    .replace(/0x[0-9a-fA-F]{6,}/g, "<hex>")
    // req_a1b2, request abc-123: a prefixed identifier. The digit is required, so ordinary
    // hyphenated English ("well-known", "rate-limit") is left alone.
    .replace(/\b[A-Za-z]{2,6}[-_][A-Za-z0-9]*\d[A-Za-z0-9]*\b/g, "<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\d+/g, "N")
    .slice(0, 90);
}

/**
 * What has been going wrong lately, and whether one thing has taken over.
 *
 * Read-only. Returns ok with no patterns when there is nothing to say, which is most of the time.
 */
export function failureReport(): FailureReport {
  const report: FailureReport = {
    ok: true,
    windowHours: WINDOW_HOURS,
    failures: 0,
    completed: 0,
    patterns: [],
    alert: null,
  };

  try {
    const db = getDb();
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
           COUNT(*) FILTER (WHERE status = 'completed') AS completed
         FROM tasks
         WHERE completed_at IS NOT NULL AND completed_at >= ${isoHoursAgo(WINDOW_HOURS)}`,
      )
      .get() as { failed: number; completed: number };

    report.failures = counts.failed;
    report.completed = counts.completed;
    if (counts.failed < MIN_FAILURES) return report;

    const rows = db
      .prepare(
        `SELECT error, to_agent FROM tasks
         WHERE status = 'failed' AND completed_at >= ${isoHoursAgo(WINDOW_HOURS)}`,
      )
      .all() as { error: string | null; to_agent: string }[];

    const groups = new Map<string, { count: number; agents: Set<string>; example: string }>();
    for (const r of rows) {
      const sig = failureSignature(r.error);
      const g = groups.get(sig) ?? { count: 0, agents: new Set<string>(), example: (r.error ?? "").slice(0, 200) };
      g.count++;
      g.agents.add(r.to_agent);
      groups.set(sig, g);
    }

    report.patterns = [...groups.entries()]
      .map(([signature, g]) => ({
        signature,
        count: g.count,
        share: g.count / counts.failed,
        agentsAffected: g.agents.size,
        example: g.example,
      }))
      .sort((a, b) => b.count - a.count);

    const top = report.patterns[0];
    // One cause across many agents is the platform, not the agents. That distinction is the whole
    // point: a bad model name hits one agent, a rejected key hits everything at once.
    if (top && top.share >= DOMINANT_SHARE && top.agentsAffected > 1) {
      report.ok = false;
      report.alert =
        `${Math.round(top.share * 100)}% of the last ${counts.failed} failures are "${top.signature}", ` +
        `across ${top.agentsAffected} agents. That is the platform, not the agents.`;
    }
  } catch {
    // A report that cannot be produced is not itself an incident.
  }

  return report;
}
