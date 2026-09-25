// Names held for later.
//
// An agent id is permanent and first come, first served, so a reservation is a real claim against
// everybody else. That makes the interesting cases the adversarial ones: taking a name somebody
// already registered, taking one already reserved, holding more than your tier allows, and
// releasing something that is not yours.

import { describe, it, expect, beforeEach, vi } from "vitest";

const getTier = vi.fn();
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const tierOf = (name: string, rank: number) => ({ tier: { name, rank, minimum: 0 }, balance: 1, stale: false });

const load = async () => {
  vi.resetModules();
  const mod = await import("@/lib/reservedHandles");
  const { getDb } = await import("@/lib/db");
  getDb().prepare("DELETE FROM reserved_handles").run();
  return mod;
};

describe("claiming a name", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lets a holder hold one", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { claimHandle } = await load();

    const r = await claimHandle("my-future-agent", ALICE);
    expect(r.ok).toBe(true);
  });

  it("refuses a wallet holding nothing", async () => {
    getTier.mockResolvedValue(tierOf("base", 0));
    const { claimHandle } = await load();

    const r = await claimHandle("anything", ALICE);
    // Base holds none, which is exactly today's behaviour: nothing is taken from anyone.
    expect(r.ok).toBe(false);
  });

  it("refuses a name somebody else already reserved", async () => {
    getTier.mockResolvedValue(tierOf("operator", 3));
    const { claimHandle } = await load();
    await claimHandle("contested", ALICE);

    const r = await claimHandle("contested", BOB);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/already reserved/);
  });

  it("is idempotent for the wallet already holding it", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { claimHandle, reservationsFor } = await load();
    await claimHandle("mine", ALICE);

    // Claiming your own again is not an error, and must not consume a second slot.
    const again = await claimHandle("mine", ALICE);
    expect(again.ok).toBe(true);
    expect(reservationsFor(ALICE)).toHaveLength(1);
  });

  it("matches regardless of spelling", async () => {
    getTier.mockResolvedValue(tierOf("operator", 3));
    const { claimHandle } = await load();
    await claimHandle("MixedCase", ALICE);

    // Ids are compared lowercased everywhere else; a reservation matching one spelling protects
    // nothing at all.
    expect((await claimHandle("mixedcase", BOB)).ok).toBe(false);
  });

  it("enforces the tier's allowance", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1)); // one
    const { claimHandle } = await load();

    expect((await claimHandle("first", ALICE)).ok).toBe(true);
    expect((await claimHandle("second", ALICE)).ok).toBe(false);
  });

  it("gives a higher tier more room", async () => {
    getTier.mockResolvedValue(tierOf("builder", 2)); // three
    const { claimHandle } = await load();

    expect((await claimHandle("a", ALICE)).ok).toBe(true);
    expect((await claimHandle("b", ALICE)).ok).toBe(true);
    expect((await claimHandle("c", ALICE)).ok).toBe(true);
    expect((await claimHandle("d", ALICE)).ok).toBe(false);
  });
});

describe("what a reservation does", () => {
  beforeEach(() => vi.clearAllMocks());

  it("blocks everyone else from registering it", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { claimHandle, canRegister } = await load();
    await claimHandle("held", ALICE);

    expect(canRegister("held", BOB)).toBe(false);
  });

  it("never blocks the wallet holding it", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { claimHandle, canRegister } = await load();
    await claimHandle("held", ALICE);

    // A hold against everybody else, not against yourself.
    expect(canRegister("held", ALICE)).toBe(true);
  });

  it("does not block a name nobody reserved", async () => {
    const { canRegister } = await load();
    expect(canRegister("wide-open", BOB)).toBe(true);
  });

  it("frees the slot once the agent is registered", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { claimHandle, consumeHandle, reservationsFor } = await load();
    await claimHandle("about-to-exist", ALICE);

    consumeHandle("about-to-exist", ALICE);
    // Registering is the whole point of the reservation. Holding the row after would count a spent
    // reservation against the allowance forever.
    expect(reservationsFor(ALICE)).toHaveLength(0);
  });

  it("does not let somebody else consume your reservation", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { claimHandle, consumeHandle, reservationsFor } = await load();
    await claimHandle("safe", ALICE);

    consumeHandle("safe", BOB);
    expect(reservationsFor(ALICE)).toHaveLength(1);
  });
});

describe("releasing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives the name and the slot back", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { claimHandle, releaseHandle, canRegister } = await load();
    await claimHandle("letting-go", ALICE);

    expect(releaseHandle("letting-go", ALICE)).toBe(true);
    expect(canRegister("letting-go", BOB)).toBe(true);
  });

  it("refuses to release somebody else's", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const { claimHandle, releaseHandle, canRegister } = await load();
    await claimHandle("not-yours", ALICE);

    expect(releaseHandle("not-yours", BOB)).toBe(false);
    expect(canRegister("not-yours", BOB)).toBe(false);
  });

  it("is not an error to release one you never held", async () => {
    const { releaseHandle } = await load();
    expect(releaseHandle("never-mine", BOB)).toBe(false);
  });
});
