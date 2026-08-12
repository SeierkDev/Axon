// Tier 3 — the pass over the network itself, rather than the code.
//
// The codebase pass reads files and writes its log to git. This one reads live
// state, so its record lives in the database; /autonomy shows both and says
// which is which.
//
// The rule that shapes this file: it observes every agent and acts on almost
// none. An agent's price is its owner's business decision, so the pass adjusts
// it only where the owner set `auto_price`. Everything else it notices, it
// reports. Automation that quietly edits other people's listings would buy a
// little tidiness at the cost of the only thing making any of this credible.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { computeOptimization, applyOptimization } from "./selfOptimize";

export interface NetworkObservation {
  kind: "capability-gap" | "dormant-listing";
  /** One line, in the terms a reader cares about. */
  what: string;
  /** Why it is worth knowing — a signal is useless without its meaning. */
  why: string;
}

export interface NetworkChange {
  agentId: string;
  what: string;
}

export interface NetworkRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  observations: NetworkObservation[];
  changes: NetworkChange[];
  agentsSeen: number;
}

/** Listed this long without finishing anything counts as dormant. */
const DORMANT_DAYS = 60;
/** At or below this many providers, a capability is thin enough to name. */
const THIN_SUPPLY = 1;
/** What a capability name may look like — matches how agents register them. */
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[ _-][a-z0-9]+)*$/;

/**
 * Capabilities buyers ask for that the marketplace barely serves.
 *
 * Demand comes from open tasks — someone posting a job and naming what it needs
 * is the clearest statement of demand the network has. Supply is the count of
 * agents offering it. The gap between the two is the most useful thing Axon can
 * tell a prospective builder: not "list an agent", but "list this one".
 */
function capabilityGaps(): NetworkObservation[] {
  const db = getDb();
  const supply = new Map<string, number>();
  for (const row of db.prepare("SELECT capability, COUNT(*) n FROM agent_capabilities GROUP BY capability").all() as
    { capability: string; n: number }[]) {
    supply.set(row.capability.toLowerCase(), row.n);
  }

  const demand = new Map<string, number>();
  for (const row of db.prepare("SELECT capabilities FROM open_tasks WHERE capabilities IS NOT NULL").all() as
    { capabilities: string }[]) {
    let caps: unknown;
    try {
      caps = JSON.parse(row.capabilities);
    } catch {
      caps = row.capabilities.split(",");
    }
    const list = Array.isArray(caps) ? caps : [caps];
    for (const c of list) {
      if (typeof c !== "string") continue;
      const key = c.trim().toLowerCase();
      // A capability is a name, and this is the one place unvalidated client
      // input reaches a public page. Malformed JSON falls back to a comma split,
      // so a body of `{{broken` arrived here as a capability and /autonomy
      // reported that nobody offers "{{broken" — a demand signal invented out of
      // a parse failure. Anything that isn't shaped like a name is not one.
      if (!CAPABILITY_NAME.test(key)) continue;
      demand.set(key, (demand.get(key) ?? 0) + 1);
    }
  }

  const out: NetworkObservation[] = [];
  for (const [cap, asks] of [...demand].sort((a, b) => b[1] - a[1])) {
    const have = supply.get(cap) ?? 0;
    if (have > THIN_SUPPLY) continue;
    out.push({
      kind: "capability-gap",
      what:
        have === 0
          ? `"${cap}" was asked for ${asks} time${asks === 1 ? "" : "s"} and no agent offers it`
          : `"${cap}" was asked for ${asks} time${asks === 1 ? "" : "s"} and only ${have} agent offers it`,
      why: "demand with no supply is the clearest thing the network can tell someone deciding what to build",
    });
  }
  return out;
}

/**
 * Listings that have not delivered anything in a long time.
 *
 * Reported, never delisted. An agent that is quiet may be seasonal, private, or
 * simply waiting; removing it on a timer would be the pass making a judgement
 * about someone else's business that a date cannot support.
 */
function dormantListings(): NetworkObservation[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - DORMANT_DAYS * 86400_000).toISOString();
  const rows = db.prepare(`
    SELECT a.agent_id, a.name, MAX(t.completed_at) AS last_done
    FROM agents a
    LEFT JOIN tasks t ON t.to_agent = a.agent_id AND t.status = 'completed'
    GROUP BY a.agent_id
    HAVING last_done IS NULL OR last_done < ?
    ORDER BY last_done IS NOT NULL, last_done ASC
  `).all(cutoff) as { agent_id: string; name: string; last_done: string | null }[];
  if (rows.length === 0) return [];

  const { n: total } = db.prepare("SELECT COUNT(*) n FROM agents").get() as { n: number };
  const neverRan = rows.filter((r) => !r.last_done).length;

  // One line, not one per agent. Measured on the live registry this was 32 rows
  // out of 46 agents, which as a list is noise and as a proportion is the actual
  // finding: most of the marketplace has never delivered anything.
  const sample = rows.slice(0, 3).map((r) => r.agent_id).join(", ");
  return [
    {
      kind: "dormant-listing",
      what: `${rows.length} of ${total} listings have not completed a job in ${DORMANT_DAYS} days (${neverRan} never have), e.g. ${sample}`,
      why: "listings nobody can get work out of make the marketplace look larger than it is",
    },
  ];
}

/**
 * Apply price self-optimization to the agents whose owners opted in.
 *
 * `computeOptimization` is deterministic and already lives in this codebase; the
 * only new thing here is running it without being asked each time — and that
 * only for `auto_price` agents.
 */
function applyAutoPricing(apply: boolean): NetworkChange[] {
  const db = getDb();
  const opted = db.prepare("SELECT agent_id FROM agents WHERE auto_price = 1").all() as { agent_id: string }[];
  const changes: NetworkChange[] = [];
  for (const { agent_id } of opted) {
    const opt = computeOptimization(agent_id);
    if (!opt || opt.action === "hold" || !opt.suggestedPrice) continue;
    if (opt.suggestedPrice === opt.currentPrice) continue;
    if (apply) applyOptimization(agent_id, opt.suggestedPrice);
    changes.push({
      agentId: agent_id,
      what: `${opt.action === "raise" ? "raised" : "lowered"} price ${opt.currentPrice ?? "free"} → ${opt.suggestedPrice} (${opt.rationale})`,
    });
  }
  return changes;
}

/**
 * One pass over the network.
 *
 * `apply: false` computes everything and writes nothing, so the pass can be
 * inspected before it is trusted — the same split the codebase pass has between
 * checking and fixing.
 */
export function runNetworkPass(opts: { apply?: boolean } = {}): NetworkRun {
  const apply = opts.apply ?? false;
  const startedAt = new Date().toISOString();
  const db = getDb();

  const observations = [...capabilityGaps(), ...dormantListings()];
  const changes = applyAutoPricing(apply);
  const { n: agentsSeen } = db.prepare("SELECT COUNT(*) n FROM agents").get() as { n: number };

  const run: NetworkRun = {
    runId: randomUUID(),
    startedAt,
    finishedAt: new Date().toISOString(),
    observations,
    changes,
    agentsSeen,
  };

  if (apply) {
    db.prepare(`
      INSERT INTO autonomy_network_runs (run_id, started_at, finished_at, observations, changes, agents_seen)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      run.runId, run.startedAt, run.finishedAt,
      JSON.stringify(run.observations), JSON.stringify(run.changes), run.agentsSeen,
    );
    void syncToTurso();
  }
  return run;
}

/**
 * The most recent recorded network pass, or null before the first one.
 *
 * Returns null rather than throwing when the table is not there. /autonomy is
 * the page this whole thing is judged by, and on a deploy where migration 058
 * has not run yet the query raises `no such table` — which would take the page
 * down at exactly the moment someone came to look at it. The same rule the file
 * log follows: a missing record costs the section, never the page.
 */
export function getLatestNetworkRun(): NetworkRun | null {
  let row;
  try {
    row = getDb()
      .prepare("SELECT * FROM autonomy_network_runs ORDER BY started_at DESC LIMIT 1")
      .get() as
    | { run_id: string; started_at: string; finished_at: string; observations: string; changes: string; agents_seen: number }
      | undefined;
  } catch {
    return null; // table not migrated yet
  }
  if (!row) return null;
  const parse = <T>(s: string): T[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  };
  return {
    runId: row.run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    observations: parse<NetworkObservation>(row.observations),
    changes: parse<NetworkChange>(row.changes),
    agentsSeen: row.agents_seen,
  };
}
