import { MAX_TOOL_GRANTS, MAX_TOOL_STEPS, MAX_TOOL_RESULT_CHARS } from "./agentToolLimits";
import { getTier, BASE_TIER, type Tier, type TierName } from "./holderTier";
import { getAgentById } from "./agents";

// How deep an agent may go, by what its owner holds.
//
// The throughput perks are about how often you may call. These are about how much the agent can
// actually do on one job: how many tools it may reach for, how many times it may look something up
// before answering, and how much of a tool's output it may read back.
//
// Deliberately scoped to work somebody paid for. Every extra step is another model call carrying
// the whole conversation so far, so a deeper agent is a more expensive agent. On a paid hire the
// buyer covered that. On a free-lane hire the project is buying it, which is why the free lane
// keeps the base depth whatever its owner holds — otherwise the one benefit that costs money would
// have a second, uncapped door into it.
//
// Base is the depth every agent has today, so nothing an existing agent does changes.

export interface AgentLimits {
  /** Tools an owner may attach to one agent. */
  toolGrants: number;
  /** Model↔tool round trips inside a single task. */
  toolSteps: number;
  /** Characters of a single tool result fed back to the model. */
  toolResultChars: number;
}

export const BASE_LIMITS: AgentLimits = {
  toolGrants: MAX_TOOL_GRANTS,
  toolSteps: MAX_TOOL_STEPS,
  toolResultChars: MAX_TOOL_RESULT_CHARS,
};

/**
 * Multipliers, so each limit keeps its own sense of scale.
 *
 * Steps rise more slowly than grants on purpose: attaching a twelfth tool costs nothing until it is
 * used, while a twelfth round trip is a model call with the whole conversation in it. The one that
 * spends money is the one that moves least.
 */
const BY_TIER: Record<TierName, { grants: number; steps: number; resultChars: number }> = {
  base: { grants: 1, steps: 1, resultChars: 1 },
  holder: { grants: 1.5, steps: 1.34, resultChars: 1.5 },
  builder: { grants: 2, steps: 1.67, resultChars: 2 },
  operator: { grants: 3, steps: 2, resultChars: 3 },
};

/** The limits a tier earns. Never below base, whatever the table says. */
export function limitsForTier(tier: Tier): AgentLimits {
  const m = BY_TIER[tier.name] ?? BY_TIER.base;
  return {
    toolGrants: Math.max(BASE_LIMITS.toolGrants, Math.round(BASE_LIMITS.toolGrants * m.grants)),
    toolSteps: Math.max(BASE_LIMITS.toolSteps, Math.round(BASE_LIMITS.toolSteps * m.steps)),
    toolResultChars: Math.max(BASE_LIMITS.toolResultChars, Math.round(BASE_LIMITS.toolResultChars * m.resultChars)),
  };
}

/**
 * The limits an agent runs under, from its owner's holdings.
 *
 * `paid` is the gate: free-lane work stays at base depth regardless, because the project is paying
 * for those tokens. Never throws — an unknown agent or an unreadable chain is base, which is what
 * every agent gets today.
 */
export async function limitsForAgent(agentId: string, paid: boolean): Promise<AgentLimits> {
  if (!paid) return BASE_LIMITS;
  try {
    const agent = getAgentById(agentId);
    if (!agent?.walletAddress) return BASE_LIMITS;
    const { tier } = await getTier(agent.walletAddress);
    return limitsForTier(tier);
  } catch {
    return BASE_LIMITS;
  }
}

/** How many tool grants this owner may attach. Used when an agent is registered or updated. */
export async function toolGrantsForOwner(wallet: string | null | undefined): Promise<number> {
  if (!wallet) return BASE_LIMITS.toolGrants;
  try {
    const { tier } = await getTier(wallet);
    return limitsForTier(tier).toolGrants;
  } catch {
    return BASE_LIMITS.toolGrants;
  }
}

export { BASE_TIER };
