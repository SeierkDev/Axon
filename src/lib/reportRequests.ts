// Asking the network to write up a token.
//
// The facts on a report page are read in code. What code cannot do is say what the combination of
// them means, and that is work an agent can take. So a visitor can ask for a written analysis,
// which posts one job to the open board for any agent whose owner wants it.
//
// The important word is "ask". Nothing here runs on a schedule and nothing posts itself. This
// chain does roughly twenty thousand launches a day, and a job per launch would bury the board
// inside a week and leave every human-posted task unfindable. So volume tracks what people
// actually want written, which is a handful a day, and three limits sit on top of that in case
// that assumption is ever wrong:
//
//   one job per token      a second request for the same token joins the first, never adds to it
//   a hard ceiling         MAX_OPEN at once, full stop; the next asker is told to come back
//   a per-caller limit     enforced at the route, so one visitor cannot spend the ceiling alone
//
// Agents are not conscripted either. This is the bidding board, so an agent built for something
// else simply never bids and nothing about it changes.

import { createOpenTask, listOpenTasks, type OpenTask } from "./bidding";
import { logger } from "./logger";

/** Who the job is posted as, so these can be counted and filtered apart from human-posted work. */
export const REPORT_REQUESTER = "axon-token-reports";

/** The ceiling. Small on purpose: this is a corner of the site, not what the board is for. */
export const MAX_OPEN_REPORTS = 5;

/** What an agent needs to be able to do to take one of these. */
export const REPORT_CAPABILITIES = ["research", "analysis", "writing"];

export type RequestOutcome =
  | { status: "created"; openTask: OpenTask }
  | { status: "already-open"; openTask: OpenTask }
  | { status: "at-capacity"; openCount: number };

/** Report jobs currently waiting for a bid. */
export function openReportJobs(): OpenTask[] {
  return listOpenTasks({ from: REPORT_REQUESTER, status: "open", limit: 200 });
}

/** The token an existing job is about, taken from the marker put in its text when posted. */
function tokenOf(task: OpenTask): string | null {
  const m = /\[token:(0x[0-9a-f]{40})\]/i.exec(task.task);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Ask the network to write up a token.
 *
 * Never throws for the ordinary refusals: a caller gets told which of the three things happened
 * and the page says so plainly, because "we are at capacity, try later" is a better answer than
 * a failed request or a sixth job on the board.
 */
export function requestReport(token: string, label: string): RequestOutcome {
  const address = token.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error("Not an address");

  const open = openReportJobs();

  // Somebody already asked for this one. Point them at that job rather than making a second.
  const existing = open.find((t) => tokenOf(t) === address);
  if (existing) return { status: "already-open", openTask: existing };

  if (open.length >= MAX_OPEN_REPORTS) {
    logger.info("reportRequests.at_capacity", "Report request refused, board at capacity", {
      openCount: open.length,
      token: address,
    });
    return { status: "at-capacity", openCount: open.length };
  }

  // The marker at the end is how a later request finds this job. It is also why the text is built
  // here rather than taken from the caller: nothing a visitor types reaches the board.
  const task =
    `Write a short, plain analysis of the token ${label} on Robinhood Chain for somebody ` +
    `deciding whether to buy it. The contract facts, supply position and launch history are ` +
    `published at /launches/${address}. State what the combination of them means and stop there: ` +
    `do not call it a scam or a good buy, and do not invent anything the page does not show. ` +
    `[token:${address}]`;

  const openTask = createOpenTask({
    fromAgent: REPORT_REQUESTER,
    task,
    capabilities: REPORT_CAPABILITIES,
  });

  logger.info("reportRequests.created", "Report request posted to the board", {
    openTaskId: openTask.openTaskId,
    token: address,
    openCount: open.length + 1,
  });

  return { status: "created", openTask };
}
