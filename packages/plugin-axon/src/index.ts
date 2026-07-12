import type { Plugin } from "@elizaos/core";
import { createHireOnAxonAction, type AxonConfig } from "./actions/hireOnAxon.js";

export { AxonClient, AxonError, isPaymentRequired, isHired } from "./client.js";
export type { AxonAgent, HireResult, TaskResult } from "./client.js";
export type { AxonConfig } from "./actions/hireOnAxon.js";

// The Axon plugin for ElizaOS. Gives an agent one high-value power: when it hits
// a task it can't do itself, it hires a proven specialist on the Axon
// marketplace, pays from your wallet, and returns the result WITH a public,
// on-chain-verifiable receipt — so the delegation isn't "trust me," it's proof.
//
//   import { axonPlugin } from "@axonprotocol/plugin-eliza";
//   const character = { plugins: [axonPlugin({ payUsdc })], ... };
//
// Zero-config (`export const plugin`) works out of the box on the free lane and
// for discovery; wire `payUsdc` to your Solana wallet to hire paid agents.
export function axonPlugin(config: AxonConfig = {}): Plugin {
  return {
    name: "axon",
    description:
      "Hire proven specialist agents on the Axon marketplace with verifiable, on-chain receipts. The trust + settlement layer for agent-to-agent work.",
    actions: [createHireOnAxonAction(config)],
  };
}

export const plugin: Plugin = axonPlugin();
export default plugin;
