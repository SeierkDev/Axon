import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Quoting $AXON to a machine.
 *
 * x402's `accepts` is a list, so this adds a way to pay rather than replacing the one that was there.
 * That is most of what these tests check: a client that has never heard of the token must see exactly
 * what it saw before, in the same place, and keep paying in ETH without knowing anything happened.
 */

const AXON = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const SQRT_P = 468867624989588479258801841136883n;

let transferOk = true;
let n = 0;
const nextTx = () => `0x${(++n).toString(16).padStart(64, "0")}`;

const load = async () => {
  vi.resetModules();
  vi.doMock("@/lib/axonPool", async () => {
    const actual = await vi.importActual<typeof import("@/lib/axonPool")>("@/lib/axonPool");
    return { ...actual, readPoolPrice: vi.fn(async () => ({ sqrtPriceX96: SQRT_P, axonPerEth: 35_022_030 })) };
  });
  vi.doMock("@/lib/evm", async () => {
    const actual = await vi.importActual<typeof import("@/lib/evm")>("@/lib/evm");
    return {
      ...actual,
      verifyTransfer: vi.fn(async () => (transferOk ? { ok: true, reason: "ok" } : { ok: false, reason: "no transfer" })),
    };
  });
  const mods = { x402: await import("@/lib/x402"), db: (await import("@/lib/db")).getDb() };
  try { mods.db.prepare("DELETE FROM axon_quotes").run(); } catch { /* not present */ }
  return mods;
};

// Opted in, because offering the token is the agent's decision and the option is not shown otherwise.
// Whether that decision is respected is covered in axonTerms.test.ts; here it is a precondition.
const REQ = {
  resource: "https://axon-agents.com/api/agents/a/x402",
  price: "0.00025 ETH",
  description: "a task",
  axon: { acceptsAxon: true },
};

describe("what a machine is offered", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    transferOk = true;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = RECEIVER;
    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("offers only ETH while token settlement is off", async () => {
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon(REQ);

    expect(req?.accepts).toHaveLength(1);
    expect(req?.accepts[0].asset).toBe("ETH");
  });

  it("adds the token alongside ETH rather than instead of it", async () => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon(REQ);

    expect(req?.accepts).toHaveLength(2);
    // A client that never heard of the token finds its option exactly where it always was.
    expect(req?.accepts[0].asset).toBe("ETH");
    expect(req?.accepts[0].maxAmountRequired).toBe("250000000000000");

    const axon = req!.accepts[1];
    expect(axon.asset).toBe(AXON);
    expect(axon.extra.contractAddress).toBe(AXON);
    expect(axon.extra.quoteId).toBeTruthy();
    // Thousands of tokens, not a fraction of one. The two options are the same debt in different units.
    expect(BigInt(axon.maxAmountRequired)).toBeGreaterThan(8_000n * 10n ** 18n);
  });

  it("gives the same quote to a client that asks twice in the same window", async () => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    const mods = await load();

    const a = await mods.x402.buildX402RequirementsWithAxon(REQ);
    const b = await mods.x402.buildX402RequirementsWithAxon(REQ);

    // A 402 is cheap to ask for and a crawler could ask a thousand times. Without this, each ask
    // would write a row and offer a slightly different price.
    expect(b?.accepts[1].extra.quoteId).toBe(a?.accepts[1].extra.quoteId);
    const rows = mods.db.prepare("SELECT COUNT(*) AS n FROM axon_quotes").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("falls back to ETH alone rather than failing when there is no price", async () => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    vi.resetModules();
    vi.doMock("@/lib/axonPool", async () => {
      const actual = await vi.importActual<typeof import("@/lib/axonPool")>("@/lib/axonPool");
      return { ...actual, readPoolPrice: vi.fn(async () => null) };
    });
    const x402 = await import("@/lib/x402");

    const req = await x402.buildX402RequirementsWithAxon(REQ);

    // A 402 that cannot be answered is worse than one offering a single way to pay.
    expect(req?.accepts).toHaveLength(1);
    expect(req?.accepts[0].asset).toBe("ETH");
  });

  it("gives the deadline the quote will actually be held to", async () => {
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon(REQ);

    const deadline = req!.accepts[1].requiredDeadlineSeconds;
    expect(deadline).toBeGreaterThan(0);
    // Telling a client it has longer than the quote lives would be inviting it to pay into a refusal.
    expect(deadline).toBeLessThanOrEqual(600);
  });
});

describe("what a machine is held to when it pays", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    transferOk = true;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = RECEIVER;
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("checks a token payment against its quote, not against the ETH price", async () => {
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon(REQ);
    const quoteId = req!.accepts[1].extra.quoteId!;

    const header = mods.x402.decodePaymentHeader(
      mods.x402.buildPaymentHeader(nextTx(), PAYER, req!.accepts[1].network, quoteId),
    );
    const result = await mods.x402.verifyX402Payment(header!, REQ.price);

    // Checking the ETH price here would refuse every token payment ever made: 0.00025 and 8,755 are
    // the same debt, but they are not the same number.
    expect(result.valid).toBe(true);
  });

  it("still verifies an ETH payment the old way", async () => {
    const mods = await load();
    const header = mods.x402.decodePaymentHeader(
      mods.x402.buildPaymentHeader(nextTx(), PAYER, `eip155:4663`),
    );

    expect(header?.payload.quoteId).toBeUndefined();
    // No quote, so nothing about the token path is reached at all.
    const result = await mods.x402.verifyX402Payment(header!, REQ.price);
    expect(result.valid).toBe(true);
  });

  it("refuses a quote that was already paid", async () => {
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon(REQ);
    const quoteId = req!.accepts[1].extra.quoteId!;
    const network = req!.accepts[1].network;

    const first = mods.x402.decodePaymentHeader(mods.x402.buildPaymentHeader(nextTx(), PAYER, network, quoteId))!;
    const second = mods.x402.decodePaymentHeader(mods.x402.buildPaymentHeader(nextTx(), PAYER, network, quoteId))!;

    expect((await mods.x402.verifyX402Payment(first, REQ.price)).valid).toBe(true);
    // A second transaction against a spent quote is somebody paying for a resource twice.
    expect((await mods.x402.verifyX402Payment(second, REQ.price)).valid).toBe(false);
  });

  it("refuses a quote when the transfer was not there", async () => {
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon(REQ);
    const quoteId = req!.accepts[1].extra.quoteId!;

    transferOk = false;
    const header = mods.x402.decodePaymentHeader(
      mods.x402.buildPaymentHeader(nextTx(), PAYER, req!.accepts[1].network, quoteId),
    )!;

    expect((await mods.x402.verifyX402Payment(header, REQ.price)).valid).toBe(false);
  });

  it("refuses a quote if the server is not taking tokens", async () => {
    const mods = await load();
    const req = await mods.x402.buildX402RequirementsWithAxon(REQ);
    const quoteId = req!.accepts[1].extra.quoteId!;
    const header = mods.x402.decodePaymentHeader(
      mods.x402.buildPaymentHeader(nextTx(), PAYER, req!.accepts[1].network, quoteId),
    )!;

    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
    vi.resetModules();
    const off = await import("@/lib/x402");

    expect((await off.verifyX402Payment(header, REQ.price)).valid).toBe(false);
  });
});
