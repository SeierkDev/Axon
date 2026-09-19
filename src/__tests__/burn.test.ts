// Forwarding what the platform earned to the Splitter.
//
// This is the path that moves real money out of the treasury, so the cases below are the ways it
// could move the wrong amount, move it twice, or lose track of it: a run that fails partway, two
// runs overlapping, a ledger that claims more than the wallet holds, and a split that does not go
// through after the ETH has already left.
//
// The node is stubbed. What is under test is the bookkeeping around the transfer, not viem.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { parseTransaction } from "viem";
import { getDb } from "@/lib/db";
import { toWei } from "@/lib/money";

const TREASURY = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const TREASURY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SPLITTER = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
const POT = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";

/** A queued platform earning, exactly as releasePayment writes one. */
function queueEarning(amountEth: number, status = "pending"): string {
  const txId = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at, burn_status)
       VALUES (?, NULL, 'payer', 'platform-agent', ?, 'completed', NULL, 0, 'ETH', ?, ?, ?)`,
    )
    .run(txId, amountEth, now, now, status);
  return txId;
}

const burnStatus = (txId: string): string | null =>
  (getDb().prepare("SELECT burn_status FROM transactions WHERE tx_id = ?").get(txId) as { burn_status: string | null })
    .burn_status;

/**
 * A node that answers the handful of calls this path makes.
 * `balance` is what the treasury holds; `failOn` makes one method fail.
 */
function stubNode(opts: { balance?: bigint; failOn?: string; receiptStatus?: string } = {}) {
  const sent: { to: string; value?: bigint; data?: string }[] = [];
  const balance = opts.balance ?? toWei(1000)!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const method = body.method as string;
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (method === opts.failOn) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "node said no" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    switch (method) {
      case "eth_getBalance": return reply(`0x${balance.toString(16)}`);
      case "eth_chainId": return reply("0x1237");
      case "eth_gasPrice": return reply("0x3b9aca00");
      case "eth_maxPriorityFeePerGas": return reply("0x3b9aca00");
      case "eth_estimateGas": return reply("0x5208");
      case "eth_getTransactionCount": return reply("0x0");
      case "eth_blockNumber": return reply("0x10");
      case "eth_getBlockByNumber": return reply({ baseFeePerGas: "0x3b9aca00", number: "0x10", timestamp: "0x0" });
      case "eth_sendRawTransaction": {
        // Decode what was actually signed. Asserting on the arguments we passed in would only
        // prove the test called the function; this proves what left the wallet.
        const tx = parseTransaction(body.params[0] as `0x${string}`);
        sent.push({ to: tx.to ?? "", value: tx.value, data: tx.data });
        return reply(`0x${"a".repeat(64)}`);
      }
      case "eth_getTransactionReceipt":
        return reply({ status: opts.receiptStatus ?? "0x1", blockNumber: "0x11", logs: [], transactionHash: `0x${"a".repeat(64)}` });
      default: return reply(null);
    }
  });
  return { sent };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = TREASURY;
  process.env.REFUND_SIGNER_PRIVATE_KEY = TREASURY_KEY;
  process.env.AXON_SPLITTER_ADDRESS = SPLITTER;
  getDb().prepare("UPDATE transactions SET burn_status = NULL WHERE burn_status IS NOT NULL").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AXON_SPLITTER_ADDRESS;
  delete process.env.AXON_BURN_POT_ADDRESS;
  delete process.env.REFUND_SIGNER_PRIVATE_KEY;
});

describe("forwardEarningsToSplitter: refusing to act", () => {
  it("does nothing at all when no Splitter is configured", async () => {
    delete process.env.AXON_SPLITTER_ADDRESS;
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    const tx = queueEarning(5);
    const r = await forwardEarningsToSplitter();
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/AXON_SPLITTER_ADDRESS/);
    // and crucially leaves the queue untouched, so nothing is lost by being unconfigured
    expect(burnStatus(tx)).toBe("pending");
  });

  it("leaves dust queued rather than spending gas on it", async () => {
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    const tx = queueEarning(0.0000001);
    const r = await forwardEarningsToSplitter();
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/minimum/);
    expect(burnStatus(tx)).toBe("pending"); // back on the queue, not written off
  });

  // The ledger records what was earned. The wallet is the authority on what can actually be sent.
  it("refuses when the treasury holds less than the ledger says is queued", async () => {
    stubNode({ balance: toWei(0.5)! });
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    const tx = queueEarning(5);
    const r = await forwardEarningsToSplitter();
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/holds .* less than/);
    expect(burnStatus(tx)).toBe("pending");
  });
});

describe("forwardEarningsToSplitter: the happy path", () => {
  it("forwards the queued total and settles the rows", async () => {
    const { sent } = stubNode();
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    const a = queueEarning(2);
    const b = queueEarning(3);

    const r = await forwardEarningsToSplitter();
    expect(r.skipped).toBe(false);
    expect(r.forwardedEth).toBe(5); // the sum, not one of them
    expect(r.transferHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(burnStatus(a)).toBe("burned");
    expect(burnStatus(b)).toBe("burned");

    // What actually went on the wire: the exact queued total, to the Splitter.
    const transfer = sent.find((s) => s.value && s.value > 0n)!;
    expect(transfer.to.toLowerCase()).toBe(SPLITTER);
    expect(transfer.value).toBe(toWei(5)!);

    // followed by a zero-value call to the same address: distribute()
    const call = sent.find((s) => s.data && s.data !== "0x")!;
    expect(call.to.toLowerCase()).toBe(SPLITTER);
    expect(call.data?.slice(0, 10)).toBe("0xe4fc6b6d"); // distribute()
  });

  it("does not pick up the same earnings twice", async () => {
    stubNode();
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    queueEarning(2);

    const first = await forwardEarningsToSplitter();
    expect(first.skipped).toBe(false);

    // nothing left pending, so a second run has nothing to send
    const second = await forwardEarningsToSplitter();
    expect(second.skipped).toBe(true);
    expect(second.pendingEth).toBe(0);
  });

  it("ignores earnings that were never queued for the burn", async () => {
    stubNode();
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    queueEarning(2);
    const notQueued = queueEarning(50, "burned"); // already settled in an earlier run

    const r = await forwardEarningsToSplitter();
    expect(r.forwardedEth).toBe(2);
    expect(burnStatus(notQueued)).toBe("burned");
  });
});

describe("forwardEarningsToSplitter: when something goes wrong", () => {
  // The money did not move, so the rows must go back. Leaving them claimed would write off real
  // earnings on a transient node failure.
  it("returns the rows to the queue when the transfer fails", async () => {
    stubNode({ failOn: "eth_sendRawTransaction" });
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    const tx = queueEarning(2);

    await expect(forwardEarningsToSplitter()).rejects.toThrow();
    expect(burnStatus(tx)).toBe("pending");
  });

  it("returns the rows to the queue when the transfer reverts", async () => {
    stubNode({ receiptStatus: "0x0" });
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    const tx = queueEarning(2);

    await expect(forwardEarningsToSplitter()).rejects.toThrow(/reverted/);
    expect(burnStatus(tx)).toBe("pending");
  });

  it("refuses to send from a wallet that is not the treasury", async () => {
    stubNode();
    process.env.REFUND_SIGNER_PRIVATE_KEY =
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
    const { forwardEarningsToSplitter } = await import("@/lib/burn");
    const tx = queueEarning(2);

    await expect(forwardEarningsToSplitter()).rejects.toThrow(/does not match PAYMENT_RECEIVER/);
    expect(burnStatus(tx)).toBe("pending");
  });
});

describe("getBurnStats", () => {
  it("reports what was forwarded and what is still queued", async () => {
    const { getBurnStats } = await import("@/lib/burn");
    queueEarning(3, "burned");
    queueEarning(1, "pending");

    const s = await getBurnStats();
    expect(s.totalForwardedEth).toBe(3);
    expect(s.totalForwards).toBe(1);
    expect(s.pendingEth).toBe(1);
  });

  // The ledger cannot know what burned: the pot burns on its own schedule, long after the money
  // arrives. Saying nothing is better than reporting a forwarded total as if it were burned.
  it("omits the on-chain figures when no pot is configured", async () => {
    const { getBurnStats } = await import("@/lib/burn");
    const s = await getBurnStats();
    expect(s.onChain).toBeUndefined();
  });

  it("still reports the ledger half when the pot cannot be read", async () => {
    process.env.AXON_BURN_POT_ADDRESS = POT;
    stubNode({ failOn: "eth_call" });
    const { getBurnStats } = await import("@/lib/burn");
    queueEarning(2, "burned");

    const s = await getBurnStats();
    expect(s.totalForwardedEth).toBe(2);
    expect(s.onChain).toBeUndefined();
  });
});
