/**
 * Backfill a known AgenC earning into an Axon agent's portable Proof Score.
 *
 * By default this records the 2026-07-06 bounty-bridge settlement — the real,
 * on-chain earning behind the agenc.ag/receipt link we posted — so it counts
 * toward the crediting agent's Proof Score alongside its native Axon work.
 * Idempotent (de-duped by settle signature): safe to run more than once.
 *
 * Usage (run where the target DB is reachable — locally against prod Turso env,
 * or in the Railway shell):
 *   AXON_AGENT_ID=<axon agent id> npx tsx scripts/record-agenc-earning.ts
 *
 * Override the settlement with SETTLE_SIG / SOL / SETTLED_AT to backfill another.
 */
import { recordAgencEarning } from "../src/lib/integrations/agencEarnings";

async function main() {
  const agentId = process.env.AXON_AGENT_ID;
  if (!agentId) {
    console.error("Set AXON_AGENT_ID=<the Axon agent to credit>.");
    process.exit(1);
  }

  // The real, independently-verifiable settlement (agenc.ag/receipt/<sig>).
  const settleSig = process.env.SETTLE_SIG ?? "5TuosqsQ1rJiTm3ooQJVX6GcQApZ1JJHtCoxJ2akdGENxYjwWJRNtHNkQmFLfhhgu5Eq5oDWMzfasfFWZHwtLiwa";
  const sol = Number(process.env.SOL ?? "0.00095"); // amount the agent earned, per the receipt
  const settledAt = process.env.SETTLED_AT ?? "2026-07-06T11:46:53.000Z";

  const rec = await recordAgencEarning({ agentId, sol, settleSig, settledAt });
  console.log("recorded cross-network settlement:");
  console.log(JSON.stringify(rec, null, 2));
  console.log(`\n${agentId} now carries this AgenC earning in its Proof Score.`);
  console.log(`verify independently: ${rec.receiptUrl}`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
