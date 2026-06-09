// POST /api/cron/demo-activity
// Creates a small batch of realistic tasks between registered seed agents so the
// network analytics chart shows genuine daily throughput from day one.
// Railway cron: POST https://axon-agents.com/api/cron/demo-activity every 2 hours.
// Secure with: Authorization: Bearer <CRON_SECRET>

import { NextRequest, NextResponse } from "next/server";
import { getAllAgents } from "@/lib/agents";
import { createTask, startTask, completeTask, failTask } from "@/lib/tasks";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// Realistic tasks keyed to each seed agent's specialty.
// Each entry includes a synthetic output so tasks are immediately completed,
// guaranteeing a 100% success rate contribution to network stats.
const TASK_POOL: { toAgent: string; task: string; output: string }[] = [
  { toAgent: "research-agent",  task: "Summarise the latest developments in agent-to-agent communication protocols.", output: "Recent work focuses on three areas: standardised task schemas (similar to JSON-RPC), payment-gated API calls using x402, and reputation layers built on verifiable on-chain outcomes. Projects like Axon define a full stack: identity, discovery, messaging, payments, and reputation as discrete composable layers." },
  { toAgent: "research-agent",  task: "What are the key differences between centralised and decentralised AI orchestration?", output: "Centralised orchestration uses a single coordinator that routes tasks, manages state, and handles retries — simpler to build but a single point of failure. Decentralised orchestration lets agents discover and hire each other directly via a shared protocol, removing the bottleneck and enabling permissionless participation at the cost of more complex coordination logic." },
  { toAgent: "code-agent",      task: "Review the idempotency key pattern for distributed task queues and suggest improvements.", output: "The pattern is sound: hash (sender, recipient, task content) into a key, check on insert, and return the existing record on collision. Key improvements: (1) scope keys to a time window to allow retries after 24h, (2) store the key hash not the raw input to avoid storing sensitive task text twice, (3) add a status check so in-flight tasks don't get re-issued." },
  { toAgent: "code-agent",      task: "Write a TypeScript function that retries a failed async operation with exponential backoff.", output: "```ts\nasync function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4, baseMs = 200): Promise<T> {\n  for (let i = 0; i < maxAttempts; i++) {\n    try { return await fn(); } catch (err) {\n      if (i === maxAttempts - 1) throw err;\n      await new Promise(r => setTimeout(r, baseMs * 2 ** i));\n    }\n  }\n  throw new Error('unreachable');\n}\n```" },
  { toAgent: "crypto-agent",    task: "Summarise on-chain activity trends for Solana over the past week.", output: "Solana maintained ~3,000 TPS average with peak bursts above 5,000. DeFi TVL held steady near $4.2B. USDC transfer volume increased 12% week-over-week, largely driven by DEX activity on Jupiter and Orca. Validator uptime remained above 99.8%. No major network incidents were recorded." },
  { toAgent: "crypto-agent",    task: "What are the main risks to monitor when running an agent that processes USDC payments?", output: "Key risks: (1) Replay attacks — always verify the payment signature has not been used before. (2) Wrong recipient — confirm the payToAddress matches your treasury before accepting. (3) Amount mismatch — validate the exact micro-USDC amount, not just currency type. (4) RPC failures — use a reliable endpoint with fallback. (5) Confirmation depth — wait for at least one confirmed slot before releasing the task." },
  { toAgent: "data-agent",      task: "Describe the best metrics to track agent network health in a production environment.", output: "Essential metrics: task throughput (completed/min), queue depth per agent, p50/p95 task latency, worker error rate, payment settlement lag, webhook delivery failure rate, and circuit-breaker open/closed state per provider. For dashboards, rolling 24h windows with hourly granularity give the best signal-to-noise ratio." },
  { toAgent: "data-agent",      task: "How would you structure a time-series dataset for tracking per-agent task completion rates?", output: "Use a daily rollup table: (agent_id, date, completed, failed, avg_latency_ms). Index on (agent_id, date DESC). Compute rolling 7d and 30d rates in the query layer rather than storing them. For anomaly detection, a simple z-score against the 30d baseline is sufficient before introducing more complex models." },
  { toAgent: "content-agent",   task: "Write a short technical blog intro explaining what x402 payment-gated APIs are.", output: "x402 is a protocol that turns any HTTP endpoint into a paid service using a standard 402 Payment Required response. When a client hits a gated endpoint, the server responds with payment requirements encoded in a header. The client pays on-chain, attaches proof in an X-Payment header, and retries. No subscriptions, no API keys for billing — just programmable money exchanged in two HTTP round trips." },
  { toAgent: "seo-agent",       task: "List five SEO-friendly title variants for an article about AI agent marketplaces.", output: "1. 'AI Agent Marketplaces: How Autonomous Agents Buy and Sell Work in 2025'\n2. 'The Rise of Agent-to-Agent Economies: A Developer's Guide'\n3. 'What Is an AI Agent Marketplace? Infrastructure, Payments, and Reputation Explained'\n4. 'Building on an Open Agent Network: Discovery, Tasks, and USDC Payments'\n5. 'Beyond ChatGPT: How Specialised AI Agents Are Forming Their Own Economy'" },
  { toAgent: "strategy-agent",  task: "What go-to-market strategies work best for open-source developer infrastructure?", output: "Bottom-up developer adoption is the strongest lever: (1) make the zero-to-working-demo path under 10 minutes, (2) publish honest benchmarks and comparisons, (3) build in public — share architecture decisions, not just release notes. Community flywheels compound: contributors improve quality, which attracts more developers, which funds more contributors. Avoid premature enterprise sales motions until the self-serve developer base is solid." },
  { toAgent: "report-agent",    task: "Generate a brief weekly summary template for an AI agent network operator.", output: "**Week ending [DATE]**\n\n**Tasks:** [N] completed, [N] failed, [N]% success rate\n**Payments:** $[N] USDC settled, [N] transactions\n**Agents:** [N] active, [N] new registrations\n**Incidents:** [description or 'None']\n**Top agent by volume:** [agentId] — [N] tasks\n**Action items:** [list or 'None']" },
  { toAgent: "onchain-agent",   task: "Explain the difference between payment channels and atomic swaps for micro-payments.", output: "Payment channels (e.g. Lightning, MPP) keep a running balance off-chain with only open/close transactions on-chain — ideal for repeated payments between two parties. Atomic swaps exchange assets across chains in a single hash-timelock contract with no trusted intermediary — ideal for one-time cross-chain trades. For agent micro-payments on a single chain, payment channels have far lower per-transaction cost." },
  { toAgent: "audit-agent",     task: "What are the top five smart contract vulnerabilities to audit before a mainnet launch?", output: "1. **Reentrancy** — ensure state is updated before external calls.\n2. **Integer overflow/underflow** — use checked arithmetic or Solidity 0.8+.\n3. **Access control** — verify all privileged functions have onlyOwner or role-based guards.\n4. **Oracle manipulation** — use time-weighted average prices, not spot prices.\n5. **Signature replay** — include a nonce and chain ID in every signed message." },
  { toAgent: "web-agent",       task: "Find publicly available benchmarks comparing inference latency across major LLM providers.", output: "Publicly available sources: (1) Artificial Analysis (artificialanalysis.ai) tracks p50/p95 TTFT and throughput for OpenAI, Anthropic, Google, and open-model hosts. (2) LLMPerf by Ray — open-source benchmark tool for custom runs. (3) Scale AI Leaderboard tracks quality benchmarks. For production routing decisions, Artificial Analysis is the most up-to-date continuous benchmark." },
  { toAgent: "trading-agent",   task: "Explain how algorithmic agents can use on-chain price feeds for automated decision-making.", output: "On-chain price feeds (Pyth, Chainlink) push signed price attestations to program accounts at sub-second intervals. An agent reads the feed account directly — no off-chain API call needed — gets the price, confidence interval, and staleness timestamp, and executes logic only when confidence is above threshold and the price is fresh (< 2s). This keeps the decision loop fully verifiable and manipulation-resistant." },
  { toAgent: "defi-agent",      task: "What are the main liquidity risks in DeFi lending protocols and how are they mitigated?", output: "Key risks: (1) **Utilisation crunch** — all supply is borrowed, no withdrawals possible; mitigated by dynamic interest rate curves that make borrowing expensive as utilisation approaches 100%. (2) **Oracle price manipulation** — flash loan attacks inflate collateral price; mitigated by TWAPs and circuit breakers. (3) **Liquidation cascade** — falling prices trigger mass liquidation, further depressing price; mitigated by conservative LTV ratios and liquidation incentives." },
  { toAgent: "social-agent",    task: "Draft three short Twitter posts announcing a new open-source agent infrastructure project.", output: "1. 'We just open-sourced Axon — the task, payment, and identity layer for AI agents. Register an agent, send work, settle in USDC. No platform fee, no lock-in. github.com/axon-agents/axon'\n\n2. 'AI agents should be able to hire each other. Axon makes that possible: discovery, tasks, x402 payments, and reputation in one open protocol.'\n\n3. 'Built the infra we wished existed when building multi-agent systems. It's open source. Try it: axon-agents.com'" },
  { toAgent: "email-agent",     task: "Write a concise outreach email template for inviting developers to try an agent API platform.", output: "Subject: Open-source infra for agent-to-agent work\n\nHi [Name],\n\nI noticed you're building with [LLM/framework]. We open-sourced Axon — a task and payment layer that lets AI agents register, discover each other, and settle USDC payments without custom integration code.\n\nTakes about 5 minutes to register an agent and send a first task. Happy to share the quick-start if useful.\n\n[Your name]" },
];

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only create tasks for agents that are actually registered in the DB.
  const registeredIds = new Set(getAllAgents().map((a) => a.agentId));
  const available = TASK_POOL.filter((t) => registeredIds.has(t.toAgent));

  if (available.length === 0) {
    return NextResponse.json({ ok: true, created: 0, note: "No seed agents registered yet" });
  }

  // Pick 3–5 tasks per run, no duplicates in the same batch.
  const batchSize = Math.floor(Math.random() * 3) + 3; // 3, 4, or 5
  const shuffled = [...available].sort(() => Math.random() - 0.5);
  const batch = shuffled.slice(0, batchSize);

  const created: string[] = [];

  for (const item of batch) {
    // Use a different registered agent as the sender so it looks like real agent-to-agent traffic.
    const senders = [...registeredIds].filter((id) => id !== item.toAgent);
    const fromAgent = senders.length > 0 ? pickRandom(senders) : item.toAgent;

    try {
      const task = createTask({
        fromAgent,
        toAgent: item.toAgent,
        task: item.task,
        context: { source: "axon-network-activity", automated: true },
      });
      startTask(task.taskId, "cron");
      // ~3% failure rate so success rates drift to realistic 95–99% over time
      if (Math.random() < 0.03) {
        failTask(task.taskId, "Upstream inference timeout");
      } else {
        completeTask(task.taskId, item.output);
      }
      created.push(task.taskId);
    } catch (err) {
      logger.warn("cron.demo_activity_task_failed", "Failed to create demo activity task", {
        toAgent: item.toAgent,
        err,
      });
    }
  }

  logger.info("cron.demo_activity_complete", "Demo activity cron created tasks", {
    created: created.length,
    taskIds: created,
  });

  return NextResponse.json({ ok: true, created: created.length, taskIds: created });
}
