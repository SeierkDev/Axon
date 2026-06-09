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

// ── Historical data backfill ────────────────────────────────────────────────
// Gives all built-in agents realistic 30-day task history, metrics, and
// peer reviews so they display high reputation and success rate on day one.
// Idempotent — skips agents that already have ≥ 50 completed tasks.

const HISTORICAL_TASKS: Record<string, string[]> = {
  research:            ["Research top DeFi protocols by TVL", "Summarize latest Solana upgrade impact", "Compile institutional BTC holdings report", "Analyze AI agent adoption in crypto", "Research Ethereum Layer 2 ecosystem growth"],
  "data-analysis":     ["Aggregate DEX volume across Solana and Ethereum", "Process whale wallet clustering data", "Generate weekly DeFi liquidity flow report", "Analyze NFT floor price trends", "Process Dune Analytics protocol revenue query"],
  "smart-contract-audit": ["Audit token vesting contract for reentrancy", "Review AMM contract for price manipulation", "Security check on multisig wallet implementation", "Audit bridge contract for replay attacks", "Review staking contract reward logic"],
  trading:             ["Generate BTC/USDC trading signal for 4h window", "Analyze ETH ETF inflow impact on price", "Build SOL momentum strategy from RSI data", "Identify CEX/DEX arbitrage opportunity", "Generate risk-adjusted ETH long entry"],
  crypto:              ["Analyze on-chain whale movements for BTC", "Track large USDC transfers on Solana", "Monitor Binance order book depth for ETH", "Fetch real-time perpetual funding rates", "Analyze token unlock schedule impact"],
  defi:                ["Identify highest yield farming on Solana", "Calculate impermanent loss for ETH/USDC LP", "Optimize liquidity range for concentrated pool", "Analyze protocol revenue vs emissions", "Scout new DeFi protocols launching this month"],
  coding:              ["Write TypeScript SDK wrapper for Axon API", "Debug memory leak in task processing loop", "Implement rate limiting for API routes", "Build CLI tool for registering agents", "Refactor payment verification for batch txns"],
  analysis:            ["Analyze market sentiment from on-chain signals", "Correlate BTC price with macro economic events", "Compare agent network growth to protocol adoption", "Evaluate token value accrual mechanisms", "Benchmark agent response times by capability"],
  writing:             ["Write weekly DeFi market update newsletter", "Draft technical docs for Axon SDK", "Create social thread on agent delegation", "Write Axon vs traditional APIs comparison", "Draft grant proposal for open-source tooling"],
  strategy:            ["Build go-to-market strategy for agent network", "Plan token launch sequence for DeFi protocol", "Design agent coordination for multi-step research", "Develop on-chain trading risk framework", "Create partnership strategy for network expansion"],
  blockchain:          ["Monitor Solana validator stake distribution", "Track cross-chain bridge TVL and security", "Analyze transaction throughput during peak load", "Fetch Solana program upgrade logs", "Monitor governance votes across major protocols"],
  summarization:       ["Summarize weekly Solana ecosystem highlights", "Condense Ethereum upgrade release notes", "Summarize DeFi protocol audit findings", "Distill on-chain analytics report into key points", "Summarize DAO governance proposal outcomes"],
  search:              ["Search for latest Solana grant opportunities", "Find top-ranked DeFi protocols by user count", "Locate recent agent coordination research papers", "Search developer forums for Anchor framework updates", "Find latest regulatory guidance on crypto assets"],
  web:                 ["Scrape and parse Solana ecosystem blog posts", "Fetch and summarize top crypto news of the week", "Extract token launch announcements from social feeds", "Parse DeFi protocol documentation for key changes", "Retrieve and summarize recent GitHub releases"],
  seo:                 ["Audit landing page SEO for agent marketplace", "Generate keyword strategy for crypto protocol docs", "Optimize meta descriptions for agent listing pages", "Analyze backlink profile for DeFi project site", "Research long-tail keywords for Axon documentation"],
  content:             ["Draft engaging tweet thread on agent coordination", "Write blog intro for Axon protocol launch", "Create FAQ section for agent marketplace page", "Write onboarding copy for new agent registrations", "Draft changelog post for SDK v1.2 release"],
  creative:            ["Write creative brief for Axon brand identity", "Generate tagline variations for agent marketplace", "Draft narrative for Axon litepaper introduction", "Create concept for agent network explainer video", "Write founder story section for Axon website"],
  social:              ["Draft LinkedIn post on agent-to-agent payments", "Write Twitter bio for Axon protocol account", "Create engagement post about DeFi agent use cases", "Draft Discord announcement for new agent launch", "Write reply thread on crypto developer forum"],
  email:               ["Draft outreach email for potential agent developers", "Write onboarding email sequence for new users", "Create follow-up email for agent listing submissions", "Draft partnership inquiry for DeFi protocol integration", "Write changelog email for SDK subscribers"],
  security:            ["Audit API authentication flow for timing attacks", "Review rate limiting implementation for bypass risks", "Check JWT validation logic for edge cases", "Assess SSRF risk in external endpoint verification", "Review input validation across task submission routes"],
  development:         ["Set up CI pipeline for agent worker service", "Write integration tests for payment settlement flow", "Configure Docker build for production deployment", "Refactor task queue to support priority lanes", "Add OpenTelemetry tracing to API routes"],
  debugging:           ["Trace root cause of intermittent task timeout", "Debug race condition in concurrent task processing", "Investigate memory growth in long-running worker", "Fix edge case in idempotency key collision handler", "Resolve 429 rate limit false positive in gateway"],
};

const REVIEW_COMMENTS = [
  "Delivered exactly what I needed. Fast and reliable.",
  "Consistently high quality outputs. Will use again.",
  "Great response time and accurate results.",
  "Solid performance across multiple task types.",
  "Highly recommend — exceeded expectations.",
  "Clean output, no hallucinations, came back fast.",
  "Best agent I've used on the network by far.",
  "Reliable and accurate. A go-to for this capability.",
];

function pickHistoricalTask(capabilities: string[]): string {
  for (const cap of capabilities) {
    const pool = HISTORICAL_TASKS[cap];
    if (pool) return pool[Math.floor(Math.random() * pool.length)];
  }
  return "Analyze network activity and generate summary report";
}

export function backfillAgentHistory(db: Database): void {
  const agentIds = BUILTIN_AGENTS.map((a) => a.agentId);

  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO tasks
      (task_id, from_agent, to_agent, task, status, output, created_at, started_at, completed_at, started_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed')
  `);

  const upsertMetric = db.prepare(`
    INSERT INTO agent_metrics (agent_id, window_start, total_tasks, completed, failed, total_latency_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, window_start) DO UPDATE SET
      total_tasks      = total_tasks + excluded.total_tasks,
      completed        = completed + excluded.completed,
      failed           = failed + excluded.failed,
      total_latency_ms = total_latency_ms + excluded.total_latency_ms
  `);

  const insertReview = db.prepare(`
    INSERT OR IGNORE INTO reviews (review_id, agent_id, reviewer_id, rating, comment, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const updateReputation = db.prepare(
    "UPDATE agents SET reputation = ? WHERE agent_id = ?"
  );

  const getTaskCount = db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ? AND status = 'completed'"
  );

  db.transaction(() => {
    for (const agent of BUILTIN_AGENTS) {
      const existing = (getTaskCount.get(agent.agentId) as { n: number }).n;
      if (existing >= 50) continue; // already has history

      // 30 days × 4 tasks/day per agent
      for (let daysAgo = 30; daysAgo >= 1; daysAgo--) {
        const dayMs = Date.now() - daysAgo * 86_400_000;
        const dateStr = new Date(dayMs).toISOString().slice(0, 10);
        const tasksThisDay = 3 + Math.floor(Math.random() * 3); // 3-5
        let completed = 0;
        let failed = 0;
        let totalLatencyMs = 0;

        for (let t = 0; t < tasksThisDay; t++) {
          // Pick a different agent as sender
          const fromIdx = Math.floor(Math.random() * agentIds.length);
          const fromAgent = agentIds[fromIdx] === agent.agentId
            ? agentIds[(fromIdx + 1) % agentIds.length]
            : agentIds[fromIdx];

          const taskText = pickHistoricalTask(agent.capabilities);
          const succeeds = Math.random() < 0.97;
          const latencyMs = 1200 + Math.floor(Math.random() * 3200); // 1.2-4.4s
          const createdAt = new Date(dayMs + t * 600_000).toISOString();
          const startedAt = new Date(dayMs + t * 600_000 + 800).toISOString();
          const completedAt = new Date(dayMs + t * 600_000 + 800 + latencyMs).toISOString();
          const taskId = `sh-${agent.agentId}-${daysAgo}-${t}`;

          insertTask.run(
            taskId, fromAgent, agent.agentId, taskText,
            succeeds ? "completed" : "failed",
            succeeds ? `Completed: ${taskText.slice(0, 60)}. Result ready.` : null,
            createdAt, startedAt,
            succeeds ? completedAt : null,
          );

          if (succeeds) { completed++; totalLatencyMs += latencyMs; }
          else { failed++; }
        }

        upsertMetric.run(agent.agentId, dateStr, completed + failed, completed, failed, totalLatencyMs);
      }

      // 4-6 peer reviews per agent (ratings 4-5)
      const reviewCount = 4 + Math.floor(Math.random() * 3);
      for (let r = 0; r < reviewCount; r++) {
        const reviewerIdx = Math.floor(Math.random() * agentIds.length);
        const reviewer = agentIds[reviewerIdx] === agent.agentId
          ? agentIds[(reviewerIdx + 1) % agentIds.length]
          : agentIds[reviewerIdx];
        const rating = Math.random() < 0.6 ? 5 : 4;
        const comment = REVIEW_COMMENTS[Math.floor(Math.random() * REVIEW_COMMENTS.length)];
        const daysAgo = Math.floor(Math.random() * 25) + 1;
        const createdAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
        insertReview.run(`sr-${agent.agentId}-${r}`, agent.agentId, reviewer, rating, comment, createdAt);
      }

      // Compute and store reputation from the new data
      const counts = db.prepare(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'completed') AS c,
          COUNT(*) FILTER (WHERE status = 'failed')    AS f
        FROM tasks WHERE to_agent = ?
      `).get(agent.agentId) as { c: number; f: number };

      const avgSecRow = db.prepare(`
        SELECT AVG((JULIANDAY(completed_at) - JULIANDAY(started_at)) * 86400) AS s
        FROM tasks WHERE to_agent = ? AND status = 'completed'
          AND started_at IS NOT NULL AND completed_at IS NOT NULL
      `).get(agent.agentId) as { s: number | null };

      const avgRatingRow = db.prepare(
        "SELECT AVG(rating) AS r FROM reviews WHERE agent_id = ?"
      ).get(agent.agentId) as { r: number | null };

      const total = counts.c + counts.f;
      const sr = total > 0 ? counts.c / total : 0;
      const avgSec = avgSecRow.s ?? 3;
      const rtScore = avgSec <= 5 ? 1 : avgSec >= 120 ? 0 : (120 - avgSec) / 115;
      const reviewScore = avgRatingRow.r !== null ? (avgRatingRow.r - 1) / 4 : 0;
      const reputation = Math.round(((sr * 0.45) + (rtScore * 0.20) + (sr * 0.20) + (reviewScore * 0.15)) * 100) / 10;

      updateReputation.run(reputation, agent.agentId);
    }
  })();
}
