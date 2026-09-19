// Whether a transaction actually paid.
//
// This is the function that decides money changed hands, so the cases below are the ways a caller
// could be fooled: a reverted transaction that still has a hash, a payment to the wrong address, a
// payment from the wrong person, a token transfer that is short, and a node that has not caught up
// yet. Each one is answered by a stubbed node rather than a live one, so the logic is what is under
// test and nothing here depends on a chain being reachable.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyTransfer, resetRpcCircuit } from "@/lib/evm";

const TREASURY = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const TOKEN = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const HASH = `0x${"a".repeat(64)}`;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const pad = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

/** Answers the two calls verifyTransfer makes, and nothing else. */
function stubNode(tx: unknown, receipt: unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const result =
      body.method === "eth_getTransactionByHash" ? tx :
      body.method === "eth_getTransactionReceipt" ? receipt :
      null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

const paidTx = (over: Record<string, unknown> = {}) => ({
  from: PAYER, to: TREASURY, value: word(1_000_000_000_000_000_000n), blockNumber: "0x10", ...over,
});
const okReceipt = (logs: unknown[] = []) => ({ status: "0x1", logs });

beforeEach(() => resetRpcCircuit());
afterEach(() => vi.restoreAllMocks());

describe("verifyTransfer: native payments", () => {
  it("accepts a confirmed payment of the right size to the right address", async () => {
    stubNode(paidTx(), okReceipt());
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 10n ** 18n });
    expect(r).toEqual({ ok: true, reason: "ok" });
  });

  it("accepts an overpayment", async () => {
    stubNode(paidTx({ value: word(2n * 10n ** 18n) }), okReceipt());
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 10n ** 18n });
    expect(r.ok).toBe(true);
  });

  it("refuses an underpayment and says by how much", async () => {
    stubNode(paidTx({ value: word(5n * 10n ** 17n) }), okReceipt());
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 10n ** 18n });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/received 500000000000000000 wei, expected 1000000000000000000/);
  });

  // A reverted transaction still has a hash and still exists on-chain. Treating the hash as proof
  // of payment would accept every failure.
  it("refuses a transaction that reverted", async () => {
    stubNode(paidTx(), { status: "0x0", logs: [] });
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 10n ** 18n });
    expect(r).toEqual({ ok: false, reason: "transaction reverted on-chain" });
  });

  it("refuses a payment that went somewhere else", async () => {
    stubNode(paidTx({ to: PAYER }), okReceipt());
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 10n ** 18n });
    expect(r.reason).toMatch(/did not go to the expected address/);
  });

  it("refuses a payment from the wrong payer when one is named", async () => {
    stubNode(paidTx(), okReceipt());
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 10n ** 18n, from: TOKEN });
    expect(r.reason).toMatch(/not sent by the expected payer/);
  });

  it("matches the payer whatever case it arrives in", async () => {
    stubNode(paidTx(), okReceipt());
    const r = await verifyTransfer({
      txHash: HASH, to: TREASURY.toUpperCase().replace("0X", "0x"),
      minValue: 10n ** 18n, from: PAYER.toUpperCase().replace("0X", "0x"),
    });
    expect(r.ok).toBe(true);
  });

  it("refuses a transaction that is still pending", async () => {
    stubNode(paidTx({ blockNumber: null }), okReceipt());
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 10n ** 18n });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/still pending|not found/);
  }, 60_000);

  it("refuses a hash that is not a hash, without calling the node", async () => {
    const fetchSpy = stubNode(paidTx(), okReceipt());
    const r = await verifyTransfer({ txHash: "nope", to: TREASURY, minValue: 10n ** 18n });
    expect(r.reason).toMatch(/not a transaction hash/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a zero expected amount", async () => {
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 0n });
    expect(r.reason).toMatch(/expected payment amount is invalid/);
  });
});

describe("verifyTransfer: token payments", () => {
  const transferLog = (to: string, value: bigint, token = TOKEN) => ({
    address: token,
    topics: [TRANSFER_TOPIC, pad(PAYER), pad(to)],
    data: word(value),
  });

  it("accepts a Transfer of the right size to the right address", async () => {
    stubNode(paidTx({ to: TOKEN, value: word(0n) }), okReceipt([transferLog(TREASURY, 250_000n)]));
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 250_000n, token: TOKEN });
    expect(r).toEqual({ ok: true, reason: "ok" });
  });

  // A payment routed through a contract can land in more than one log. Reading only the first would
  // undercount a payment that was genuinely made in full.
  it("adds up several transfers to the same recipient", async () => {
    stubNode(
      paidTx({ to: TOKEN, value: word(0n) }),
      okReceipt([transferLog(TREASURY, 100_000n), transferLog(TREASURY, 150_000n)]),
    );
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 250_000n, token: TOKEN });
    expect(r.ok).toBe(true);
  });

  it("ignores transfers of a different token", async () => {
    stubNode(paidTx({ to: TOKEN, value: word(0n) }), okReceipt([transferLog(TREASURY, 250_000n, PAYER)]));
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 250_000n, token: TOKEN });
    expect(r.reason).toMatch(/no token transfer to the expected address/);
  });

  it("ignores transfers to somebody else", async () => {
    stubNode(paidTx({ to: TOKEN, value: word(0n) }), okReceipt([transferLog(PAYER, 250_000n)]));
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 250_000n, token: TOKEN });
    expect(r.reason).toMatch(/no token transfer to the expected address/);
  });

  it("refuses a short token payment", async () => {
    stubNode(paidTx({ to: TOKEN, value: word(0n) }), okReceipt([transferLog(TREASURY, 100_000n)]));
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 250_000n, token: TOKEN });
    expect(r.reason).toMatch(/received 100000 token units, expected 250000/);
  });

  // Native value sitting in the same transaction is not the token payment that was owed.
  it("does not let attached native value stand in for the token", async () => {
    stubNode(paidTx({ to: TREASURY, value: word(10n ** 18n) }), okReceipt([]));
    const r = await verifyTransfer({ txHash: HASH, to: TREASURY, minValue: 250_000n, token: TOKEN });
    expect(r.ok).toBe(false);
  });
});
