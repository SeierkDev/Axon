// Whether an agent may launch its own token, and what it needs to do it.
//
// The first version of this gated on track record: completed jobs, a proof score, real earnings. That was
// circular and would have killed the feature. You need a record to launch, you need visibility and capital to
// earn a record, and you get those by launching. Only the agents already here would ever have qualified.
//
// So the token is what starts an agent rather than what rewards one. The bar is a single thing: the agent has
// to exist and answer. Everything else is disclosure rather than permission, published beside the price at
// whatever size it happens to be, including zero.
//
// That one requirement still does the work it needs to. Nobody launching twenty thousand tokens a day is going
// to stand up a working endpoint for each of them, and an agent that cannot be reached is not an agent, it is a
// ticker with a description.

import { getAgentById } from "./agents";
import type { Agent } from "@/sdk/types";
import { sameAddress } from "./address";
import { getAgentTrackRecord } from "./trackRecord";

/** The chain this is for. A launch pointed at anything else would deploy into nothing. */
export const LAUNCH_CHAIN_ID = 4663;

/** Deployed once, by us, and read from the environment so it is never hardcoded into a page. */
export function launchFactoryAddress(): string | null {
  const raw = process.env.NEXT_PUBLIC_AGENT_LAUNCH_FACTORY?.trim();
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
}

/** The dev's share, in basis points. The contract fixes this forever at deployment. */
export const DEFAULT_DEV_BPS = 7000;

/** Matches AgentSplitter.MAX_DEV_BPS. A token whose earnings burn nothing is not what this is for. */
export const MAX_DEV_BPS = 9000;

export interface Eligibility {
  eligible: boolean;
  /** why not, in words a person can act on */
  reason: string | null;
  agent: {
    agentId: string;
    name: string;
    walletAddress: string | null;
    /** what the health cron last saw at its endpoint */
    verificationStatus: string | null;
  } | null;
  /** shown beside the launch form, and later beside the price. Zero is a fine answer. */
  record: {
    tasksCompleted: number;
    tasksFailed: number;
    reputation: number;
    registeredAt: string | null;
  } | null;
}

const no = (reason: string): Eligibility => ({ eligible: false, reason, agent: null, record: null });

/**
 * May this agent launch, and is `wallet` the one allowed to do it.
 *
 * `wallet` is the connected wallet. An agent's token is deployed with its dev address burned in permanently,
 * so the wallet doing the launching has to be the one that owns the agent. Getting that wrong cannot be
 * corrected afterwards by anyone, including us.
 */
export function checkEligibility(agentId: string, wallet: string | null): Eligibility {
  let agent: Agent | null = null;
  try {
    agent = getAgentById(agentId);
  } catch {
    return no("Could not read that agent.");
  }
  if (!agent) return no("No agent with that id.");

  const track = (() => {
    try { return getAgentTrackRecord(agentId); } catch { return null; }
  })();

  const shared = {
    agent: {
      agentId: agent.agentId,
      name: agent.name,
      walletAddress: agent.walletAddress ?? null,
      verificationStatus: agent.verificationStatus ?? null,
    },
    // Whatever the record is, including nothing at all. It is shown, never used to decide.
    record: {
      tasksCompleted: track?.tasksCompleted ?? 0,
      tasksFailed: track?.tasksFailed ?? 0,
      reputation: agent.reputation ?? 0,
      registeredAt: agent.createdAt ?? null,
    },
  };

  const fail = (reason: string): Eligibility => ({ eligible: false, reason, ...shared });

  // The one real requirement. An endpoint that answers is the minimum definition of an agent, and it is the
  // thing a spam launch will not bother with.
  if (!agent.endpoint) {
    return fail("This agent has no endpoint. An agent has to be reachable before it can have a token.");
  }
  if (agent.verificationStatus === "unreachable") {
    return fail("This agent's endpoint is not answering. Get it responding and try again.");
  }

  if (!agent.walletAddress) {
    return fail("This agent has no wallet on file. Add one first, since the token's dev address is permanent.");
  }
  if (!wallet) {
    return fail("Connect the wallet that owns this agent.");
  }
  // Case-insensitive, because on EVM the same address arrives in several spellings.
  if (!sameAddress(wallet, agent.walletAddress)) {
    return fail("That is not the wallet this agent is registered to.");
  }

  return { eligible: true, reason: null, ...shared };
}

/** The split, as the page should state it before anyone signs. */
export function describeSplit(devBps: number): string {
  const dev = (devBps / 100).toFixed(devBps % 100 === 0 ? 0 : 2);
  const pot = ((10_000 - devBps) / 100).toFixed(devBps % 100 === 0 ? 0 : 2);
  return `${dev}% of what this agent earns goes to its wallet, ${pot}% buys and burns its token.`;
}

/** Guard for anything a page is about to put in front of a signature. */
export function validDevBps(devBps: number): boolean {
  return Number.isInteger(devBps) && devBps >= 0 && devBps <= MAX_DEV_BPS;
}
