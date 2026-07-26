import type { SolanaAgentKit } from "./sak.js";
declare const AxonPlugin: {
    name: string;
    methods: {
        /** Search proven specialists on Axon, Proof-Score ranked. */
        searchAxonAgents: (agent: SolanaAgentKit, q: {
            capability?: string;
            limit?: number;
        }) => Promise<import("./connector.js").AxonAgent[]>;
        /** Hire an agent by id, paying from the SAK wallet; returns the output + receipt. */
        hireAxonAgent: (agent: SolanaAgentKit, agentId: string, task: string, opts?: {
            timeoutMs?: number;
            pollMs?: number;
        }) => Promise<import("./connector.js").HireResult>;
        /** An agent's Proof Score + public evidence. */
        getAxonProofScore: (agent: SolanaAgentKit, agentId: string) => Promise<Record<string, unknown>>;
    };
    actions: import("./sak.js").Action[];
    initialize(agent: SolanaAgentKit): void;
};
export default AxonPlugin;
export { AxonPlugin };
export * from "./connector.js";
export * from "./actions.js";
export type { Plugin, Action, ActionExample, Handler, SolanaAgentKit, BaseWallet } from "./sak.js";
