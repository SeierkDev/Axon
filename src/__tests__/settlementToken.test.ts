import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Two meanings, two variables, and a test so they never become one again.
 *
 * `AXON_TOKEN_ADDRESS` means "the $AXON token": what the homepage links to, and what arcadeGate checks
 * a balance of. It is set in production for the gate.
 *
 * `AXON_SETTLEMENT_TOKEN_ADDRESS` means "the token a payment has to arrive in". It changes what
 * verifyTransfer demands.
 *
 * money.ts used to read the first and mean the second. So setting the gate's variable silently moved
 * settlement from ETH to $AXON while every price, label and total still said ETH. Both are 18
 * decimals, so an invoice priced at 0.00025 ETH was satisfied by 0.00025 AXON, and nothing threw
 * anywhere. Only the gating meaning had tests, which is why it survived.
 *
 * Modules are re-imported per test because both constants are read once at module load.
 */

const AXON = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const OTHER = "0x1111111111111111111111111111111111111111";

// Both constants are read at module load, so the registry has to be dropped between cases or every
// test after the first sees whatever the first one's environment happened to be.
const freshMoney = async () => {
  vi.resetModules();
  return import("@/lib/money");
};

describe("the gating token and the settlement token are not the same setting", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.AXON_TOKEN_ADDRESS;
    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("setting the gating token does not change what a payment must arrive in", async () => {
    process.env.AXON_TOKEN_ADDRESS = AXON;
    const money = await freshMoney();

    // This is the whole bug, in one assertion. Production has the gate configured, and had settlement
    // silently configured with it.
    expect(money.SETTLEMENT_TOKEN_ADDRESS).toBe("");
    expect(money.AXON_TOKEN_ADDRESS).toBe(AXON);
  });

  it("settlement is native ETH unless its own variable says otherwise", async () => {
    const money = await freshMoney();
    expect(money.SETTLEMENT_TOKEN_ADDRESS).toBe("");
  });

  it("the two can be set independently", async () => {
    process.env.AXON_TOKEN_ADDRESS = AXON;
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = OTHER;
    const money = await freshMoney();

    expect(money.AXON_TOKEN_ADDRESS).toBe(AXON);
    expect(money.SETTLEMENT_TOKEN_ADDRESS).toBe(OTHER);
    expect(money.SETTLEMENT_TOKEN_ADDRESS).not.toBe(money.AXON_TOKEN_ADDRESS);
  });
});

describe("what x402 advertises describes one asset", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.AXON_TOKEN_ADDRESS;
    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS = OTHER;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  const build = async () => {
    vi.resetModules();
    const { buildX402Requirements } = await import("@/lib/x402");
    return buildX402Requirements({
      resource: "/api/tasks",
      price: "0.00025 ETH",
      description: "a task",
    });
  };

  it("quotes native ETH, with no contract address attached to it", async () => {
    const req = await build();
    const opt = req?.accepts[0];

    expect(opt?.asset).toBe("ETH");
    expect(opt?.extra.symbol).toBe("ETH");
    // The old block said Ether and then attached an ERC-20 address. A payer following either half of
    // that was wrong, and which half they followed decided whether they overpaid or underpaid.
    expect(opt?.extra.contractAddress).toBeUndefined();
  });

  it("does not start quoting a token merely because the gate is configured", async () => {
    process.env.AXON_TOKEN_ADDRESS = AXON;
    const req = await build();

    expect(req?.accepts[0]?.asset).toBe("ETH");
    expect(req?.accepts[0]?.extra.contractAddress).toBeUndefined();
  });

  it("keeps the native option native, whatever settlement is configured", async () => {
    // The base builder describes one asset and it is always ETH. Offering the token is additive and
    // lives in buildX402RequirementsWithAxon, so a client that never heard of it finds the ETH option
    // in the same place it always was. What must never happen again is this one entry claiming to be
    // Ether while carrying an ERC-20 address.
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = AXON;
    const req = await build();
    const opt = req?.accepts[0];

    expect(req?.accepts).toHaveLength(1);
    expect(opt?.asset).toBe("ETH");
    expect(opt?.extra.symbol).toBe("ETH");
    expect(opt?.extra.contractAddress).toBeUndefined();
  });
});
