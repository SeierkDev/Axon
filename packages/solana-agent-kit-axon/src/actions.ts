import { z } from "zod";
import type { Action, Handler, SolanaAgentKit } from "./sak.js";
import { axonEndpoint, searchAgents, hireAgent, getProofScore, receiptUrl, parseUsdcPrice, type AxonAgent } from "./connector.js";

// Wrap a handler so a thrown error (network blip, on-chain payment failure, a 402)
// comes back to the model as a clean { status: "error", message } instead of
// crashing the tool call.
const safe = (fn: Handler): Handler => async (agent, input) => {
  try {
    return await fn(agent, input);
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
};

export const searchAxonAgentsAction: Action = {
  name: "AXON_SEARCH_AGENTS",
  similes: ["find axon agents", "search the axon marketplace", "list specialists for a capability", "discover proven agents"],
  description:
    "Search the Axon marketplace for proven specialist agents by capability, ranked by verifiable Proof Score. Use this to find an agent to hire before calling AXON_HIRE_AGENT.",
  examples: [[
    {
      input: { capability: "research", limit: 3 },
      output: { status: "success", agents: [{ agentId: "report-agent", name: "Report Agent", price: "0.15 USDC", proofScore: 951 }] },
      explanation: "Find the top research specialists on Axon.",
    },
  ]],
  schema: z.object({
    capability: z.string().optional().describe("Capability to search for, e.g. 'research', 'writing', 'analysis'"),
    limit: z.number().int().positive().max(50).optional().describe("Max agents to return (default 10)"),
  }),
  handler: safe(async (agent: SolanaAgentKit, input) => {
    const base = axonEndpoint(agent);
    const agents = await searchAgents(base, { capability: input.capability, limit: input.limit });
    return {
      status: "success",
      count: agents.length,
      agents: agents.map((a: AxonAgent) => ({
        agentId: a.agentId,
        name: a.name,
        capabilities: a.capabilities,
        price: a.price ?? "free",
        proofScore: a.proofScore ?? null,
        tier: a.proofScoreTier ?? null,
      })),
    };
  }),
};

export const hireAxonAgentAction: Action = {
  name: "AXON_HIRE_AGENT",
  similes: ["hire an axon agent", "delegate a task to a specialist", "pay an agent to do a task", "outsource work on axon"],
  description:
    "Hire a proven specialist on the Axon marketplace to do a task. Give an exact 'agentId', or a 'capability' to auto-pick the highest-Proof-Score agent for it. Priced agents are paid in USDC from THIS agent's own Solana wallet (no Axon account needed); the result and an on-chain-verifiable receipt come back. Use when a task needs a skill you lack.",
  examples: [[
    {
      input: { capability: "research", task: "Summarize the top 5 Solana L2s by TVL" },
      output: { status: "success", agentId: "report-agent", paid: true, costUsdc: 0.15, output: "…", receiptUrl: "https://axon-agents.com/r/…" },
      explanation: "Auto-pick and hire the best research specialist, paying from the agent's wallet.",
    },
  ]],
  // NOTE: a plain ZodObject, NOT .refine(...). SAK's createOpenAITools /
  // createLangchainTools throw on a ZodEffects ("must be a ZodObject") and abort
  // ALL tool generation — so the one-of rule is enforced in the handler instead.
  schema: z.object({
    task: z.string().min(1).describe("The work for the specialist to do"),
    agentId: z.string().optional().describe("Hire this exact agent"),
    capability: z.string().optional().describe("…or auto-pick the highest-Proof-Score agent for this capability"),
    maxPrice: z.string().optional().describe('Spend cap for this hire, e.g. "0.20 USDC" — refuses to pay above it'),
  }),
  handler: safe(async (agent: SolanaAgentKit, input) => {
    const base = axonEndpoint(agent);
    // Enforce the "agentId or capability" rule in the handler, not just the schema:
    // some framework converters (zod → JSON Schema) drop .refine(), and hiring a
    // top-overall agent for an unspecified capability would spend money unintentionally.
    if (!input.agentId && !input.capability) {
      return { status: "error", message: "Provide an agentId or a capability to hire." };
    }
    let maxPriceUsdc: number | undefined;
    if (input.maxPrice) {
      const p = parseUsdcPrice(input.maxPrice);
      if (p == null) return { status: "error", message: 'maxPrice must be a USDC amount like "0.20 USDC"' };
      maxPriceUsdc = p;
    }

    let agentId: string | undefined = input.agentId;
    let picked: AxonAgent | undefined;
    if (!agentId) {
      let candidates = await searchAgents(base, { capability: input.capability, limit: 10 });
      if (maxPriceUsdc != null) {
        // only agents payable in USDC within the cap (free = 0; non-USDC excluded)
        candidates = candidates.filter((c) => {
          const p = parseUsdcPrice(c.price);
          return p != null && p <= maxPriceUsdc!;
        });
      }
      picked = candidates[0]; // already Proof-Score ranked
      if (!picked) {
        return { status: "error", message: `No affordable Axon agent found for capability "${input.capability}"${maxPriceUsdc != null ? ` under ${maxPriceUsdc} USDC` : ""}` };
      }
      agentId = picked.agentId;
    }

    const r = await hireAgent(agent, base, agentId, input.task, { maxPriceUsdc });
    if (r.status === "failed") {
      return { status: "error", agentId, taskId: r.taskId, message: r.error ?? "task failed", receiptUrl: r.receiptUrl };
    }
    if (r.status !== "completed") {
      return { status: "pending", agentId, taskId: r.taskId, taskStatus: r.status, paid: r.paid, receiptUrl: r.receiptUrl, message: "Task did not finish before the timeout — poll the receipt/taskId later." };
    }
    return {
      status: "success",
      agentId,
      name: picked?.name,
      taskId: r.taskId,
      taskStatus: r.status,
      paid: r.paid,
      costUsdc: r.costUsdc,
      output: r.output ?? null,
      receiptUrl: r.receiptUrl,
    };
  }),
};

export const axonReceiptAction: Action = {
  name: "AXON_RECEIPT",
  similes: ["get the axon receipt", "show the verifiable receipt for a task", "proof of a hire"],
  description:
    "Get the public, on-chain-verifiable receipt URL for a hired Axon task. Anyone can open it to see the parties, input/output hashes, settlement, and execution trace, and recompute the proof.",
  examples: [[
    {
      input: { taskId: "2eddfd36-…" },
      output: { status: "success", taskId: "2eddfd36-…", receiptUrl: "https://axon-agents.com/r/2eddfd36-…" },
      explanation: "Turn a taskId into its verifiable receipt link.",
    },
  ]],
  schema: z.object({ taskId: z.string().min(1).describe("The taskId returned by AXON_HIRE_AGENT") }),
  handler: safe(async (agent: SolanaAgentKit, input) => {
    const base = axonEndpoint(agent);
    return { status: "success", taskId: input.taskId, receiptUrl: receiptUrl(base, input.taskId) };
  }),
};

export const verifyAxonProofScoreAction: Action = {
  name: "AXON_VERIFY_PROOF_SCORE",
  similes: ["check an agent's proof score", "verify axon reputation", "how proven is this agent"],
  description:
    "Fetch an Axon agent's Proof Score and the public evidence behind it — reputation computed from its settled, on-chain receipts. Use to vet an agent before hiring.",
  examples: [[
    {
      input: { agentId: "report-agent" },
      output: { status: "success", agentId: "report-agent", proofScore: 951 },
      explanation: "Check how proven an agent is before hiring it.",
    },
  ]],
  schema: z.object({ agentId: z.string().min(1).describe("The agent to check") }),
  handler: safe(async (agent: SolanaAgentKit, input) => {
    const base = axonEndpoint(agent);
    const score = (await getProofScore(base, input.agentId)) as { score?: number; tier?: string };
    // The /proof-score endpoint names the value `score`; expose it as `proofScore`
    // so this action matches AXON_SEARCH_AGENTS. The full evidence object is kept.
    return { ...score, proofScore: score.score ?? null, tier: score.tier ?? null, status: "success", agentId: input.agentId };
  }),
};

export const axonActions: Action[] = [
  searchAxonAgentsAction,
  hireAxonAgentAction,
  axonReceiptAction,
  verifyAxonProofScoreAction,
];
