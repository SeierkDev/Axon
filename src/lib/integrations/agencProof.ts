// Portable proof at the cross-network boundary.
//
// When an AgenC listing or good belongs to an agent Axon knows — via opt-in
// cross-listing (agenc_listings maps an Axon agent to its on-chain AgenC agent +
// listing addresses) — the marketplace card can carry that agent's Proof Score:
// portable reputation a hirer can verify BEFORE hiring across networks, backed by
// on-chain receipts and recomputable by any third party. Cards with no Axon
// identity simply get nothing; the UI states that honestly.

import { getDb } from "@/lib/db";

export interface AgencAxonProof {
  agentId: string; // the Axon agent — links the badge to /agents/<id>
  proofScore: number; // cached 0-1000 score (recomputed on completion + daily cron)
  proofScoreTier: string | null;
}

// Solana addresses are base58, 32-44 chars; the derived hex ids are 64. Anything
// longer is not a key we could ever have stored — drop it before it hits SQL.
const MAX_KEY_LEN = 64;

// Map on-chain PDAs (AgenC agent addresses and/or listing addresses, as seen in
// AgenC's public feeds) -> the Axon agent's cached Proof Score. One query for the
// whole card grid; agents without a positive score are omitted — the badge only
// ever shows proof that exists. NEVER throws: the enrichment is decorative, and
// a DB hiccup must not take down the whole cross-network section (the routes'
// fail-soft contract) — cards just fall back to the honest no-proof state.
export function getAxonProofByPda(pdas: string[]): Map<string, AgencAxonProof> {
  const out = new Map<string, AgencAxonProof>();
  const keys = [...new Set(pdas.filter((p) => typeof p === "string" && p.length > 0 && p.length <= MAX_KEY_LEN))];
  if (keys.length === 0) return out;
  try {
    const ph = keys.map(() => "?").join(",");
    const rows = getDb()
      .prepare(
        `SELECT l.agent_address, l.listing_address, a.agent_id, a.proof_score, a.proof_score_tier
           FROM agenc_listings l
           JOIN agents a ON a.agent_id = l.agent_id
          WHERE (l.agent_address IN (${ph}) OR l.listing_address IN (${ph}))
            AND a.proof_score IS NOT NULL AND a.proof_score > 0`,
      )
      .all(...keys, ...keys) as {
      agent_address: string | null;
      listing_address: string | null;
      agent_id: string;
      proof_score: number;
      proof_score_tier: string | null;
    }[];
    for (const r of rows) {
      const proof: AgencAxonProof = { agentId: r.agent_id, proofScore: r.proof_score, proofScoreTier: r.proof_score_tier };
      if (r.agent_address) out.set(r.agent_address, proof);
      if (r.listing_address) out.set(r.listing_address, proof);
    }
  } catch (e) {
    console.error("[agencProof] proof-score lookup failed (cards fall back to no-proof):", e);
    out.clear();
  }
  return out;
}
