// The allowance contract, as the server sees it: reads, and the operator's three transactions.
//
// Nothing here decides anything. allowancePayment.ts decides whether a hire may be paid from an
// allowance; the reconciler decides when a reservation settles or releases. This module only talks
// to the chain, and checks that what came back is what was asked for.

import { decodeEventLog, toFunctionSelector, type Hex } from "viem";
import { ALLOWANCE_ABI } from "./allowanceAbi";
import { publicClient, walletClientFor } from "./evm";
import { allowanceAddress, OPERATOR_KEY_ENV, NATIVE_TOKEN } from "./allowancePolicy";
import { sameAddress } from "./address";

export { ALLOWANCE_ABI } from "./allowanceAbi";

/**
 * How often to ask whether a transaction has landed. viem's default is 4s, which on a chain producing
 * blocks every ~0.1s would make every allowance hire wait four seconds for nothing.
 */
const RECEIPT_POLL_MS = 500;

/** The contract's reservation states, by their enum position. */
export const RESERVATION_STATE = ["none", "reserved", "settled", "released", "reclaimed"] as const;
export type ReservationState = (typeof RESERVATION_STATE)[number];

export interface AllowanceAccount {
  balance: bigint;
  reserved: bigint;
  available: bigint;
  maxPerTask: bigint;
  maxPerDay: bigint;
  spentToday: bigint;
  expiresAt: bigint;
  paused: boolean;
  restrict: boolean;
}

function contract(): `0x${string}` {
  const address = allowanceAddress();
  if (!address) throw new Error("Allowances are not enabled");
  return address as `0x${string}`;
}

/**
 * One operator transaction goes out at a time.
 *
 * Every allowance payment is sent from the same operator key, and a key's transactions are numbered
 * (the nonce). Sent concurrently, two hires read the same next number and one of them is refused as
 * "nonce too low": a flood test paid 2 of the 10 hires that fitted, and the refusals tripped the RPC
 * breaker for the whole app. So sending is queued: simulate, send, and let the next one go once this
 * one has its number. Waiting for the receipt happens outside the queue, so hires still land in
 * parallel. On globalThis, so every copy of this module shares the one queue.
 */
const sendQueue = globalThis as typeof globalThis & { __axonOperatorQueue?: Promise<unknown> };
function queued<T>(send: () => Promise<T>): Promise<T> {
  const previous = sendQueue.__axonOperatorQueue ?? Promise.resolve();
  const mine = previous.catch(() => {}).then(send);
  sendQueue.__axonOperatorQueue = mine.catch(() => {});
  return mine;
}

function operator() {
  const key = process.env[OPERATOR_KEY_ENV]?.trim();
  if (!key) throw new Error(`${OPERATOR_KEY_ENV} is not set`);
  return walletClientFor(key);
}

export async function readAccount(owner: string, token: string = NATIVE_TOKEN): Promise<AllowanceAccount> {
  const [a, available, spentToday] = await publicClient().readContract({
    address: contract(),
    abi: ALLOWANCE_ABI,
    functionName: "accountOf",
    args: [owner as `0x${string}`, token as `0x${string}`],
  });
  return {
    balance: a.balance,
    reserved: a.reserved,
    available,
    maxPerTask: a.maxPerTask,
    maxPerDay: a.maxPerDay,
    spentToday,
    expiresAt: a.expiresAt,
    paused: a.paused,
    restrict: a.restrict,
  };
}

export async function isAgentAllowed(owner: string, token: string, agentKey: Hex): Promise<boolean> {
  return publicClient().readContract({
    address: contract(),
    abi: ALLOWANCE_ABI,
    functionName: "allowed",
    args: [owner as `0x${string}`, token as `0x${string}`, agentKey],
  });
}

export async function reservationsPausedOnChain(): Promise<boolean> {
  return publicClient().readContract({ address: contract(), abi: ALLOWANCE_ABI, functionName: "reservationsPaused" });
}

export async function reservationState(taskKey: Hex): Promise<ReservationState> {
  const r = await publicClient().readContract({
    address: contract(),
    abi: ALLOWANCE_ABI,
    functionName: "reservations",
    args: [taskKey],
  });
  return RESERVATION_STATE[r[6]] ?? "none";
}

export interface Reservation {
  txHash: Hex;
  owner: string;
  token: string;
  taskKey: Hex;
  agentKey: Hex;
  amount: bigint;
}

/**
 * Set money aside for one task, and prove it was set aside as asked.
 *
 * Simulated first, so a reservation the contract would refuse fails here with its reason and costs no
 * gas. After it lands, the Reserved event is read back and compared field by field: the task starts
 * as paid on the strength of this, so "the transaction succeeded" is not enough.
 */
export async function reserveOnChain(r: Omit<Reservation, "txHash">): Promise<Reservation> {
  const { account, client } = operator();
  const reader = publicClient();
  const args = [r.owner as `0x${string}`, r.token as `0x${string}`, r.taskKey, r.agentKey, r.amount] as const;
  const txHash = await queued(async () => {
    await reader.simulateContract({ address: contract(), abi: ALLOWANCE_ABI, functionName: "reserve", args, account });
    return client.writeContract({
      address: contract(),
      abi: ALLOWANCE_ABI,
      functionName: "reserve",
      args,
      account,
      chain: null,
    });
  });
  const receipt = await reader.waitForTransactionReceipt({ hash: txHash, timeout: 120_000, pollingInterval: RECEIPT_POLL_MS });
  if (receipt.status !== "success") throw new Error(`reserve ${txHash} reverted`);

  for (const log of receipt.logs) {
    if (!sameAddress(log.address, contract())) continue;
    try {
      const ev = decodeEventLog({ abi: ALLOWANCE_ABI, data: log.data, topics: log.topics });
      if (ev.eventName !== "Reserved") continue;
      const a = ev.args;
      if (
        sameAddress(a.owner, r.owner) &&
        sameAddress(a.token, r.token) &&
        a.taskKey === r.taskKey &&
        a.agentKey === r.agentKey &&
        a.amount === r.amount
      ) {
        return { ...r, txHash };
      }
    } catch {
      /* another event from the same contract */
    }
  }
  throw new Error(`reserve ${txHash} landed without the Reserved event it should have emitted`);
}

async function sendBatch(functionName: "settleMany" | "releaseMany", taskKeys: Hex[]): Promise<Hex> {
  const { account, client } = operator();
  const reader = publicClient();
  const txHash = await queued(async () => {
    await reader.simulateContract({ address: contract(), abi: ALLOWANCE_ABI, functionName, args: [taskKeys], account });
    return client.writeContract({
      address: contract(),
      abi: ALLOWANCE_ABI,
      functionName,
      args: [taskKeys],
      account,
      chain: null,
    });
  });
  const receipt = await reader.waitForTransactionReceipt({ hash: txHash, timeout: 120_000, pollingInterval: RECEIPT_POLL_MS });
  if (receipt.status !== "success") throw new Error(`${functionName} ${txHash} reverted`);
  return txHash;
}

export const settleManyOnChain = (taskKeys: Hex[]) => sendBatch("settleMany", taskKeys);
export const releaseManyOnChain = (taskKeys: Hex[]) => sendBatch("releaseMany", taskKeys);

/**
 * The contract's refusal, in words for the person paying. The preflight catches these first, but two
 * hires racing past it land here, and "the allowance refused" tells nobody what to do next.
 */
const REFUSALS: Record<string, string> = {
  OverDailyLimit: "This hire is over your allowance's daily limit",
  OverTaskLimit: "This hire is over your allowance's per-task limit",
  InsufficientBalance: "Your allowance does not have enough available for this hire",
  AgentNotAllowed: "This agent is not on your allowance's allowed list",
  AllowancePaused: "Your allowance is paused",
  Expired: "Your allowance has expired",
  NoRules: "This wallet has no allowance set up for this token",
  ReservationsArePaused: "Allowance payments are paused right now",
};

export function contractRefusal(err: unknown): string | null {
  // viem nests the decoded reason a few causes deep, and a raw node error carries only the 4-byte
  // selector, so look at every layer and match either the name or its selector.
  const texts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    const x = e as { message?: string; shortMessage?: string; details?: string; data?: { errorName?: string } | string; signature?: string; cause?: unknown };
    texts.push(x.message ?? "", x.shortMessage ?? "", x.details ?? "", x.signature ?? "",
      typeof x.data === "string" ? x.data : x.data?.errorName ?? "");
    e = x.cause;
  }
  const all = texts.join(" ");
  const name = Object.keys(REFUSALS).find(
    (k) => new RegExp(`\\b${k}\\b`).test(all) || all.toLowerCase().includes(toFunctionSelector(`${k}()`).toLowerCase()),
  );
  return name ? REFUSALS[name] : null;
}
