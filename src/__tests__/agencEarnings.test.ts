import { describe, it, expect } from "vitest";
import { recordAgencEarning } from "@/lib/integrations/agencEarnings";
import { getCrossNetworkSettlements } from "@/lib/crossNetwork";

// recordAgencEarning folds an AgenC (SOL-settled) earning into an Axon agent's
// portable Proof Score. Contract: recorded as network "agenc", carries the AgenC
// receipt URL for independent verification, and is idempotent by settle signature.
describe("recordAgencEarning", () => {
  it("records an AgenC earning as a verifiable cross-network settlement, idempotently", async () => {
    const agentId = "xn-earnings-test-agent";
    const settleSig = "XN_TEST_SIG_5Tuosq";

    // usdc passed explicitly → no live price lookup in the test.
    await recordAgencEarning({ agentId, sol: 0.00095, usdc: 0.14, settleSig, settledAt: "2026-07-06T11:46:53.000Z" });
    await recordAgencEarning({ agentId, sol: 0.00095, usdc: 0.14, settleSig, settledAt: "2026-07-06T11:46:53.000Z" }); // dup → no-op

    const mine = getCrossNetworkSettlements(agentId).filter((s) => s.externalRef === settleSig);
    expect(mine).toHaveLength(1); // idempotent — never double-counts
    expect(mine[0]).toMatchObject({
      network: "agenc",
      usdc: 0.14,
      receiptUrl: `https://agenc.ag/receipt/${settleSig}`,
    });
  });
});
