// The chain layer: every call that leaves this process for a node goes through here.
//
// It replaces the Helius/Solana transport. The shape is deliberately the same as what it replaced —
// a circuit breaker in front of a retrying client, one verification function that answers WHY it
// said no, and a small number of sending primitives — because the callers above it were built
// around that shape and none of them should have to care which chain they are on.
//
// Robinhood Chain's node has measured limits that are not the usual ones: eth_getLogs caps on the
// number of RESULTS (10,000), not on the block span, and historical state is pruned. `getLogs` below
// is built around both facts rather than discovering them at runtime.

import { createPublicClient, createWalletClient, custom, parseEther, formatEther, decodeEventLog, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, CHAIN_NAME, RPC_URL } from "./chain";
import { normalizeAddress, sameAddress } from "./address";
import { logger } from "./logger";

export const PAYMENT_RECEIVER_WALLET_ADDRESS =
  process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ??
  process.env.NEXT_PUBLIC_WALLET_ADDRESS ??
  "";

/** Native currency has 18 decimals, the same everywhere on an EVM chain. */
export const NATIVE_DECIMALS = 18;

export function rpcUrl(): string {
  return process.env.AXON_RPC_URL?.trim() || RPC_URL;
}

// ── Circuit breaker ───────────────────────────────────────────────────────────
// After 5 consecutive failures the circuit opens and calls fail fast for 60s. After that window one
// probe is allowed: on success the circuit closes, on failure the recovery window restarts.

const FAILURE_THRESHOLD = 5;
const RECOVERY_WINDOW_MS = 60_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 300;

type CircuitState = "closed" | "open" | "half-open";

interface Circuit {
  state: CircuitState;
  failures: number;
  openedAt: number | null;
}

const _circuit: Circuit = { state: "closed", failures: 0, openedAt: null };

/**
 * Worth retrying, or a real answer?
 *
 * Only transport-level trouble is transient. A node that returns a JSON-RPC error has answered the
 * question, and retrying it just burns the budget and delays the truth.
 */
export function isTransientRpcError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (/econnreset|etimedout|econnrefused|socket hang up|fetch failed|aborted|timeout/i.test(msg)) return true;
  return /\b(429|502|503|504)\b/.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`RPC circuit is open, retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = "CircuitOpenError";
    this.retryAfterMs = retryAfterMs;
  }
}

function advanceCircuitState(): CircuitState {
  if (_circuit.state === "open" && _circuit.openedAt !== null) {
    if (Date.now() - _circuit.openedAt >= RECOVERY_WINDOW_MS) {
      _circuit.state = "half-open";
      // Reset so consecutiveFailures reflects only the probe result, not the accumulated
      // pre-open failures, which are irrelevant once we are probing.
      _circuit.failures = 0;
    }
  }
  return _circuit.state;
}

/** One JSON-RPC call, with no retry and no circuit. The thing `withRpc` retries. */
async function rawRpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`node returned HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message?: string; code?: number } };
  if (j.error) throw new Error(j.error.message ?? "the node refused the call");
  return j.result as T;
}

/**
 * Run one node call behind the breaker, retrying only what is worth retrying.
 *
 * `fn` receives a request function rather than a client so a caller can make several calls inside a
 * single breaker decision, the way the Solana version handed out a connection.
 */
export interface WithRpcOptions {
  /**
   * Errors this caller is going to handle itself, and which say nothing about the node's health.
   *
   * The breaker exists to stop hammering a node that is DOWN. A node that replies "that query is too
   * big" is up and answering, and counting its answer as a failure opens the circuit part-way
   * through a sweep that was working exactly as designed. Such an error is still thrown; it is only
   * kept off the failure count.
   */
  expected?: (err: unknown) => boolean;
}

export async function withRpc<T>(
  fn: (request: <R>(method: string, params?: unknown[]) => Promise<R>) => Promise<T>,
  opts: WithRpcOptions = {},
): Promise<T> {
  const state = advanceCircuitState();
  if (state === "open") {
    const retryAfterMs = RECOVERY_WINDOW_MS - (Date.now() - _circuit.openedAt!);
    throw new CircuitOpenError(Math.max(0, retryAfterMs));
  }

  // Half-open allows a single probe with no retries, so recovery is not delayed by a slow retry loop
  const maxAttempts = state === "half-open" ? 1 : MAX_RETRIES;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const jitter = 0.8 + Math.random() * 0.4; // ±20%
      // A 429 is the node naming its own rate rather than failing, so back off harder for it than
      // for a dropped connection.
      const base = lastErr instanceof Error && /\b429\b/.test(lastErr.message) ? BASE_DELAY_MS * 4 : BASE_DELAY_MS;
      await sleep(Math.min(base * 2 ** (attempt - 1) * jitter, 8_000));
    }
    try {
      const result = await fn(<R,>(method: string, params: unknown[] = []) => rawRpc<R>(method, params));
      _circuit.state = "closed";
      _circuit.failures = 0;
      _circuit.openedAt = null;
      return result;
    } catch (err) {
      lastErr = err;
      // An error the caller expects is its business, not the breaker's: hand it straight back
      // without retrying it or holding it against the node.
      if (opts.expected?.(err)) throw err;
      if (!isTransientRpcError(err) || attempt === maxAttempts - 1) break;
    }
  }

  // All attempts exhausted counts as ONE failure toward the threshold, not one per attempt
  _circuit.failures++;
  if (_circuit.state === "half-open" || _circuit.failures >= FAILURE_THRESHOLD) {
    const alreadyOpen = _circuit.state === "open";
    _circuit.state = "open";
    _circuit.openedAt = Date.now();
    if (!alreadyOpen) {
      logger.error("rpc.circuit_opened", `Circuit breaker opened, ${CHAIN_NAME} RPC is failing`, {
        consecutiveFailures: _circuit.failures,
        recoveryWindowMs: RECOVERY_WINDOW_MS,
      });
    }
  }
  throw lastErr;
}

export function getRpcCircuitState(): { state: CircuitState; consecutiveFailures: number } {
  advanceCircuitState();
  return { state: _circuit.state, consecutiveFailures: _circuit.failures };
}

export function resetRpcCircuit(): void {
  _circuit.state = "closed";
  _circuit.failures = 0;
  _circuit.openedAt = null;
}

// ── viem clients ──────────────────────────────────────────────────────────────
// viem does the encoding and decoding; the transport is ours, so every call viem makes is retried
// and counted by the breaker above rather than going straight out to the node.

export const chainDef = {
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: NATIVE_DECIMALS },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const brokeredTransport = custom({
  request: ({ method, params }) => withRpc((request) => request(method, (params as unknown[]) ?? [])),
});

export function publicClient() {
  return createPublicClient({ chain: chainDef, transport: brokeredTransport });
}

export function walletClientFor(privateKey: string) {
  const account = privateKeyToAccount(asPrivateKey(privateKey));
  return { account, client: createWalletClient({ account, chain: chainDef, transport: brokeredTransport }) };
}

/** A private key as viem wants it, with a message that says what is wrong rather than throwing raw. */
function asPrivateKey(raw: string): Hex {
  const t = raw.trim();
  const hex = t.startsWith("0x") ? t : `0x${t}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("private key must be 32 bytes of hex, with or without the 0x prefix");
  }
  return hex as Hex;
}

// ── Reading ───────────────────────────────────────────────────────────────────

export async function blockNumber(): Promise<bigint> {
  return withRpc(async (request) => BigInt(await request<string>("eth_blockNumber")));
}

export async function balanceOf(address: string): Promise<bigint> {
  const a = normalizeAddress(address);
  if (!a) throw new Error(`balanceOf: '${address}' is not an address`);
  return withRpc(async (request) => BigInt(await request<string>("eth_getBalance", [a, "latest"])));
}

/**
 * The node caps eth_getLogs on the number of RESULTS, not on the block span, so a wide quiet range
 * is fine and a narrow busy one is not.
 *
 * Measured against the live node: going over the cap is not a truncated response, it is a refusal —
 * "logs matched by query exceeds limit of 10000". That distinction is the whole implementation. A
 * refusal has to be caught and the range halved until each piece is answerable, and an assumption
 * that the node truncates instead would mean this splitting never runs at all.
 *
 * A response that arrives exactly at the cap is still treated as suspect, because a different node
 * behind the same URL may well truncate rather than refuse.
 */
const LOGS_BLOCK_CHUNK = 100_000n;
const LOGS_RESULT_CAP = 10_000;

/**
 * A sweep is the one call here that fans out: each refusal doubles the number of requests, and a
 * wide range turns into dozens of them back to back. The node rate-limits that (measured: HTTP 429
 * part-way through a 100k-block sweep), so the requests are spaced. The gap costs a couple of
 * seconds on a sweep that takes minutes and is the difference between finishing and being cut off.
 */
const LOGS_MIN_GAP_MS = 120;
let lastLogQueryAt = 0;

async function paceLogQuery(): Promise<void> {
  const wait = lastLogQueryAt + LOGS_MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastLogQueryAt = Date.now();
}

function isOverLogLimit(err: unknown): boolean {
  return err instanceof Error && /exceeds limit|too many results|query returned more than/i.test(err.message);
}

export interface LogFilter {
  address?: string | string[];
  topics?: (string | string[] | null)[];
}

export async function getLogs(fromBlock: bigint, toBlock: bigint, filter: LogFilter = {}): Promise<unknown[]> {
  const out: unknown[] = [];

  const split = async (from: bigint, to: bigint): Promise<void> => {
    const mid = from + (to - from) / 2n;
    await fetchRange(from, mid);
    await fetchRange(mid + 1n, to);
  };

  const fetchRange = async (from: bigint, to: bigint): Promise<void> => {
    const params = [{
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      ...(filter.address ? { address: filter.address } : {}),
      ...(filter.topics ? { topics: filter.topics } : {}),
    }];

    let logs: unknown[];
    try {
      await paceLogQuery();
      logs = await withRpc(
        (request) => request<unknown[]>("eth_getLogs", params),
        // Being told the range is too big is the signal this function is built around, not a fault.
        { expected: isOverLogLimit },
      );
    } catch (err) {
      // The node refuses rather than truncates. One block that alone exceeds the cap cannot be
      // narrowed any further, so say so instead of returning a slice of the truth.
      if (!isOverLogLimit(err)) throw err;
      if (to === from) {
        throw new Error(
          `block ${from} alone exceeds the node's ${LOGS_RESULT_CAP}-log limit; narrow the filter`,
        );
      }
      await split(from, to);
      return;
    }

    // Belt and braces for a node that truncates silently instead: a response sitting exactly at the
    // cap is indistinguishable from a complete one, so it is not trusted either.
    if (logs.length >= LOGS_RESULT_CAP && to > from) {
      await split(from, to);
      return;
    }
    out.push(...logs);
  };

  for (let from = fromBlock; from <= toBlock; from += LOGS_BLOCK_CHUNK) {
    const to = from + LOGS_BLOCK_CHUNK - 1n > toBlock ? toBlock : from + LOGS_BLOCK_CHUNK - 1n;
    await fetchRange(from, to);
  }
  return out;
}

// ── Verifying an incoming payment ─────────────────────────────────────────────

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20_TRANSFER_EVENT = {
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
} as const;

export interface TransferCheck {
  /** the transaction that is claimed to have paid */
  txHash: string;
  /** who had to be paid */
  to: string;
  /** the smallest acceptable amount, in the token's own units (wei for native) */
  minValue: bigint;
  /** an ERC-20 address, or omitted for the chain's native currency */
  token?: string;
  /** when given, the transaction must also have been sent by this address */
  from?: string;
}

interface RpcTx {
  from: string;
  to: string | null;
  value: string;
  blockNumber: string | null;
}

interface RpcReceipt {
  status: string;
  logs: { address: string; topics: string[]; data: string }[];
}

/**
 * Did this transaction actually pay?
 *
 * Returns the reason as well as the verdict, because the callers above turn a refusal into something
 * a person reads. "Not confirmed" and "you paid the wrong address" need different actions.
 */
export async function verifyTransfer(check: TransferCheck): Promise<{ ok: boolean; reason: string }> {
  const recipient = normalizeAddress(check.to);
  if (!recipient) return { ok: false, reason: "the address that should have been paid is not an address" };
  if (check.minValue <= 0n) return { ok: false, reason: "expected payment amount is invalid" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(check.txHash.trim())) {
    return { ok: false, reason: "that is not a transaction hash" };
  }

  // A node lags the sender: the wallet reports the hash the moment it broadcasts, and asking for the
  // transaction immediately often returns nothing at all. Polling briefly is the difference between
  // accepting a good payment and 402-ing it.
  let tx: RpcTx | null = null;
  const ATTEMPTS = 16;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    tx = await withRpc((request) => request<RpcTx | null>("eth_getTransactionByHash", [check.txHash]));
    if (tx?.blockNumber) break;
    if (attempt < ATTEMPTS - 1) await sleep(2000);
  }
  if (!tx) return { ok: false, reason: "transaction not found on-chain (not yet confirmed, or wrong hash)" };
  if (!tx.blockNumber) return { ok: false, reason: "transaction is still pending, not yet in a block" };

  const receipt = await withRpc((request) =>
    request<RpcReceipt | null>("eth_getTransactionReceipt", [check.txHash]),
  );
  if (!receipt) return { ok: false, reason: "transaction has no receipt yet" };
  // A reverted transaction still has a hash and still appears on-chain. Anyone treating the hash
  // alone as proof of payment would be accepting failures.
  if (BigInt(receipt.status) !== 1n) return { ok: false, reason: "transaction reverted on-chain" };

  if (check.from && !sameAddress(tx.from, check.from)) {
    return { ok: false, reason: "transaction was not sent by the expected payer" };
  }

  if (!check.token) {
    if (!sameAddress(tx.to, recipient)) {
      return { ok: false, reason: "the payment did not go to the expected address" };
    }
    const received = BigInt(tx.value);
    if (received >= check.minValue) return { ok: true, reason: "ok" };
    return { ok: false, reason: `received ${received} wei, expected ${check.minValue}` };
  }

  const token = normalizeAddress(check.token);
  if (!token) return { ok: false, reason: "the token address is not an address" };

  // Sum every Transfer to the recipient in this transaction, rather than taking the first. A payment
  // routed through a contract can arrive in more than one log, and reading only one would undercount
  // a payment that was genuinely made in full.
  let received = 0n;
  for (const log of receipt.logs) {
    if (!sameAddress(log.address, token)) continue;
    if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    try {
      const decoded = decodeEventLog({
        abi: [ERC20_TRANSFER_EVENT],
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      const args = decoded.args as unknown as { to: Address; value: bigint };
      if (sameAddress(args.to, recipient)) received += args.value;
    } catch {
      /* a log that will not decode as a Transfer is not one */
    }
  }

  if (received === 0n) {
    return { ok: false, reason: "no token transfer to the expected address in this transaction" };
  }
  if (received >= check.minValue) return { ok: true, reason: "ok" };
  return { ok: false, reason: `received ${received} token units, expected ${check.minValue}` };
}

// ── Sending ───────────────────────────────────────────────────────────────────

/** The wallet that pays out, checked against the address everyone is told to pay. */
function refundSigner() {
  const rawKey = process.env.REFUND_SIGNER_PRIVATE_KEY;
  if (!rawKey) throw new Error("REFUND_SIGNER_PRIVATE_KEY is not set");
  if (!PAYMENT_RECEIVER_WALLET_ADDRESS) throw new Error("PAYMENT_RECEIVER_WALLET_ADDRESS is not set");

  const { account, client } = walletClientFor(rawKey);
  // The guard that matters: a key for a different wallet would send real funds from somewhere
  // nobody intended, and there is no undoing it.
  if (!sameAddress(account.address, PAYMENT_RECEIVER_WALLET_ADDRESS)) {
    throw new Error(
      "REFUND_SIGNER_PRIVATE_KEY does not match PAYMENT_RECEIVER_WALLET_ADDRESS, refund aborted to prevent loss of funds",
    );
  }
  return { account, client };
}

/**
 * Send native currency and wait for it to land.
 *
 * Confirmation is a receipt, not a guess: viem polls for one and a reverted transaction throws here
 * rather than being reported as paid.
 */
export async function sendNative(toAddress: string, amountEth: string | number): Promise<string> {
  const to = normalizeAddress(toAddress);
  if (!to) throw new Error(`sendNative: '${toAddress}' is not an address`);
  const value = parseEther(String(amountEth));
  if (value <= 0n) throw new Error("sendNative: amount must be positive");

  const { client } = refundSigner();
  const hash = await client.sendTransaction({ to: to as Address, value });
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain`);
  return hash;
}

/** Pay from an arbitrary funded wallet, for an agent that holds its own key. */
export async function payNative(
  payerPrivateKey: string,
  toAddress: string,
  amountEth: string | number,
): Promise<{ hash: string; payerWallet: string }> {
  const to = normalizeAddress(toAddress);
  if (!to) throw new Error(`payNative: '${toAddress}' is not an address`);
  const value = parseEther(String(amountEth));
  if (value <= 0n) throw new Error("payNative: amount must be positive");

  const { account, client } = walletClientFor(payerPrivateKey);
  const hash = await client.sendTransaction({ to: to as Address, value });
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted on-chain`);
  return { hash, payerWallet: account.address.toLowerCase() };
}

/**
 * Write a string to the chain.
 *
 * On an EVM chain there is no memo program: the idiom is a zero-value transaction to yourself
 * carrying the text as calldata, which costs only gas and is readable by anyone with the hash.
 */
export async function postMemoTransaction(memo: string): Promise<string> {
  const rawKey = process.env.REFUND_SIGNER_PRIVATE_KEY;
  if (!rawKey) throw new Error("REFUND_SIGNER_PRIVATE_KEY is not set");
  const { account, client } = walletClientFor(rawKey);

  const data = `0x${Buffer.from(memo, "utf8").toString("hex")}` as Hex;
  const hash = await client.sendTransaction({ to: account.address, value: 0n, data });
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`memo transaction ${hash} reverted on-chain`);
  return hash;
}

export { formatEther, parseEther };
