// How deep an agent may go, by what its owner holds.
//
// Two rules carry the weight. Depth only ever increases, so an agent whose owner holds nothing
// behaves exactly as it does today. And the free lane never deepens, whatever the owner holds,
// because every extra step there is a model call the project pays for and the free lane is already
// the one benefit that costs money.

import { describe, it, expect, beforeEach, vi } from "vitest";

const getTier = vi.fn();
const getAgentById = vi.fn();

vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});
vi.mock("@/lib/agents", () => ({ getAgentById: (id: unknown) => getAgentById(id) }));

const OWNER = "0xCCCcccCCcCCCccCCCCcCCcCcCCCCcCcCCcCcCcCc";
const tierOf = (name: string, rank: number) => ({ tier: { name, rank, minimum: 0 } });

const load = async () => {
  vi.resetModules();
  return import("@/lib/agentTierLimits");
};

describe("what a tier deepens", () => {
  it("leaves base exactly where it is", async () => {
    const { limitsForTier, BASE_LIMITS } = await load();
    expect(limitsForTier({ name: "base", rank: 0, minimum: 0 })).toEqual(BASE_LIMITS);
  });

  it("raises grants faster than steps", async () => {
    // Attaching a tool costs nothing until it is used. Another round trip is a model call carrying
    // the whole conversation, so the expensive lever moves least.
    const { limitsForTier, BASE_LIMITS } = await load();
    const op = limitsForTier({ name: "operator", rank: 3, minimum: 100_000 });

    const grantFactor = op.toolGrants / BASE_LIMITS.toolGrants;
    const stepFactor = op.toolSteps / BASE_LIMITS.toolSteps;
    expect(grantFactor).toBeGreaterThan(stepFactor);
  });

  it("never returns less than base for any tier", async () => {
    const { limitsForTier, BASE_LIMITS } = await load();
    for (const name of ["base", "holder", "builder", "operator"] as const) {
      const l = limitsForTier({ name, rank: 0, minimum: 0 });
      expect(l.toolGrants).toBeGreaterThanOrEqual(BASE_LIMITS.toolGrants);
      expect(l.toolSteps).toBeGreaterThanOrEqual(BASE_LIMITS.toolSteps);
      expect(l.toolResultChars).toBeGreaterThanOrEqual(BASE_LIMITS.toolResultChars);
    }
  });
});

describe("resolving an agent's depth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deepens a paid hire for an agent whose owner holds", async () => {
    getAgentById.mockReturnValue({ agentId: "a1", walletAddress: OWNER });
    getTier.mockResolvedValue(tierOf("operator", 3));
    const { limitsForAgent, BASE_LIMITS } = await load();

    const l = await limitsForAgent("a1", true);
    expect(l.toolSteps).toBeGreaterThan(BASE_LIMITS.toolSteps);
  });

  it("keeps the free lane at base however much the owner holds", async () => {
    getAgentById.mockReturnValue({ agentId: "a1", walletAddress: OWNER });
    getTier.mockResolvedValue(tierOf("operator", 3));
    const { limitsForAgent, BASE_LIMITS } = await load();

    // The buyer covered the inference on a paid hire. On a free one the project is buying it, and
    // deepening there would be a second uncapped door into the one benefit that costs money.
    expect(await limitsForAgent("a1", false)).toEqual(BASE_LIMITS);
    expect(getTier).not.toHaveBeenCalled();
  });

  it("falls back to base for an agent with no owner wallet", async () => {
    getAgentById.mockReturnValue({ agentId: "a1", walletAddress: null });
    const { limitsForAgent, BASE_LIMITS } = await load();

    expect(await limitsForAgent("a1", true)).toEqual(BASE_LIMITS);
  });

  it("falls back to base for an agent that does not exist", async () => {
    getAgentById.mockReturnValue(null);
    const { limitsForAgent, BASE_LIMITS } = await load();

    expect(await limitsForAgent("nobody", true)).toEqual(BASE_LIMITS);
  });

  it("falls back to base when the tier cannot be read", async () => {
    getAgentById.mockReturnValue({ agentId: "a1", walletAddress: OWNER });
    getTier.mockRejectedValue(new Error("rpc down"));
    const { limitsForAgent, BASE_LIMITS } = await load();

    // An agent must run the same during an outage as it did yesterday.
    expect(await limitsForAgent("a1", true)).toEqual(BASE_LIMITS);
  });
});

describe("how many tools an owner may attach", () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives a holder more than the default", async () => {
    getTier.mockResolvedValue(tierOf("builder", 2));
    const { toolGrantsForOwner, BASE_LIMITS } = await load();

    expect(await toolGrantsForOwner(OWNER)).toBeGreaterThan(BASE_LIMITS.toolGrants);
  });

  it("gives the default to a wallet that holds nothing", async () => {
    getTier.mockResolvedValue(tierOf("base", 0));
    const { toolGrantsForOwner, BASE_LIMITS } = await load();

    expect(await toolGrantsForOwner(OWNER)).toBe(BASE_LIMITS.toolGrants);
  });

  it("gives the default when there is no wallet at all", async () => {
    const { toolGrantsForOwner, BASE_LIMITS } = await load();
    expect(await toolGrantsForOwner(null)).toBe(BASE_LIMITS.toolGrants);
  });
});

describe("the grant validator's cap", () => {
  it("still refuses more than the owner is allowed", async () => {
    const { validateToolGrants, MAX_TOOL_GRANTS } = await import("@/lib/agentTools");
    const tooMany = Array.from({ length: MAX_TOOL_GRANTS + 1 }, () => "web_search");

    expect(validateToolGrants(tooMany)).toMatch(/or fewer grants/);
  });

  it("accepts more once the owner has earned it", async () => {
    const { validateToolGrants, MAX_TOOL_GRANTS } = await import("@/lib/agentTools");
    const more = Array.from({ length: MAX_TOOL_GRANTS + 2 }, () => "web_search");

    expect(validateToolGrants(more, MAX_TOOL_GRANTS + 4)).toBeNull();
  });

  it("refuses to let a cap drop below the default", async () => {
    const { validateToolGrants, MAX_TOOL_GRANTS } = await import("@/lib/agentTools");
    const atDefault = Array.from({ length: MAX_TOOL_GRANTS }, () => "web_search");

    // Depth may only ever increase. A cap of 1 must not take away what every agent already has.
    expect(validateToolGrants(atDefault, 1)).toBeNull();
  });
});
