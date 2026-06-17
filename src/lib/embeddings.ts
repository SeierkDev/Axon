// Semantic agent discovery via OpenAI text embeddings.
//
// Requires OPENAI_API_KEY to be set. All functions degrade gracefully when
// it is not — callers receive null / empty results and fall back to keyword search.
//
// Model: text-embedding-3-small (1536 dims, cheap, fast).
// Embeddings are stored as a JSON array in agents.embedding.

import { getDb } from "./db";
import { logger } from "./logger";
import type { Agent } from "@/sdk/types";
import type { SearchOptions } from "./agents";
import { parsePaymentAmount } from "./solana";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;
const MAX_TEXT_CHARS = 500;

// ── Text building ─────────────────────────────────────────────────────────────

export function buildAgentEmbeddingText(agent: {
  name: string;
  capabilities: string[];
  category?: string;
}): string {
  const parts: string[] = [
    agent.name,
    `capabilities: ${agent.capabilities.join(", ")}`,
    agent.category ? `category: ${agent.category}` : "",
  ].filter(Boolean);
  return parts.join(". ").slice(0, MAX_TEXT_CHARS);
}

// ── API call ──────────────────────────────────────────────────────────────────

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("embeddings.api_error", "OpenAI embeddings API returned an error", {
        status: res.status,
        body: body.slice(0, 200),
      });
      return null;
    }

    const data = await res.json() as {
      data?: { embedding: number[]; index: number }[];
    };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMS) {
      logger.warn("embeddings.unexpected_shape", "Unexpected embedding shape from OpenAI", {
        length: Array.isArray(embedding) ? embedding.length : "not array",
      });
      return null;
    }

    return embedding;
  } catch (err) {
    logger.warn("embeddings.request_failed", "Failed to generate embedding", {
      reason: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

export function storeAgentEmbedding(agentId: string, embedding: number[]): void {
  getDb()
    .prepare("UPDATE agents SET embedding = ? WHERE agent_id = ?")
    .run(JSON.stringify(embedding), agentId);
}

export function getAgentEmbedding(agentId: string): number[] | null {
  const row = getDb()
    .prepare("SELECT embedding FROM agents WHERE agent_id = ?")
    .get(agentId) as { embedding: string | null } | undefined;
  if (!row?.embedding) return null;
  try {
    return JSON.parse(row.embedding) as number[];
  } catch {
    return null;
  }
}

// Fire-and-forget: generates and stores an embedding for an agent.
// Errors are logged as warnings and never propagate.
export function scheduleAgentEmbedding(agent: Agent): void {
  const text = buildAgentEmbeddingText(agent);
  void generateEmbedding(text)
    .then((embedding) => {
      if (embedding) storeAgentEmbedding(agent.agentId, embedding);
    })
    .catch(() => {});
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Semantic search ───────────────────────────────────────────────────────────

interface AgentEmbeddingRow {
  agent_id: string;
  name: string;
  capabilities: string;
  price: string | null;
  reputation: number;
  category: string | null;
  wallet_address: string | null;
  provider: string | null;
  provider_model: string | null;
  provider_endpoint: string | null;
  public_key: string;
  endpoint: string | null;
  verification_status: string | null;
  last_verified_at: string | null;
  created_at: string;
  embedding: string | null;
}

export async function semanticSearchAgents(
  query: string,
  opts: SearchOptions & { q: string }
): Promise<Agent[] | null> {
  const queryEmbedding = await generateEmbedding(query.slice(0, MAX_TEXT_CHARS));
  if (!queryEmbedding) return null; // no API key or error — caller falls back

  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM agents WHERE embedding IS NOT NULL")
    .all() as AgentEmbeddingRow[];

  if (rows.length === 0) return [];

  // Pull task success rates for all agents in one query — new agents default to 0.5 (neutral)
  const taskStats = db.prepare(`
    SELECT
      to_agent AS agentId,
      CAST(COUNT(*) FILTER (WHERE status = 'completed') AS REAL)
        / NULLIF(COUNT(*) FILTER (WHERE status IN ('completed', 'failed')), 0) AS successRate
    FROM tasks
    WHERE status IN ('completed', 'failed')
    GROUP BY to_agent
  `).all() as { agentId: string; successRate: number | null }[];
  const successRateMap = new Map(taskStats.map((s) => [s.agentId, s.successRate ?? 0.5]));

  // Blended score: similarity (primary) + success rate + price signal
  const scored: { agent: AgentEmbeddingRow; score: number }[] = [];
  for (const row of rows) {
    if (!row.embedding) continue;
    let vec: number[];
    try {
      vec = JSON.parse(row.embedding) as number[];
    } catch {
      continue;
    }
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) continue;
    const similarity = cosineSimilarity(queryEmbedding, vec);
    const successRate = successRateMap.get(row.agent_id) ?? 0.5;
    const priceScore = row.price ? 0.8 : 1.0;
    const blendedScore = similarity * 0.6 + successRate * 0.3 + priceScore * 0.1;
    scored.push({ agent: row, score: blendedScore });
  }

  scored.sort((a, b) => b.score - a.score);

  // Apply the same post-filters as searchAgents
  let filtered = scored;

  // Capability filter: if caller specified ?capability= or ?capabilities=, agent must have ALL
  const requiredCaps = [
    ...(opts.capability ? [opts.capability] : []),
    ...(opts.capabilities ?? []),
  ].filter(Boolean);
  if (requiredCaps.length > 0) {
    filtered = filtered.filter((s) => {
      let caps: string[] = [];
      try {
        const parsed = JSON.parse(s.agent.capabilities) as unknown;
        if (Array.isArray(parsed)) caps = parsed.filter((c): c is string => typeof c === "string");
      } catch {
        return false;
      }
      return requiredCaps.every((req) => caps.includes(req));
    });
  }

  if (opts.minReputation !== undefined) {
    filtered = filtered.filter((s) => s.agent.reputation >= opts.minReputation!);
  }
  if (opts.category && opts.category !== "All") {
    filtered = filtered.filter((s) => (s.agent.category ?? "General") === opts.category);
  }
  if (opts.maxPrice) {
    const max = parsePaymentAmount(opts.maxPrice);
    if (max) {
      filtered = filtered.filter((s) => {
        if (!s.agent.price) return true;
        const agentPrice = parsePaymentAmount(s.agent.price);
        if (!agentPrice) return false;
        if (agentPrice.currency !== max.currency) return false;
        return agentPrice.amount <= max.amount;
      });
    }
  }

  const limit = opts.limit ?? 10;
  return filtered.slice(0, limit).map((s) => rowToAgent(s.agent));
}

function rowToAgent(row: AgentEmbeddingRow): Agent {
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(row.capabilities) as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.filter((c): c is string => typeof c === "string");
  } catch { /* */ }

  return {
    agentId: row.agent_id,
    name: row.name,
    capabilities,
    publicKey: row.public_key,
    endpoint: row.endpoint ?? undefined,
    price: row.price ?? undefined,
    reputation: row.reputation,
    category: row.category ?? "General",
    walletAddress: row.wallet_address ?? undefined,
    provider: (row.provider ?? "anthropic") as Agent["provider"],
    providerModel: row.provider_model ?? undefined,
    providerEndpoint: row.provider_endpoint ?? undefined,
    verificationStatus: (row.verification_status ?? "unverified") as Agent["verificationStatus"],
    lastVerifiedAt: row.last_verified_at ?? undefined,
    createdAt: row.created_at,
  };
}
