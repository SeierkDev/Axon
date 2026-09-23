// An ETH invoice is settled by ETH, whatever else is switched on.
//
// This exists because the opposite shipped twice, in two different shapes, and neither time did
// anything throw.
//
// The first shape: this code read AXON_TOKEN_ADDRESS and took it to mean "the token a payment must
// arrive in", while that variable was set in production to mean "the token whose balances we check".
// Both tokens carry 18 decimals, so an invoice for 0.00025 ETH was satisfied by 0.00025 AXON.
//
// The second shape: settlement got its own variable, and then that same variable became the switch
// that turns paying in $AXON on. Switching the feature on would have made every ETH-priced invoice
// demand $AXON, on a network where every price, button and total says ETH.
//
// So the case under test is the combination that used to be fatal: the token feature fully enabled,
// and an ordinary ETH payment arriving. It must be accepted, and a token transfer of the same size
// must not stand in for it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const TREASURY = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PAYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const AXON = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const HASH = `0x${"a".repeat(64)}`;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PRICE_WEI = 250_000_000_000_000n; // 0.00025 ETH

const pad = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

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

/** Loads the money module with paying in $AXON switched on, as production would have it. */
async function loadWithAxonEnabled() {
  vi.resetModules();
  process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = TREASURY;
  process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
  delete process.env.AXON_PAYMENT_VERIFIER; // the mock verifier would answer before the chain does
  const money = await import("@/lib/money");
  const quote = await import("@/lib/axonQuote");
  const { resetRpcCircuit } = await import("@/lib/evm");
  resetRpcCircuit();
  return { money, quote };
}

describe("an ETH invoice, with paying in $AXON switched on", () => {
  const saved = { ...process.env };

  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it("is satisfied by a plain ETH transfer", async () => {
    const { money, quote } = await loadWithAxonEnabled();
    // The feature really is on, so this is not passing by accident.
    expect(quote.axonPaymentsEnabled()).toBe(true);

    stubNode(
      { from: PAYER, to: TREASURY, value: word(PRICE_WEI), blockNumber: "0x10" },
      { status: "0x1", logs: [] },
    );

    const r = await money.checkIncomingPayment(HASH, { amount: 0.00025, currency: "ETH", wei: PRICE_WEI });
    expect(r.ok).toBe(true);
  });

  it("is not satisfied by the same number of $AXON units", async () => {
    const { money } = await loadWithAxonEnabled();

    // A transaction that moved no ETH at all, but emitted a Transfer of the token for the same
    // number of units. This is exactly what used to be accepted, because both are 18 decimals.
    stubNode(
      { from: PAYER, to: AXON, value: word(0n), blockNumber: "0x10" },
      {
        status: "0x1",
        logs: [{
          address: AXON,
          topics: [TRANSFER_TOPIC, pad(PAYER), pad(TREASURY)],
          data: word(PRICE_WEI),
        }],
      },
    );

    const r = await money.checkIncomingPayment(HASH, { amount: 0.00025, currency: "ETH", wei: PRICE_WEI });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not go to the expected address|received 0 wei/);
  });

  it("still refuses an ETH transfer that is short", async () => {
    const { money } = await loadWithAxonEnabled();

    stubNode(
      { from: PAYER, to: TREASURY, value: word(PRICE_WEI - 1n), blockNumber: "0x10" },
      { status: "0x1", logs: [] },
    );

    const r = await money.checkIncomingPayment(HASH, { amount: 0.00025, currency: "ETH", wei: PRICE_WEI });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("expected");
  });
});
