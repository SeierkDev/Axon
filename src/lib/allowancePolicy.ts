// Allowances: the decisions every other part of the feature reads.
//
// An allowance is a budget a wallet puts on chain once, so an assistant or an agent can hire and pay
// without its owner leaving the conversation. Paid hires over MCP today stop mid-chat: the owner has
// to leave, send ETH by hand and paste the transaction hash back.
//
// The contract (contracts/src/Allowance.sol, specified in contracts/README.md) holds the money. Axon's
// operator key can do three things with it and nothing else:
//
//   reserve  set an amount aside against one task, inside the owner's rules
//   settle   send a reservation to the payment receiver once the task completes
//   release  put a reservation back in the owner's balance when the task fails
//
// So a refund is real money coming back, not a status in our database, and it needs no treasury key:
// the money never left. The owner can withdraw anything not reserved at any time, and can reclaim a
// reservation Axon has not settled within RESERVATION_TIMEOUT_SECONDS.
//
// Ships dark: nothing reserves until AXON_ALLOWANCE_ADDRESS names a deployed contract.

import { keccak256, toBytes } from "viem";
import { normalizeAddress, sameAddress } from "./address";

/** How the contract names the chain's own currency. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/** Variables, named once so the deploy notes and the code cannot drift apart. */
export const ALLOWANCE_ADDRESS_ENV = "AXON_ALLOWANCE_ADDRESS";
/**
 * A key of its own, funded with gas and nothing else. Not the burn bot's key, which moves the pot,
 * and not the treasury's. If it leaks, the contract still only lets it pay the receiver, inside each
 * owner's rules, so the worst it can do is settle reservations early.
 */
export const OPERATOR_KEY_ENV = "AXON_ALLOWANCE_OPERATOR_KEY";

export function allowanceAddress(): string | null {
  return normalizeAddress(process.env[ALLOWANCE_ADDRESS_ENV]);
}

export const allowancesEnabled = (): boolean => allowanceAddress() !== null;

/**
 * The tokens an allowance can hold: ETH, and $AXON once $AXON payments are on.
 *
 * Read at call time rather than import time, so a deploy that sets the variable does not need every
 * importer reloaded to notice.
 */
export function allowanceTokens(): string[] {
  const axon = normalizeAddress(process.env.AXON_SETTLEMENT_TOKEN_ADDRESS);
  return axon ? [NATIVE_TOKEN, axon] : [NATIVE_TOKEN];
}

export const isAllowanceToken = (token: unknown): boolean =>
  allowanceTokens().some((t) => sameAddress(t, token));

// ── Defaults ──────────────────────────────────────────────────────────────────
//
// Measured, not guessed. On 2026-09-26, 27 of 82 agents charged, from 0.00005 to 0.0005 ETH, median
// 0.00015. The defaults are low on purpose: a stolen allowance key can spend up to the daily limit on
// an agent the thief controls, so the limit a new allowance starts with is the damage it can take
// before its owner notices.

/** Covers the most expensive paid agent on the network when this was set. */
export const DEFAULT_MAX_PER_TASK_WEI = 500_000_000_000_000n; // 0.0005 ETH
/** Ten hires at the top price, thirty-three at the median. */
export const DEFAULT_MAX_PER_DAY_WEI = 5_000_000_000_000_000n; // 0.005 ETH
export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_EXPIRY_DAYS = 365;

/**
 * How long a reservation may sit unsettled before its owner can take it back without us.
 *
 * Long enough for any task to finish and settle, including a slow build; short enough that a stalled
 * or vanished Axon does not hold anyone's money hostage.
 */
export const RESERVATION_TIMEOUT_SECONDS = 24 * 60 * 60;

/**
 * "Per day" is the UTC calendar day, the same window agent budgets already use (budgets.ts), so one
 * owner never has to reason about two different days. On chain: block.timestamp / 1 days.
 */
export const utcDay = (unixSeconds: number): number => Math.floor(unixSeconds / 86_400);

/** An allowed-agents list longer than this is an allowlist in name only. */
export const MAX_ALLOWED_AGENTS = 50;

export interface AllowanceRules {
  token: string;
  maxPerTaskWei: bigint;
  maxPerDayWei: bigint;
  /** Agent ids. Empty means any agent, which the dashboard will steer owners away from. */
  allowedAgents: string[];
  /** Unix seconds. */
  expiresAt: number;
}

export function defaultRules(nowSeconds: number, token: string = NATIVE_TOKEN): AllowanceRules {
  return {
    token,
    maxPerTaskWei: DEFAULT_MAX_PER_TASK_WEI,
    maxPerDayWei: DEFAULT_MAX_PER_DAY_WEI,
    allowedAgents: [],
    expiresAt: nowSeconds + DEFAULT_EXPIRY_DAYS * 86_400,
  };
}

/**
 * The same defaults in $AXON, at a given rate.
 *
 * `axonForWei` is whatever converts an ETH amount to $AXON at the moment the owner creates the
 * allowance (the quote path's pool read). The limits are then fixed in $AXON, so a moving price does
 * not quietly move an owner's limits.
 */
export function axonDefaultRules(nowSeconds: number, axonToken: string, axonForWei: (wei: bigint) => bigint): AllowanceRules {
  return {
    ...defaultRules(nowSeconds, axonToken),
    maxPerTaskWei: axonForWei(DEFAULT_MAX_PER_TASK_WEI),
    maxPerDayWei: axonForWei(DEFAULT_MAX_PER_DAY_WEI),
  };
}

/** Why a set of rules cannot be used, or null when it can. The contract checks the same things. */
export function rulesError(rules: AllowanceRules, nowSeconds: number): string | null {
  if (!isAllowanceToken(rules.token)) return "That token cannot be held in an allowance";
  if (rules.maxPerTaskWei <= 0n) return "The per-task limit must be above zero";
  if (rules.maxPerDayWei < rules.maxPerTaskWei) return "The daily limit cannot be below the per-task limit";
  if (!Number.isInteger(rules.expiresAt) || rules.expiresAt <= nowSeconds) return "The expiry must be in the future";
  if (rules.expiresAt > nowSeconds + MAX_EXPIRY_DAYS * 86_400) return `The expiry can be at most ${MAX_EXPIRY_DAYS} days away`;
  if (rules.allowedAgents.length > MAX_ALLOWED_AGENTS) return `At most ${MAX_ALLOWED_AGENTS} allowed agents`;
  const ids = rules.allowedAgents.map((a) => a.trim());
  if (ids.some((a) => a === "")) return "An allowed agent id is empty";
  if (new Set(ids).size !== ids.length) return "An allowed agent is listed twice";
  return null;
}

/**
 * How the contract refers to an agent and a task: the keccak256 of the id.
 *
 * Fixed width, so a list of agents costs the same to store whatever their names, and the chain holds
 * no free text anyone could fill with something ugly.
 */
export const agentKey = (agentId: string): `0x${string}` => keccak256(toBytes(agentId.trim()));
export const taskKey = (taskId: string): `0x${string}` => keccak256(toBytes(taskId.trim()));
