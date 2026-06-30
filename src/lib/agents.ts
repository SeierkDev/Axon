import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { parsePaymentAmount } from "./solana";
import { scheduleAgentEmbedding } from "./embeddings";
import type { Agent } from "@/sdk/types";

import type { InferenceProvider } from "@/sdk/types";

interface AgentRow {
  agent_id: string;
  name: string;
  capabilities: string;
  public_key: string;
  endpoint: string | null;
  price: string | null;
  reputation: number;
  category: string | null;
  wallet_address: string | null;
  provider: string | null;
  provider_model: string | null;
  provider_endpoint: string | null;
  verification_status: string | null;
  last_verified_at: string | null;
  created_at: string;
}

function parseCapabilitiesJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((cap): cap is string => typeof cap === "string")
      .map((cap) => cap.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function rowToAgent(row: AgentRow): Agent {
  return {
    agentId: row.agent_id,
    name: row.name,
    capabilities: parseCapabilitiesJson(row.capabilities),
    publicKey: row.public_key,
    endpoint: row.endpoint ?? undefined,
    price: row.price ?? undefined,
    reputation: row.reputation,
    category: row.category ?? "General",
    walletAddress: row.wallet_address ?? undefined,
    provider: (row.provider ?? "anthropic") as InferenceProvider,
    providerModel: row.provider_model ?? undefined,
    providerEndpoint: row.provider_endpoint ?? undefined,
    verificationStatus: (row.verification_status ?? "unverified") as Agent["verificationStatus"],
    lastVerifiedAt: row.last_verified_at ?? undefined,
    createdAt: row.created_at,
  };
}

// Strip owner-private fields for unauthenticated discovery responses.
// `providerEndpoint` is the owner's private inference backend URL (often a
// self-hosted/internal host) and must never be exposed on public reads.
export function toPublicAgent<T extends object>(agent: T): Omit<T, "providerEndpoint"> {
  const { providerEndpoint: _omit, ...rest } = agent as T & { providerEndpoint?: unknown };
  return rest as Omit<T, "providerEndpoint">;
}

const CATEGORY_MAP: [string[], string][] = [
  [["crypto", "defi", "finance", "trading"], "Finance"],
  [["research", "analysis", "summarization", "search"], "Research"],
  [["coding", "development", "testing", "debugging"], "Development"],
  [["writing", "content", "creative"], "Content"],
];

export function categoryFromCapabilities(capabilities: string[]): string {
  for (const [keywords, cat] of CATEGORY_MAP) {
    if (capabilities.some((c) => keywords.includes(c.toLowerCase()))) return cat;
  }
  return "General";
}

const CONTRACT_TEST_AGENT_ID = /^(split-[ab]|mine|victim|att|sla-p|wt-[ab]|bid-poster|bid-worker)-\d{12,}$/;

export function isContractTestAgent(agentId: string): boolean {
  return CONTRACT_TEST_AGENT_ID.test(agentId);
}

export function createAgent(agent: Agent): Agent {
  const db = getDb();

  const insertAgent = db.prepare(`
    INSERT INTO agents (agent_id, name, capabilities, public_key, endpoint, price, reputation, category, wallet_address, provider, provider_model, provider_endpoint, verification_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCap = db.prepare(
    "INSERT OR IGNORE INTO agent_capabilities (capability, agent_id) VALUES (?, ?)"
  );

  db.transaction(() => {
    insertAgent.run(
      agent.agentId,
      agent.name,
      JSON.stringify(agent.capabilities),
      agent.publicKey,
      agent.endpoint ?? null,
      agent.price ?? null,
      agent.reputation ?? 0,
      agent.category ?? "General",
      agent.walletAddress ?? null,
      agent.provider ?? "anthropic",
      agent.providerModel ?? null,
      agent.providerEndpoint ?? null,
      agent.verificationStatus ?? "unverified",
      agent.createdAt,
    );
    for (const cap of agent.capabilities) {
      insertCap.run(cap, agent.agentId);
    }
  })();
  void syncToTurso();

  scheduleAgentEmbedding(agent);
  return agent;
}

export function getAgentById(agentId: string): Agent | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM agents WHERE agent_id = ?")
    .get(agentId) as AgentRow | undefined;
  return row ? rowToAgent(row) : null;
}

export function agentExists(agentId: string): boolean {
  return !!getDb()
    .prepare("SELECT 1 FROM agents WHERE agent_id = ?")
    .get(agentId);
}

export interface AgentUpdateFields {
  name?: string;
  capabilities?: string[];
  price?: string | null;
  endpoint?: string | null;
}

export function updateAgent(agentId: string, updates: AgentUpdateFields): Agent | null {
  const db = getDb();
  const setParts: string[] = [];
  const values: (string | null)[] = [];

  if (updates.name !== undefined) {
    setParts.push("name = ?");
    values.push(updates.name.trim());
  }
  if (updates.capabilities !== undefined) {
    setParts.push("capabilities = ?");
    values.push(JSON.stringify(updates.capabilities));
    setParts.push("category = ?");
    values.push(categoryFromCapabilities(updates.capabilities));
  }
  if ("price" in updates) {
    setParts.push("price = ?");
    values.push(updates.price ?? null);
  }
  if ("endpoint" in updates) {
    setParts.push("endpoint = ?");
    values.push(updates.endpoint ?? null);
    // Always reset verification_status when endpoint changes (clearing or setting)
    setParts.push("verification_status = ?");
    values.push("unverified");
  }

  if (setParts.length === 0) return getAgentById(agentId);

  db.transaction(() => {
    db.prepare(`UPDATE agents SET ${setParts.join(", ")} WHERE agent_id = ?`)
      .run(...values, agentId);

    if (updates.capabilities !== undefined) {
      db.prepare("DELETE FROM agent_capabilities WHERE agent_id = ?").run(agentId);
      const insertCap = db.prepare(
        "INSERT OR IGNORE INTO agent_capabilities (capability, agent_id) VALUES (?, ?)"
      );
      for (const cap of updates.capabilities) {
        if (cap.trim()) insertCap.run(cap.trim(), agentId);
      }
    }
  })();
  void syncToTurso();

  const updated = getAgentById(agentId);
  if (updated && (updates.name !== undefined || updates.capabilities !== undefined)) {
    scheduleAgentEmbedding(updated);
  }
  return updated;
}

export type SortField = "reputation" | "price" | "createdAt" | "activity" | "successRate" | "latency" | "reviews";

export interface SearchOptions {
  capability?: string;
  capabilities?: string[];
  category?: string;
  minReputation?: number;
  maxPrice?: string; // e.g. "0.50 USDC" — free agents (no price) always pass
  sort?: SortField;
  limit?: number;
}

export function searchAgents(opts: SearchOptions): Agent[] {
  const db = getDb();

  let agentIds: string[] | null = null;

  // Capability filter via the index (AND semantics: agent must have ALL caps)
  const caps = [
    ...(opts.capability ? [opts.capability] : []),
    ...(opts.capabilities ?? []),
  ].filter(Boolean);

  if (caps.length > 0) {
    // Agents that have ALL requested capabilities
    const placeholders = caps.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT agent_id FROM agent_capabilities
         WHERE capability IN (${placeholders})
         GROUP BY agent_id
         HAVING COUNT(DISTINCT capability) = ?`
      )
      .all(...caps, caps.length) as { agent_id: string }[];
    agentIds = rows.map((r) => r.agent_id);
    if (agentIds.length === 0) return [];
  }

  const orderClause =
    opts.sort === "createdAt"
      ? "ORDER BY created_at DESC"
      : opts.sort === "activity"
      ? `ORDER BY (
          SELECT MAX(created_at) FROM tasks WHERE to_agent = agents.agent_id
        ) DESC NULLS LAST`
      : opts.sort === "successRate"
      ? `ORDER BY (
          SELECT CAST(COUNT(*) FILTER (WHERE status = 'completed') AS REAL)
                 / NULLIF(COUNT(*), 0)
          FROM tasks WHERE to_agent = agents.agent_id
            AND status IN ('completed', 'failed')
        ) DESC NULLS LAST`
      : opts.sort === "latency"
      ? `ORDER BY (
          SELECT CAST(SUM(total_latency_ms) AS REAL) / NULLIF(SUM(completed), 0)
          FROM agent_metrics WHERE agent_id = agents.agent_id
        ) ASC NULLS LAST`
      : opts.sort === "reviews"
      ? `ORDER BY (
          SELECT AVG(rating) FROM reviews WHERE agent_id = agents.agent_id
        ) DESC NULLS LAST`
      : "ORDER BY reputation DESC";
  // Price sort must fetch enough rows to sort globally — cap at 2000 to avoid unbounded scans
  const queryLimit = opts.sort === "price" ? 2000 : opts.limit ?? 10;

  let rows: AgentRow[];
  if (agentIds !== null) {
    const ph = agentIds.map(() => "?").join(", ");
    rows = db
      .prepare(
        `SELECT * FROM agents WHERE agent_id IN (${ph}) ${orderClause} LIMIT ?`
      )
      .all(...agentIds, queryLimit) as AgentRow[];
  } else {
    rows = db
      .prepare(`SELECT * FROM agents WHERE 1=1 ${orderClause} LIMIT ?`)
      .all(queryLimit) as AgentRow[];
  }

  if (opts.minReputation !== undefined) {
    rows = rows.filter((r) => r.reputation >= opts.minReputation!);
  }
  if (opts.category && opts.category !== "All") {
    rows = rows.filter((r) => (r.category ?? "General") === opts.category);
  }
  if (opts.maxPrice) {
    const max = parsePaymentAmount(opts.maxPrice);
    if (max) {
      rows = rows.filter((r) => {
        if (!r.price) return true; // free agents always satisfy any maxPrice
        const agentPrice = parsePaymentAmount(r.price);
        if (!agentPrice) return false;
        if (agentPrice.currency !== max.currency) return false;
        return agentPrice.amount <= max.amount;
      });
    }
  }

  if (opts.sort === "price") {
    rows = [...rows].sort((a, b) => {
      const priceA = a.price ? parsePaymentAmount(a.price) : null;
      const priceB = b.price ? parsePaymentAmount(b.price) : null;

      if (!priceA && !priceB) return b.reputation - a.reputation;
      if (!priceA) return -1;
      if (!priceB) return 1;
      if (priceA.currency !== priceB.currency) {
        return priceA.currency.localeCompare(priceB.currency);
      }
      return priceA.amount - priceB.amount;
    });
  }

  return rows.slice(0, opts.limit ?? 10).map(rowToAgent);
}

export function getAllAgents(): Agent[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM agents ORDER BY reputation DESC")
    .all() as AgentRow[];
  return rows.map(rowToAgent);
}

export interface AgentCounts {
  total: number;
  paid: number;
  categories: number;
  active: number;
}

export function getAgentCounts(): AgentCounts {
  const row = getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN price IS NOT NULL AND price != '' THEN 1 END) AS paid,
      COUNT(DISTINCT COALESCE(category, 'General')) AS categories,
      COUNT(*) AS active
    FROM agents
  `).get() as AgentCounts;
  return row;
}
