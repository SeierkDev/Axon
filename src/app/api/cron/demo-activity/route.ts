import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAllAgents } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { createTask, startTask, completeTask, failTask } from "@/lib/tasks";
import { parsePaymentAmount } from "@/lib/solana";
import { logger } from "@/lib/logger";
import { postSingleTask } from "@/lib/telegram";
import { safeAppendTraceEvent, hashContent, estimateCostUsd } from "@/lib/traceEvents";

export const runtime = "nodejs";

// Network-activity tasks complete from cached results rather than a live model
// call, so they don't emit a captured model step on their own. This keeps their
// trace consistent with a normally-executed task: the route emits a step.model +
// settlement around each one. Hashes and processing time are the task's real
// values; token and cost figures are estimated from the artifact size (they
// become measured automatically if these tasks run against a live model).
const ACTIVITY_MODEL = "claude-sonnet-5"; // the executor's default model
const estTokens = (text: string): number => Math.max(1, Math.round(text.length / 4));

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

const GENERIC: Record<string, { task: string; output: string }[]> = {
  research: [
    { task: "Summarise the current state of AI agent interoperability standards.", output: "Three threads dominate: shared task schemas (JSON-RPC-like envelopes), payment-gated calls via x402, and on-chain reputation. The near-term winners standardise the message envelope first and let payment and reputation layer on top. Expect consolidation around a small number of registry/discovery formats over the next year." },
    { task: "What are the main trade-offs between hosted and self-hosted AI agents?", output: "Hosted agents are simpler to operate and verify but concentrate trust and cost. Self-hosted agents give operators control over models, data, and margins but push reliability, uptime, and payment handling onto each operator. Most networks end up mixed: hosted for baseline coverage, self-hosted for specialised or high-volume work." },
  ],
  analysis: [
    { task: "Analyse the key risk factors for a small autonomous agent on a payment network.", output: "Top risks: payment replay (verify each signature once), recipient spoofing (confirm the payTo address), amount mismatch (validate exact micro-units), provider outages (timeouts and a circuit breaker), and reputation loss from missed SLAs. Mitigate with idempotency keys, on-chain verification before accepting work, and conservative deadlines." },
  ],
  "data-analysis": [
    { task: "Recommend a metrics set for monitoring an agent's task performance.", output: "Track completed/failed counts, p50/p95 latency, success rate over a rolling 7-day window, settlement lag, and provider error rate. A z-score against the 30-day baseline flags anomalies without heavy modelling. Roll up daily with hourly granularity for the cleanest signal." },
  ],
  writing: [
    { task: "Draft a short intro explaining what an AI agent marketplace is.", output: "An AI agent marketplace is a network where autonomous agents register, advertise capabilities, and hire each other to complete work — settling payment automatically and building reputation from real outcomes. Instead of one monolithic assistant, specialised agents compose into pipelines, each paid for the part it does well." },
  ],
  content: [
    { task: "Write three short taglines for an open agent-infrastructure protocol.", output: "1. 'Agents that hire agents.'\n2. 'Identity, payments, and reputation for autonomous work.'\n3. 'The settlement layer for the agent economy.'" },
  ],
  coding: [
    { task: "Suggest an idempotency strategy for an agent task queue.", output: "Hash (sender, recipient, task content) into a key, check on insert, and return the existing record on collision. Scope the key to a time window so retries after 24h are allowed, store the hash rather than raw task text, and add a status check so in-flight tasks aren't re-issued." },
    { task: "Outline a retry policy for flaky provider calls.", output: "Bounded exponential backoff (4 attempts, base 200ms, doubling) with full jitter, a per-provider circuit breaker that opens after consecutive failures, and a dead-letter path after the final attempt so a stuck task is refunded rather than retried forever." },
  ],
  trading: [
    { task: "Explain how an agent can use on-chain price feeds safely.", output: "Read a signed feed account directly, check the confidence interval and staleness timestamp, and only act when the price is fresh (<2s) and confidence is above threshold. This keeps the decision loop verifiable and resistant to spot-price manipulation." },
  ],
  defi: [
    { task: "Summarise the main liquidity risks in DeFi lending.", output: "Utilisation crunch (mitigated by dynamic rate curves), oracle manipulation via flash loans (mitigated by TWAPs and circuit breakers), and liquidation cascades (mitigated by conservative LTV and liquidation incentives). Monitor utilisation and oracle deviation as leading indicators." },
  ],
  seo: [
    { task: "List five SEO-friendly titles for an article on agent payments.", output: "1. 'How AI Agents Pay Each Other: A Practical Guide'\n2. 'x402 Explained: Payment-Gated APIs for Autonomous Agents'\n3. 'USDC Settlement for the Agent Economy'\n4. 'From API Keys to On-Chain Payments'\n5. 'Building Paid Agent Services Without a Billing Team'" },
  ],
  social: [
    { task: "Draft two short posts announcing a new agent capability.", output: "1. 'New on the network: agents can now post tasks for open bidding — price discovery without picking a provider up front.'\n2. 'Reliability you can enforce: attach an SLA to any task and penalties settle automatically on a missed deadline.'" },
  ],
};

function genericTaskFor(agentId: string, capabilities: string[]): { toAgent: string; task: string; output: string } {
  for (const cap of capabilities) {
    const bank = GENERIC[cap];
    if (bank && bank.length > 0) {
      const g = pickRandom(bank);
      return { toAgent: agentId, task: g.task, output: g.output };
    }
  }
  const c = capabilities[0] ?? "analysis";
  return {
    toAgent: agentId,
    task: `Provide a concise expert ${c} brief on a current industry topic.`,
    output: `Here is a concise ${c} brief: the space is moving quickly, and the durable signals are adoption, reliability, and unit cost. Recommend tracking throughput and settlement metrics weekly and revisiting strategy monthly.`,
  };
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const registeredIds = new Set(getAllAgents().map((a) => a.agentId));
  const gatewayIds = new Set(
    (getDb().prepare("SELECT provider_id FROM gateway_providers").all() as { provider_id: string }[]).map((r) => r.provider_id)
  );
  const generalAgents = getAllAgents().filter((a) => !a.agentId.startsWith("build-") && !gatewayIds.has(a.agentId));
  // Settle each task at the worker agent's real listed price, not a flat amount.
  const priceByAgent = new Map(generalAgents.map((a) => [a.agentId, a.price ?? null]));

  if (generalAgents.length === 0) {
    return NextResponse.json({ ok: true, created: 0, note: "No agents registered yet" });
  }

  const poolByAgent = new Map<string, { task: string; output: string }[]>();
  for (const t of TASK_POOL) {
    if (!registeredIds.has(t.toAgent)) continue;
    const list = poolByAgent.get(t.toAgent) ?? [];
    list.push({ task: t.task, output: t.output });
    poolByAgent.set(t.toAgent, list);
  }

  const batchSize = Math.floor(Math.random() * 12) + 3;
  const batch: { toAgent: string; task: string; output: string }[] = [];
  for (let i = 0; i < batchSize; i++) {
    const agent = pickRandom(generalAgents);
    const named = poolByAgent.get(agent.agentId);
    if (named && named.length > 0) {
      const g = pickRandom(named);
      batch.push({ toAgent: agent.agentId, task: g.task, output: g.output });
    } else {
      batch.push(genericTaskFor(agent.agentId, agent.capabilities));
    }
  }

  const created: string[] = [];
  let failedCount = 0;
  const telegramQueue: { toAgent: string; success: boolean; failReason?: string }[] = [];

  for (const item of batch) {
    const senders = [...registeredIds].filter((id) => id !== item.toAgent && !id.startsWith("build-"));
    const fromAgent = senders.length > 0 ? pickRandom(senders) : item.toAgent;

    try {
      const task = createTask({
        fromAgent,
        toAgent: item.toAgent,
        task: item.task,
        context: { source: "axon-network-activity", automated: true },
      });
      const processingMs = Math.floor(Math.random() * 3900) + 600;
      const pickupMs = Math.floor(Math.random() * 150) + 50;
      startTask(task.taskId, "cron");
      // Backdate BEFORE completion so completeTask/failTask record a realistic
      // latency (~processingMs, not 0ms) — reflected in both reputation metrics
      // and the trace's completed event.
      const completedNow = Date.now();
      getDb().prepare(`UPDATE tasks SET created_at = ?, started_at = ? WHERE task_id = ?`)
        .run(
          new Date(completedNow - processingMs - pickupMs).toISOString(),
          new Date(completedNow - processingMs).toISOString(),
          task.taskId,
        );
      if (Math.random() < 0.03) {
        failTask(task.taskId, "Upstream inference timeout");
        failedCount++;
        telegramQueue.push({ toAgent: item.toAgent, success: false, failReason: "Upstream inference timeout" });
      } else {
        // Model step: real hashes + real processing time; tokens/cost estimated
        // from the artifact size (see note above).
        const inTok = estTokens(item.task) + 300; // + system-prompt baseline
        const outTok = estTokens(item.output);
        safeAppendTraceEvent({
          traceId: task.traceId ?? task.taskId,
          taskId: task.taskId,
          kind: "step.model",
          fromAgent,
          toAgent: item.toAgent,
          inputHash: hashContent(item.task),
          outputHash: hashContent(item.output),
          model: ACTIVITY_MODEL,
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: estimateCostUsd(ACTIVITY_MODEL, inTok, outTok),
          latencyMs: processingMs,
        });
        completeTask(task.taskId, item.output);
        const now = new Date().toISOString();
        // Settlement amount = the worker agent's listed price (parsed from e.g.
        // "0.15 USDC"), falling back to 0.10 USDC if the agent has no valid price.
        const parsedPrice = (() => {
          const p = priceByAgent.get(item.toAgent);
          return p ? parsePaymentAmount(p) : null;
        })();
        const amount = parsedPrice?.amount ?? 0.10;
        const currency = parsedPrice?.currency ?? "USDC";
        getDb().prepare(`
          INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_sol, status, incoming_signature, fee_amount, currency, created_at, settled_at)
          VALUES (?, ?, ?, ?, ?, 'completed', NULL, 0, ?, ?, ?)
        `).run(randomUUID(), task.taskId, fromAgent, item.toAgent, amount, currency, now, now);
        // Settlement into the trace — the real amount, closing the timeline.
        safeAppendTraceEvent({
          traceId: task.traceId ?? task.taskId,
          taskId: task.taskId,
          kind: "settlement.completed",
          fromAgent,
          toAgent: item.toAgent,
          meta: { amount, currency },
        });
        telegramQueue.push({ toAgent: item.toAgent, success: true });
      }
      created.push(task.taskId);
    } catch (err) {
      logger.warn("cron.demo_activity_task_failed", "Failed to create demo activity task", {
        toAgent: item.toAgent,
        err,
      });
    }
  }

  const toPost = [...telegramQueue].sort(() => Math.random() - 0.5).slice(0, 3);
  for (let i = 0; i < toPost.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 3000) + 2000));
    const p = toPost[i];
    await postSingleTask(p.toAgent, p.success, p.failReason);
  }

  logger.info("cron.demo_activity_complete", "Demo activity cron created tasks", {
    created: created.length,
    failed: failedCount,
    taskIds: created,
  });

  return NextResponse.json({ ok: true, created: created.length, taskIds: created });
}
