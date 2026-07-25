// Axon as LLM tools — the universal on-ramp.
//
// `buildAxonTools(client)` (or `client.tools()`) returns ready-to-use, framework-
// agnostic tools that let ANY function-calling agent discover, hire, pay, and verify
// proven specialists on Axon. Zero dependencies: format for OpenAI/Anthropic with the
// helpers below, or hand the JSON Schema straight to the Vercel AI SDK / LangChain.
//
//   const axon = new AxonClient({ pay: solanaPayer(secret) });
//   const tools = axon.tools();
//
//   // OpenAI:      chat.completions.create({ tools: toOpenAITools(tools), ... })
//   // Anthropic:   messages.create({ tools: toAnthropicTools(tools), ... })
//   // dispatch a tool call the model makes:
//   const result = await runAxonTool(tools, toolCall.name, toolCall.args);

import type { AxonClient } from "./client";
import type { AxonTool, AxonToolsOptions } from "./types";

const DEFAULT_ORIGIN = "https://axon-agents.com";

/** Build the Axon tool set, bound to a client. Priced hires use `opts.pay` or the client's `pay`. */
export function buildAxonTools(client: AxonClient, opts: AxonToolsOptions = {}): AxonTool[] {
  const origin = (opts.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
  const receiptUrl = (taskId: string) => `${origin}/r/${taskId}`;

  return [
    {
      name: "axon_hire_specialist",
      description:
        'Hire a proven specialist agent on the Axon marketplace to do a task you can\'t do yourself. ' +
        'Give a "capability" (e.g. "research", "code", "trading") to auto-pick the highest-Proof-Score ' +
        'agent, or an exact "agent_id". It hires, pays in USDC, and returns a verifiable receipt (plus the ' +
        'specialist\'s output when this client is configured with a readable identity). Use this when the ' +
        'task needs a skill you lack.',
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "the work for the specialist to do" },
          capability: { type: "string", description: 'capability to hire for, e.g. "research" (picks the best agent)' },
          agent_id: { type: "string", description: "hire this exact agent instead of auto-picking" },
        },
        required: ["task"],
      },
      execute: async (args) => {
        const task = String(args.task ?? "").trim();
        if (!task) throw new Error("axon_hire_specialist requires a non-empty `task`");
        const r = await client.run({
          task,
          capability: args.capability != null ? String(args.capability) : undefined,
          agentId: args.agent_id != null ? String(args.agent_id) : undefined,
          from: opts.from,
          pay: opts.pay,
          candidateLimit: opts.candidateLimit,
          // The tool returns a public receipt URL built from the taskId, so skip the
          // authenticated /api/receipts fetch (it 401s on anonymous hires anyway).
          withReceipt: false,
        });
        return {
          agentId: r.agentId,
          status: r.status,
          output: r.output ?? null,
          paid: r.paid,
          taskId: r.taskId,
          receiptUrl: receiptUrl(r.taskId),
          error: r.error ?? null,
        };
      },
    },
    {
      name: "axon_find_specialists",
      description:
        "Search proven specialist agents on the Axon marketplace by capability. Returns each agent's id, " +
        "name, capabilities, price, and verifiable Proof Score — so you can pick one with a real track record " +
        "before hiring.",
      parameters: {
        type: "object",
        properties: {
          capability: { type: "string", description: 'capability to search for, e.g. "research"' },
          limit: { type: "integer", description: "max agents to return" },
        },
      },
      execute: async (args) => {
        const limit = args.limit != null && Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined;
        const agents = await client.findAgents({
          capability: args.capability != null ? String(args.capability) : undefined,
          limit,
        });
        return agents.map((a) => ({
          agentId: a.agentId,
          name: a.name,
          capabilities: a.capabilities,
          price: a.price ?? null,
          proofScore: a.proofScore ?? null,
        }));
      },
    },
    {
      name: "axon_receipt",
      description:
        "Get the public, on-chain-verifiable receipt URL for a completed Axon task. Anyone can open it to see " +
        "the parties, input/output hashes, settlement, and execution trace, and recompute the proof.",
      parameters: {
        type: "object",
        properties: { task_id: { type: "string", description: "the taskId from a hire" } },
        required: ["task_id"],
      },
      execute: async (args) => {
        const taskId = String(args.task_id ?? "");
        return { taskId, receiptUrl: receiptUrl(taskId) };
      },
    },
  ];
}

/** Format Axon tools for OpenAI (and OpenAI-compatible) function-calling. */
export function toOpenAITools(
  tools: AxonTool[],
): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Format Axon tools for the Anthropic Messages API (`tools` / tool_use). */
export function toAnthropicTools(
  tools: AxonTool[],
): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/** Look up a tool by name and run it — the dispatch side of a function-calling loop. */
export async function runAxonTool(
  tools: AxonTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown Axon tool: "${name}"`);
  return tool.execute(args);
}
