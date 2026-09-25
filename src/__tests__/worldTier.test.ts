// Standing in the world, from standing on the network.
//
// Every building in Axon World is a real agent, so what its owner holds is a fact about the city.
// The thing to protect is that reading it can never cost the world its snapshot: the city model is
// built synchronously and memoized, the tier is a balance on chain, and one must not wait on the
// other.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getTier = vi.fn();
const getWorldSnapshot = vi.fn();

vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});
vi.mock("@/lib/world", () => ({ getWorldSnapshot: () => getWorldSnapshot() }));

const HOLDER = "0xEeeEEeeeEEEeeeEEEEeeeeEEeeeEEEEEeEeEeEeE";
const NOBODY = "0xFffFFFffFffFFffFFFffFFffFFFFffFfFFFfFFfF";

const snapshot = (plots: { agentId: string; walletAddress: string | null }[]) => ({
  totals: { agents: plots.length, districts: 1, totalEthEarned: 0, totalTasksCompleted: 0, activeAgents: 0 },
  districts: [],
  plots: plots.map((p) => ({ ...p, name: p.agentId, district: "Research", x: 0, z: 0, size: 1, height: 1, reputation: 0, reputationNorm: 0, active: false, tasksCompleted: 0, ethEarned: 0, verified: false, proofScore: null })),
  edges: [],
  weeklyTop: [],
  generatedAt: new Date().toISOString(),
});

const call = async () => {
  vi.resetModules();
  const { GET } = await import("@/app/api/world/route");
  const res = await GET(new NextRequest("https://axon-agents.com/api/world"));
  return { status: res.status, body: await res.json() };
};

describe("holder standing in the world", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a building whose owner holds", async () => {
    getWorldSnapshot.mockReturnValue(snapshot([{ agentId: "a1", walletAddress: HOLDER }]));
    getTier.mockResolvedValue({ tier: { name: "builder", rank: 2, minimum: 25_000 }, balance: 30_000, stale: false });

    const { body } = await call();
    expect(body.plots[0].ownerTier).toBe("builder");
  });

  it("marks nothing at base, because a badge everyone has says nothing", async () => {
    getWorldSnapshot.mockReturnValue(snapshot([{ agentId: "a1", walletAddress: NOBODY }]));
    getTier.mockResolvedValue({ tier: { name: "base", rank: 0, minimum: 0 }, balance: 0, stale: false });

    const { body } = await call();
    expect(body.plots[0].ownerTier).toBeNull();
  });

  it("reads each owner once, not once per building", async () => {
    // Most of the city shares a handful of owners. One chain read per building would make opening
    // the world a hundred RPC calls.
    getWorldSnapshot.mockReturnValue(
      snapshot([
        { agentId: "a1", walletAddress: HOLDER },
        { agentId: "a2", walletAddress: HOLDER },
        { agentId: "a3", walletAddress: HOLDER },
      ]),
    );
    getTier.mockResolvedValue({ tier: { name: "holder", rank: 1, minimum: 1_000 }, balance: 5_000, stale: false });

    await call();
    expect(getTier).toHaveBeenCalledTimes(1);
  });

  it("handles a building with no owner wallet", async () => {
    getWorldSnapshot.mockReturnValue(snapshot([{ agentId: "a1", walletAddress: null }]));

    const { body } = await call();
    expect(body.plots[0].ownerTier).toBeNull();
    expect(getTier).not.toHaveBeenCalled();
  });

  it("still returns the city when the chain is unreadable", async () => {
    // The world is not allowed to go down over a decoration.
    getWorldSnapshot.mockReturnValue(snapshot([{ agentId: "a1", walletAddress: HOLDER }]));
    getTier.mockResolvedValue({ tier: { name: "base", rank: 0, minimum: 0 }, balance: null, stale: false });

    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.plots).toHaveLength(1);
    expect(body.plots[0].ownerTier).toBeNull();
  });

  it("leaves the rest of the snapshot alone", async () => {
    getWorldSnapshot.mockReturnValue(snapshot([{ agentId: "a1", walletAddress: HOLDER }]));
    getTier.mockResolvedValue({ tier: { name: "operator", rank: 3, minimum: 100_000 }, balance: 1e6, stale: false });

    const { body } = await call();
    expect(body.totals.agents).toBe(1);
    expect(body.plots[0].name).toBe("a1");
    expect(body.plots[0].district).toBe("Research");
  });
});
