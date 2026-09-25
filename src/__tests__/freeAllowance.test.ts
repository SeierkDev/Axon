// Free hires, widened by what a wallet holds.
//
// This is the only tier benefit that spends the project's own money, so the tests lean on the two
// ways it could go wrong expensively: handing out more than intended, and handing out a second
// bucket to people who did not earn one.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const authenticateApiKey = vi.fn();
const getTier = vi.fn();

vi.mock("@/lib/identity", () => ({ authenticateApiKey: (r: unknown) => authenticateApiKey(r) }));
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

const WALLET = "0xBBBbbBBbbbBBBBbbbbBbBBbBBbBbBbBbBBbBbBbB";
const tierOf = (name: string, rank: number) => ({ tier: { name, rank, minimum: 0 } });

const req = (ip = "10.0.0.7") =>
  new NextRequest("https://axon-agents.com/api/tasks", { method: "POST", headers: { "x-forwarded-for": ip } });

const load = async () => {
  vi.resetModules();
  return import("@/lib/freeAllowance");
};

describe("how many free calls a tier gets", () => {
  afterEach(() => { delete process.env.AXON_FREE_CALLS; vi.clearAllMocks(); });

  it("leaves base at the three it has always been", async () => {
    const { freeCallsFor, BASE_FREE_CALLS } = await load();
    expect(BASE_FREE_CALLS).toBe(3);
    expect(freeCallsFor({ name: "base", rank: 0, minimum: 0 })).toBe(3);
  });

  it("gives holders more, conservatively", async () => {
    const { freeCallsFor } = await load();
    expect(freeCallsFor({ name: "holder", rank: 1, minimum: 1_000 })).toBe(10);
    expect(freeCallsFor({ name: "operator", rank: 3, minimum: 100_000 })).toBe(50);
  });

  it("takes a ceiling from the environment, so it can be raised from real spend figures", async () => {
    process.env.AXON_FREE_CALLS = "20,60,150";
    const { freeCallsFor } = await load();
    expect(freeCallsFor({ name: "holder", rank: 1, minimum: 1_000 })).toBe(20);
    expect(freeCallsFor({ name: "operator", rank: 3, minimum: 100_000 })).toBe(150);
  });

  it("ignores a malformed setting rather than half-applying it", async () => {
    // Half-applied, this either bills the project for calls nobody agreed to or cuts an allowance.
    process.env.AXON_FREE_CALLS = "20,oops,150";
    const { freeCallsFor } = await load();
    expect(freeCallsFor({ name: "holder", rank: 1, minimum: 1_000 })).toBe(10);
  });

  it("refuses to let a setting drop anyone below the base", async () => {
    process.env.AXON_FREE_CALLS = "1,2,3";
    const { freeCallsFor } = await load();
    expect(freeCallsFor({ name: "holder", rank: 1, minimum: 1_000 })).toBe(10); // rejected whole
  });
});

describe("spending one", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("gives an anonymous caller the three free calls it always had", async () => {
    authenticateApiKey.mockReturnValue(null);
    const { checkFreeAllowance } = await load();

    const a = await checkFreeAllowance(req(), "agent-x");
    expect(a.allowance).toBe(3);
    expect(a.tier.name).toBe("base");
  });

  it("does not hand a base-tier API key a second bucket", async () => {
    // The loophole worth closing: keying every authenticated caller by wallet would give any key
    // three fresh free calls on top of the three their IP already has, for holding nothing.
    authenticateApiKey.mockReturnValue({ keyId: "k", walletAddress: WALLET });
    getTier.mockResolvedValue(tierOf("base", 0));
    const { checkFreeAllowance } = await load();

    const scope = "agent-shared";
    await checkFreeAllowance(req(), scope);
    await checkFreeAllowance(req(), scope);
    await checkFreeAllowance(req(), scope);
    const fourth = await checkFreeAllowance(req(), scope);

    expect(fourth.result.allowed).toBe(false);
  });

  it("gives a holder their own bucket and a wider allowance", async () => {
    authenticateApiKey.mockReturnValue({ keyId: "k", walletAddress: WALLET });
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { checkFreeAllowance } = await load();

    const scope = "agent-holder";
    for (let i = 0; i < 10; i++) {
      expect((await checkFreeAllowance(req(), scope)).result.allowed).toBe(true);
    }
    // Still a limit, just a wider one. This spends real money, so it is never unlimited.
    expect((await checkFreeAllowance(req(), scope)).result.allowed).toBe(false);
  });

  it("follows the holder between machines", async () => {
    authenticateApiKey.mockReturnValue({ keyId: "k", walletAddress: WALLET });
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { checkFreeAllowance } = await load();

    const scope = "agent-roam";
    await checkFreeAllowance(req("10.0.0.1"), scope);
    const elsewhere = await checkFreeAllowance(req("203.0.113.5"), scope);
    // Same wallet, different address: one allowance, not two.
    expect(elsewhere.result.remaining).toBe(8);
  });

  it("keeps each agent's free lane separate", async () => {
    authenticateApiKey.mockReturnValue(null);
    const { checkFreeAllowance } = await load();

    await checkFreeAllowance(req(), "agent-a");
    await checkFreeAllowance(req(), "agent-a");
    await checkFreeAllowance(req(), "agent-a");
    // Trying a different agent is not spending the same quota, exactly as before.
    expect((await checkFreeAllowance(req(), "agent-b")).result.allowed).toBe(true);
  });

  it("tells a holder how to get more, and a stranger how to start", async () => {
    authenticateApiKey.mockReturnValue({ keyId: "k", walletAddress: WALLET });
    getTier.mockResolvedValue(tierOf("builder", 2));
    const { checkFreeAllowance, freeLimitMessage } = await load();
    const held = await checkFreeAllowance(req(), "agent-msg");
    expect(freeLimitMessage(held)).toContain("Holding more $AXON");

    authenticateApiKey.mockReturnValue(null);
    const anon = await checkFreeAllowance(req(), "agent-msg2");
    // Telling a holder to "connect a wallet" when they already have one is the wrong advice.
    expect(freeLimitMessage(anon)).toContain("Connect your MetaMask wallet");
  });

  it("degrades to base when a key cannot be read", async () => {
    authenticateApiKey.mockImplementation(() => { throw new Error("bad key"); });
    const { checkFreeAllowance } = await load();

    expect((await checkFreeAllowance(req(), "agent-throw")).allowance).toBe(3);
  });
});
