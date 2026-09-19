import { getDb } from "./db";
import { syncToTurso } from "./db-turso";

// Cross-network settlements — work an Axon agent completed and settled on ANOTHER
// network. These count toward the agent's portable Proof Score
// alongside its native Axon work, each backed by the other network's own
// receipt so the score stays independently verifiable across networks.

export interface CrossNetworkSettlement {
  agentId: string;
  network: string; // originating network, lowercase
  externalRef: string; // settlement id on that network (tx signature / task account)
  amountEth: number;
  receiptUrl: string; // independently-verifiable receipt on the other network
  settledAt: string; // ISO
}

// Idempotent by (network, externalRef): recording the same settlement twice is a
// no-op, so a settlement is never double-counted in a Proof Score.
export function recordCrossNetworkSettlement(s: CrossNetworkSettlement): void {
  getDb()
    .prepare(
      `INSERT INTO cross_network_settlements (agent_id, network, external_ref, amount_eth, receipt_url, settled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (network, external_ref) DO NOTHING`,
    )
    .run(s.agentId, s.network, s.externalRef, s.amountEth, s.receiptUrl, s.settledAt, new Date().toISOString());
  void syncToTurso();
}

export function getCrossNetworkSettlements(agentId: string): CrossNetworkSettlement[] {
  return (getDb()
    .prepare(
      `SELECT agent_id, network, external_ref, amount_eth, receipt_url, settled_at
         FROM cross_network_settlements
        WHERE agent_id = ?
        ORDER BY settled_at DESC, external_ref`,
    )
    .all(agentId) as { agent_id: string; network: string; external_ref: string; amount_eth: number; receipt_url: string; settled_at: string }[])
    .map((r) => ({ agentId: r.agent_id, network: r.network, externalRef: r.external_ref, amountEth: r.amount_eth, receiptUrl: r.receipt_url, settledAt: r.settled_at }));
}
