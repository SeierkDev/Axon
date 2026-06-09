// Seeds the 15 built-in Axon agents into the agents table on first run.
// Called once from the DB migration — safe to call multiple times (INSERT OR IGNORE).

import type { Database } from "better-sqlite3";

interface BuiltinAgent {
  agentId: string;
  name: string;
  capabilities: string[];
  category: string;
  price: string | null;
}

const BUILTIN_AGENTS: BuiltinAgent[] = [
  { agentId: "research-agent", name: "Research Agent",  capabilities: ["research", "analysis", "summarization", "search"], category: "Research",     price: "0.10 USDC" },
  { agentId: "crypto-agent",   name: "Crypto Agent",    capabilities: ["crypto", "blockchain", "analysis"],                 category: "Finance",      price: "0.15 USDC" },
  { agentId: "trading-agent",  name: "Trading Agent",   capabilities: ["trading", "analysis", "crypto"],                   category: "Finance",      price: "0.20 USDC" },
  { agentId: "audit-agent",    name: "Audit Agent",     capabilities: ["smart-contract-audit", "security", "coding"],      category: "Development",  price: "0.50 USDC" },
  { agentId: "defi-agent",     name: "DeFi Agent",      capabilities: ["defi", "analysis", "blockchain"],                  category: "Finance",      price: "0.15 USDC" },
  { agentId: "data-agent",     name: "Data Agent",      capabilities: ["data-analysis", "analysis"],                       category: "Research",     price: "0.10 USDC" },
  { agentId: "content-agent",  name: "Content Agent",   capabilities: ["writing", "content", "creative"],                  category: "Content",      price: "0.10 USDC" },
  { agentId: "code-agent",     name: "Code Agent",      capabilities: ["coding", "development", "debugging"],              category: "Development",  price: "0.25 USDC" },
  { agentId: "onchain-agent",  name: "On-Chain Agent",  capabilities: ["blockchain", "analysis", "data-analysis"],         category: "Finance",      price: "0.15 USDC" },
  { agentId: "strategy-agent", name: "Strategy Agent",  capabilities: ["strategy", "analysis", "writing"],                 category: "Research",     price: "0.20 USDC" },
  { agentId: "seo-agent",      name: "SEO Agent",       capabilities: ["seo", "writing", "analysis"],                      category: "Content",      price: "0.10 USDC" },
  { agentId: "social-agent",   name: "Social Agent",    capabilities: ["writing", "social", "creative"],                   category: "Content",      price: "0.10 USDC" },
  { agentId: "email-agent",    name: "Email Agent",     capabilities: ["writing", "email", "creative"],                    category: "Content",      price: "0.10 USDC" },
  { agentId: "report-agent",   name: "Report Agent",    capabilities: ["writing", "analysis", "research"],                 category: "Research",     price: "0.25 USDC" },
  { agentId: "web-agent",      name: "Web Agent",       capabilities: ["research", "search", "web"],                       category: "Research",     price: "0.10 USDC" },
];

export function seedBuiltinAgents(db: Database): void {
  // INSERT OR REPLACE so re-running the seed fixes corrupted placeholder data.
  // wallet_address is intentionally NULL — built-in agents are platform-owned.
  const upsertAgent = db.prepare(`
    INSERT INTO agents
      (agent_id, name, capabilities, public_key, price, reputation, category, provider, wallet_address, created_at)
    VALUES (?, ?, ?, 'axon-platform', ?, 0, ?, 'anthropic', NULL, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name         = excluded.name,
      capabilities = excluded.capabilities,
      price        = excluded.price,
      category     = excluded.category,
      provider     = excluded.provider,
      wallet_address = NULL
  `);
  const insertCap = db.prepare(
    "INSERT OR IGNORE INTO agent_capabilities (capability, agent_id) VALUES (?, ?)"
  );

  const now = new Date().toISOString();

  db.transaction(() => {
    for (const agent of BUILTIN_AGENTS) {
      upsertAgent.run(
        agent.agentId,
        agent.name,
        JSON.stringify(agent.capabilities),
        agent.price,
        agent.category,
        now,
      );
      for (const cap of agent.capabilities) {
        insertCap.run(cap, agent.agentId);
      }
    }
  })();
}
