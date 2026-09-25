// The public read of what a wallet holds and what it is worth.
//
// The page has to work before anyone connects anything — somebody deciding whether to hold should
// be able to read exactly what they would get without being asked to connect a wallet first — so
// the ladder is the part that must always be there, and the wallet is the optional half.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getTier = vi.fn();
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

const WALLET = "0xDdDDddDdDdddDDddDDddDDDDdDdDDdDDdDDDDDDd";

const call = async (query = "") => {
  vi.resetModules();
  const { GET } = await import("@/app/api/tier/route");
  const res = await GET(new NextRequest(`https://axon-agents.com/api/tier${query}`));
  return { status: res.status, body: await res.json() };
};

describe("reading a tier", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the ladder with no wallet at all", async () => {
    const { body } = await call();

    expect(body.tier).toBeNull();
    // The reason somebody visits before connecting: what would I get if I held?
    expect(body.ladder.length).toBeGreaterThanOrEqual(4);
    expect(body.ladder[0].name).toBe("base");
  });

  it("publishes what each rung is actually worth", async () => {
    const { body } = await call();
    const operator = body.ladder.find((r: { name: string }) => r.name === "operator");

    expect(operator.entitlements.rateMultiplier).toBeGreaterThan(1);
    expect(operator.entitlements.freeCalls).toBeGreaterThan(3);
    expect(operator.entitlements.agent.toolGrants).toBeGreaterThan(0);
  });

  it("shows base as worth exactly what the network already gives", async () => {
    const { body } = await call();
    const base = body.ladder.find((r: { name: string }) => r.name === "base");

    expect(base.entitlements.rateMultiplier).toBe(1);
    expect(base.entitlements.freeCalls).toBe(3);
    expect(base.entitlements.queuePriority).toBe(0);
  });

  it("resolves a wallet to its rung", async () => {
    getTier.mockResolvedValue({ tier: { name: "builder", rank: 2, minimum: 2_500_000 }, balance: 3_000_000, stale: false });
    const { body } = await call(`?wallet=${WALLET}`);

    expect(body.tier.name).toBe("builder");
    expect(body.balance).toBe(3_000_000);
    expect(body.wallet).toBe(WALLET.toLowerCase());
  });

  it("says how much more reaches the next rung", async () => {
    getTier.mockResolvedValue({ tier: { name: "holder", rank: 1, minimum: 250_000 }, balance: 400_000, stale: false });
    const { body } = await call(`?wallet=${WALLET}`);

    expect(body.next.name).toBe("builder");
    expect(body.next.needed).toBe(2_100_000);
  });

  it("has no next rung at the top", async () => {
    getTier.mockResolvedValue({ tier: { name: "operator", rank: 3, minimum: 10_000_000 }, balance: 50_000_000, stale: false });
    const { body } = await call(`?wallet=${WALLET}`);

    expect(body.next).toBeNull();
  });

  it("reports a stale reading rather than hiding it", async () => {
    getTier.mockResolvedValue({ tier: { name: "operator", rank: 3, minimum: 10_000_000 }, balance: 20_000_000, stale: true });
    const { body } = await call(`?wallet=${WALLET}`);

    // The entitlements are still honoured; the page says why the number may lag.
    expect(body.stale).toBe(true);
    expect(body.tier.name).toBe("operator");
  });

  it("rejects something that is not an address", async () => {
    const { status } = await call("?wallet=not-a-wallet");
    expect(status).toBe(400);
  });

  it("never needs authentication", async () => {
    // Every input is public: the balance is on chain and the ladder is published. Making somebody
    // authenticate to read a public balance would be theatre.
    getTier.mockResolvedValue({ tier: { name: "holder", rank: 1, minimum: 250_000 }, balance: 500_000, stale: false });
    const { status } = await call(`?wallet=${WALLET}`);
    expect(status).toBe(200);
  });
});
