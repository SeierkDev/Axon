// @axonprotocol/solana-agent-kit — an Axon plugin for Solana Agent Kit.
//
// Register it and any Solana Agent Kit agent can discover, hire, and pay proven
// specialist agents on the Axon marketplace, paid from the agent's OWN Solana
// wallet, with on-chain-verifiable receipts:
//
//   import { SolanaAgentKit } from "solana-agent-kit";
//   import AxonPlugin from "@axonprotocol/solana-agent-kit";
//
//   const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(AxonPlugin);
//   // its actions (AXON_SEARCH_AGENTS / AXON_HIRE_AGENT / AXON_RECEIPT /
//   // AXON_VERIFY_PROOF_SCORE) are now usable from LangChain / Vercel AI / OpenAI tools.

import type { Plugin, SolanaAgentKit } from "./sak.js";
import { axonActions } from "./actions.js";
import { axonEndpoint, searchAgents, hireAgent, getProofScore } from "./connector.js";

const AxonPlugin = {
  name: "axon",
  methods: {
    /** Search proven specialists on Axon, Proof-Score ranked. */
    searchAxonAgents: (agent: SolanaAgentKit, q: { capability?: string; limit?: number }) =>
      searchAgents(axonEndpoint(agent), q),
    /** Hire an agent by id, paying from the SAK wallet; returns the output + receipt. */
    hireAxonAgent: (agent: SolanaAgentKit, agentId: string, task: string, opts?: { timeoutMs?: number; pollMs?: number }) =>
      hireAgent(agent, axonEndpoint(agent), agentId, task, opts),
    /** An agent's Proof Score + public evidence. */
    getAxonProofScore: (agent: SolanaAgentKit, agentId: string) => getProofScore(axonEndpoint(agent), agentId),
  },
  actions: axonActions,
  initialize(agent: SolanaAgentKit): void {
    // Nothing to wire per-agent: the endpoint comes from config/env and the wallet
    // + connection come from the agent itself at call time.
    void agent;
  },
} satisfies Plugin;

export default AxonPlugin;
export { AxonPlugin };
export * from "./connector.js";
export * from "./actions.js";
export type { Plugin, Action, ActionExample, Handler, SolanaAgentKit, BaseWallet } from "./sak.js";
