import { getDb } from "./db";

export interface CapabilitySummary {
  name: string;
  agentCount: number;
}

export function getAllCapabilities(): CapabilitySummary[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT capability AS name, COUNT(*) AS agentCount
       FROM agent_capabilities
       GROUP BY capability
       ORDER BY agentCount DESC, capability ASC`
    )
    .all() as CapabilitySummary[];
}

export function getAgentIdsByCapability(capability: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.agent_id FROM agents a
       JOIN agent_capabilities ac ON ac.agent_id = a.agent_id
       WHERE ac.capability = ?
       ORDER BY a.reputation DESC`
    )
    .all(capability) as { agent_id: string }[];
  return rows.map((r) => r.agent_id);
}
