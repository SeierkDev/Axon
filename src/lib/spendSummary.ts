import { getDb } from "./db";
import { logger } from "./logger";

// What the network actually spends on inference, and which half of it earns nothing back.
//
// Every model step already records its tokens and an estimated cost into trace_events. Nothing has
// ever added them up, so the cost of running a task has been unknowable: not hidden, just never
// asked. That was fine while nothing depended on the number. It stops being fine the moment we
// decide how many free calls a tier should include, because that decision IS this number times an
// allowance, and guessing it is how you write a cheque you cannot read.
//
// The split that matters is free against paid. A paid hire arrives with ETH, so the buyer covered
// the inference and generosity there costs nothing net. A free-lane hire is inference we bought for
// somebody with no revenue against it. Those are different lines in a budget and summing them
// together hides the only one worth watching.
//
// Read-only and derived: this reads rows the worker already wrote. Nothing here changes what is
// recorded, what a task costs, or what anyone is charged.

export interface ModelSpend {
  model: string;
  tasks: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LaneSpend {
  /** Tasks in this lane that recorded at least one priced model step. */
  tasks: number;
  costUsd: number;
  /** What one task in this lane costs on average. Null with nothing to average. */
  avgCostUsd: number | null;
}

export interface SpendSummary {
  /** The window these figures cover. */
  hours: number;
  since: string;
  /** Everything, both lanes. */
  total: LaneSpend;
  /**
   * Hires nobody paid for. This is the line that prices a free-call allowance: a tier granting N
   * free calls costs roughly N times this average, per holder, with no revenue against it.
   */
  free: LaneSpend;
  /** Hires that arrived with payment, so the buyer covered the inference. */
  paid: LaneSpend;
  byModel: ModelSpend[];
  /**
   * Steps in the window whose model has no entry in the price table, so their cost is unknown and
   * excluded from every figure above. Stated rather than folded in: a total that silently omits
   * some of the spend reads as complete and is not.
   */
  unpricedSteps: number;
}

const EMPTY_LANE: LaneSpend = { tasks: 0, costUsd: 0, avgCostUsd: null };

const emptySummary = (hours: number, since: string): SpendSummary => ({
  hours,
  since,
  total: EMPTY_LANE,
  free: EMPTY_LANE,
  paid: EMPTY_LANE,
  byModel: [],
  unpricedSteps: 0,
});

const round = (n: number, dp = 6): number => Math.round(n * 10 ** dp) / 10 ** dp;

const lane = (tasks: number, costUsd: number): LaneSpend => ({
  tasks,
  costUsd: round(costUsd),
  avgCostUsd: tasks > 0 ? round(costUsd / tasks) : null,
});

/**
 * Sum model spend over a window.
 *
 * A task counts in the lane its own `payment` column says: null means the free lane. Joined rather
 * than inferred, because "was this paid for" is a fact about the task and guessing it from the
 * trace would be a second opinion that can disagree with the ledger.
 */
export function getSpendSummary(hours = 24): SpendSummary {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  try {
    const db = getDb();

    // Per task, so an average is per hire rather than per model call. A task with six tool steps is
    // one task that cost the sum of its steps, and averaging over steps would make every task look
    // six times cheaper than it is.
    const rows = db
      .prepare(
        `SELECT t.payment IS NULL AS free,
                e.task_id      AS task_id,
                SUM(e.cost_usd) AS cost
           FROM trace_events e
           JOIN tasks t ON t.task_id = e.task_id
          WHERE e.created_at >= ?
            AND e.cost_usd IS NOT NULL
          GROUP BY e.task_id`,
      )
      .all(since) as { free: number; task_id: string; cost: number | null }[];

    let freeTasks = 0, freeCost = 0, paidTasks = 0, paidCost = 0;
    for (const r of rows) {
      const cost = r.cost ?? 0;
      if (r.free) { freeTasks++; freeCost += cost; } else { paidTasks++; paidCost += cost; }
    }

    const byModel = (
      db
        .prepare(
          `SELECT model,
                  COUNT(DISTINCT task_id) AS tasks,
                  SUM(cost_usd)           AS cost,
                  SUM(input_tokens)       AS input_tokens,
                  SUM(output_tokens)      AS output_tokens
             FROM trace_events
            WHERE created_at >= ? AND cost_usd IS NOT NULL AND model IS NOT NULL
            GROUP BY model
            ORDER BY cost DESC`,
        )
        .all(since) as { model: string; tasks: number; cost: number | null; input_tokens: number | null; output_tokens: number | null }[]
    ).map((r) => ({
      model: r.model,
      tasks: r.tasks,
      costUsd: round(r.cost ?? 0),
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
    }));

    // Steps that ran a model but carry no cost: the price table does not know that model. They are
    // real spend and this total does not include them, so the count is reported alongside.
    const unpriced = db
      .prepare(
        `SELECT COUNT(*) AS n FROM trace_events
          WHERE created_at >= ? AND model IS NOT NULL AND cost_usd IS NULL`,
      )
      .get(since) as { n: number };

    return {
      hours,
      since,
      total: lane(freeTasks + paidTasks, freeCost + paidCost),
      free: lane(freeTasks, freeCost),
      paid: lane(paidTasks, paidCost),
      byModel,
      unpricedSteps: unpriced?.n ?? 0,
    };
  } catch (err) {
    logger.warn("spend.summary_failed", "Could not summarise model spend", { err, hours });
    return emptySummary(hours, since);
  }
}

/**
 * What a free call costs, for sizing an allowance.
 *
 * Falls back to the all-task average when the free lane has nothing in the window, and to null when
 * there is nothing to average at all. Null rather than zero on purpose: zero would read as "free
 * calls are free", which is the single most expensive thing this could imply.
 */
export function averageFreeCallCostUsd(hours = 24): number | null {
  const s = getSpendSummary(hours);
  return s.free.avgCostUsd ?? s.total.avgCostUsd;
}
