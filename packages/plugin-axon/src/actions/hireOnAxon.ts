import type { Action, ActionResult, IAgentRuntime, Memory, State, HandlerCallback } from "@elizaos/core";
import { AxonClient, isPaymentRequired, isHired, type AxonAgent, type HirePaymentRequired } from "../client.js";

// Configuration for the Axon actions. `payUsdc` is the bridge to the host
// project's Solana wallet: when a paid agent is hired, the plugin calls it to
// settle the USDC and hand back the transaction signature. Leave it unset and
// paid hires return the payment instructions instead of paying automatically —
// the free lane still works with no wallet at all.
export interface AxonConfig {
  baseUrl?: string;
  payUsdc?: (req: HirePaymentRequired) => Promise<string>;
}

// Pick the most trustworthy capable agent: highest portable Proof Score wins,
// reputation breaks ties. This is the whole point of hiring THROUGH Axon rather
// than blindly — you route to proven work, verifiably.
function pickBest(agents: AxonAgent[] | undefined): AxonAgent | null {
  if (!agents || !agents.length) return null;
  return [...agents].sort(
    (a, b) => (b.proofScore ?? 0) - (a.proofScore ?? 0) || (b.reputation ?? 0) - (a.reputation ?? 0),
  )[0];
}

function taskFrom(message: Memory): string {
  const c = message?.content as { text?: string } | undefined;
  return (c?.text ?? "").trim();
}

export function createHireOnAxonAction(config: AxonConfig = {}): Action {
  return {
    name: "HIRE_ON_AXON",
    similes: ["HIRE_AGENT", "DELEGATE_TASK", "OUTSOURCE_TASK", "FIND_SPECIALIST", "HIRE_SPECIALIST"],
    description:
      "Hire a specialist agent on the Axon marketplace to do a task this agent can't do itself, pay from the configured wallet, and return the result with a public on-chain-verifiable receipt. Routes to the highest Proof Score agent for the capability.",

    // Fire when the user is asking to delegate/outsource/hire out a piece of work.
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
      const t = taskFrom(message).toLowerCase();
      if (t.length < 8) return false;
      return /\b(hire|delegate|outsource|find (me )?(an? )?(agent|specialist|expert)|get someone to|have someone|pay an agent)\b/.test(t);
    },

    handler: async (
      runtime: IAgentRuntime,
      message: Memory,
      _state?: State,
      _options?: Record<string, unknown>,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const say = async (text: string, extra: Record<string, unknown> = {}) => {
        if (callback) await callback({ text, source: "axon", ...extra });
      };

      // getSetting can return non-strings — only accept a string base URL.
      const setting = runtime.getSetting("AXON_BASE_URL");
      const baseUrl = config.baseUrl ?? (typeof setting === "string" ? setting : undefined);
      const client = new AxonClient(baseUrl);
      const origin = (baseUrl ?? "https://axon-agents.com").replace(/\/+$/, "");
      const task = taskFrom(message);
      if (!task) {
        await say("I need a description of the work to hire for.");
        return { success: false, text: "No task description provided." };
      }

      try {
        // 1) discover
        const search = await client.searchAgents({ query: task, limit: 5 });
        const agent = pickBest(search.agents);
        if (!agent) {
          await say("No Axon agent matched that work right now.");
          return { success: false, text: "No matching Axon agent." };
        }

        // 2) hire (free lane runs immediately)
        let hire = await client.hireAgent({ agentId: agent.agentId, task });

        // 3) paid agent → settle USDC with the configured wallet, then retry
        if (isPaymentRequired(hire)) {
          if (!config.payUsdc) {
            await say(
              `${agent.name} costs ${hire.price ?? "a fee"}. ${hire.instructions}`,
              { paymentRequired: true, payTo: hire.payTo, amount: hire.amount, currency: hire.currency, agentId: agent.agentId },
            );
            return { success: false, text: `Payment required (${hire.price ?? "fee"}); no wallet configured.`, data: { paymentRequired: true, payTo: hire.payTo, amount: hire.amount } };
          }
          const paymentSignature = await config.payUsdc(hire);
          hire = await client.hireAgent({ agentId: agent.agentId, task, paymentSignature });
          if (isPaymentRequired(hire)) {
            await say("Payment wasn't accepted for that hire.");
            return { success: false, text: "Payment was not accepted." };
          }
        }

        // A replay (someone already used this payment) has a public receipt but no claim token.
        if (!isHired(hire)) {
          await say(`Hired ${agent.name} — the task already exists. Verify it here: ${hire.receiptUrl}`, { receiptUrl: hire.receiptUrl });
          return { success: true, text: "Task already exists on Axon.", data: { receiptUrl: hire.receiptUrl } };
        }

        // 4) wait for the output (private to us, via the claim token)
        const result = await client.waitForResult({ taskId: hire.taskId, claimToken: hire.claimToken });
        const receipt = `${origin}/r/${hire.taskId}`;

        if (result.status !== "completed") {
          await say(`Hired ${agent.name} (task ${hire.taskId}), still ${result.status}. Track + verify: ${receipt}`, { taskId: hire.taskId, status: result.status, receiptUrl: receipt });
          return { success: true, text: `Hired ${agent.name}; task ${result.status}.`, data: { taskId: hire.taskId, status: result.status, receiptUrl: receipt } };
        }

        const output = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);
        await say(
          `Hired ${agent.name} on Axon. Result:\n\n${output}\n\nVerify this was really done, on-chain: ${receipt}`,
          { taskId: hire.taskId, agentId: agent.agentId, receiptUrl: receipt, proofScore: agent.proofScore },
        );
        return { success: true, text: `Hired ${agent.name} on Axon; task completed.`, data: { taskId: hire.taskId, agentId: agent.agentId, receiptUrl: receipt } };
      } catch (e) {
        await say(`Axon hire failed: ${e instanceof Error ? e.message : String(e)}`);
        return { success: false, text: "Axon hire failed.", error: e instanceof Error ? e : String(e) };
      }
    },

    examples: [
      [
        { name: "{{user1}}", content: { text: "Can you hire someone to research the top 5 Solana RPC providers and their pricing?" } },
        { name: "{{agent}}", content: { text: "Hiring a research specialist on Axon and settling the fee from my wallet — I'll bring back the result with an on-chain receipt.", action: "HIRE_ON_AXON" } },
      ],
      [
        { name: "{{user1}}", content: { text: "Delegate the logo cleanup to a design agent." } },
        { name: "{{agent}}", content: { text: "Finding the highest-Proof-Score design agent on Axon for that and hiring it.", action: "HIRE_ON_AXON" } },
      ],
    ],
  };
}
