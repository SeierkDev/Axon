import { createTask, startTask, completeTask, failTask } from "./tasks";
import { getAllAgents } from "./agents";

// Realistic task descriptions per capability
const TASK_POOL: Record<string, string[]> = {
  research: [
    "Research top DeFi protocols by TVL this week",
    "Summarize latest Ethereum upgrade impact on gas fees",
    "Compile report on AI agent adoption in crypto",
    "Analyze Solana ecosystem growth metrics for Q2",
    "Research institutional BTC holdings changes",
  ],
  "data-analysis": [
    "Aggregate DEX volume data across Solana and Ethereum",
    "Process on-chain wallet clustering for whale tracking",
    "Generate weekly DeFi liquidity flow report",
    "Analyze NFT floor price trends across collections",
    "Process Dune Analytics query for protocol revenue",
  ],
  "smart-contract-audit": [
    "Audit token vesting contract for reentrancy vulnerabilities",
    "Review new AMM contract for price manipulation risks",
    "Security check on multisig wallet implementation",
    "Audit bridge contract for cross-chain replay attacks",
    "Review staking contract logic and reward calculation",
  ],
  trading: [
    "Generate BTC/USDC trading signal for next 4 hours",
    "Analyze ETH ETF inflow impact on spot price",
    "Build momentum strategy for SOL based on RSI and volume",
    "Identify arbitrage opportunity between CEX and DEX prices",
    "Generate risk-adjusted entry point for ETH long position",
  ],
  crypto: [
    "Analyze on-chain whale wallet movements for BTC",
    "Track large USDC transfers on Solana in last 24h",
    "Monitor Binance order book depth for ETH",
    "Fetch real-time funding rates across perpetual markets",
    "Analyze token unlock schedule impact on price",
  ],
  defi: [
    "Identify highest yield farming opportunities on Solana",
    "Calculate impermanent loss for ETH/USDC LP position",
    "Optimize liquidity range for concentrated liquidity pool",
    "Analyze protocol revenue vs token emissions ratio",
    "Scout new DeFi protocols launching this month",
  ],
  coding: [
    "Write TypeScript SDK wrapper for Axon REST API",
    "Debug memory leak in agent task processing loop",
    "Implement rate limiting middleware for API routes",
    "Build CLI tool for registering agents from terminal",
    "Refactor payment verification to support batch transactions",
  ],
  analysis: [
    "Analyze market sentiment from on-chain data signals",
    "Correlate BTC price action with macro economic events",
    "Compare agent network growth to historical protocol adoption",
    "Evaluate protocol token value accrual mechanisms",
    "Benchmark Axon agent response times across capability types",
  ],
  writing: [
    "Write weekly DeFi market update newsletter",
    "Draft technical documentation for Axon SDK v2",
    "Create social media thread explaining agent delegation",
    "Write comparison article: Axon vs traditional APIs",
    "Draft grant proposal for open-source agent tooling",
  ],
  strategy: [
    "Build go-to-market strategy for an AI agent network",
    "Plan token launch sequence for new DeFi protocol",
    "Design agent coordination strategy for multi-step research",
    "Develop risk management framework for on-chain trading",
    "Create partnership strategy for agent network expansion",
  ],
  blockchain: [
    "Monitor Solana validator performance and stake distribution",
    "Track cross-chain bridge TVL and security metrics",
    "Analyze transaction throughput during peak network load",
    "Fetch and parse latest Solana program upgrade logs",
    "Monitor on-chain governance votes across major protocols",
  ],
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getTaskForAgent(capabilities: string[]): string {
  for (const cap of capabilities) {
    const pool = TASK_POOL[cap];
    if (pool) return pickRandom(pool);
  }
  return "Analyze latest network activity and generate summary report";
}

export interface SeedResult {
  tasksCreated: number;
  tasksCompleted: number;
  tasksFailed: number;
  agentPairs: string[];
}

export function runDailySeed(taskCount = 8): SeedResult {
  const agents = getAllAgents();
  if (agents.length < 2) return { tasksCreated: 0, tasksCompleted: 0, tasksFailed: 0, agentPairs: [] };

  const result: SeedResult = { tasksCreated: 0, tasksCompleted: 0, tasksFailed: 0, agentPairs: [] };

  for (let i = 0; i < taskCount; i++) {
    // Pick two different random agents
    const from = pickRandom(agents);
    let to = pickRandom(agents);
    while (to.agentId === from.agentId) to = pickRandom(agents);

    const taskDescription = getTaskForAgent(to.capabilities);

    try {
      const task = createTask({
        fromAgent: from.agentId,
        toAgent: to.agentId,
        task: taskDescription,
      });

      result.tasksCreated++;
      result.agentPairs.push(`${from.agentId} → ${to.agentId}`);

      // Start the task
      startTask(task.taskId, "seed");

      // 92% complete, 8% fail — realistic ratio for a maturing agent network
      const succeeds = Math.random() < 0.92;

      if (succeeds) {
        const output = `Task completed: ${taskDescription.slice(0, 60)}. Analysis ready.`;
        completeTask(task.taskId, output);
        result.tasksCompleted++;
      } else {
        const errors = ["timeout", "rate limit exceeded", "upstream data unavailable", "insufficient context"];
        failTask(task.taskId, pickRandom(errors));
        result.tasksFailed++;
      }
    } catch {
      // Skip if anything fails — seed should never crash the server
    }
  }

  return result;
}
