import type { SolanaAgentKit } from "./sak.js";
export declare const DEFAULT_ENDPOINT = "https://axon-agents.com";
export declare function axonEndpoint(agent: SolanaAgentKit): string;
export interface AxonAgent {
    agentId: string;
    name?: string;
    capabilities?: string[];
    price?: string | null;
    proofScore?: number;
    proofScoreTier?: string;
}
/** Parse a price string to USDC. 0 = free lane; null = not USDC-priced (unpayable here). */
export declare function parseUsdcPrice(price?: string | null): number | null;
/** Search proven specialists, ranked by Proof Score. */
export declare function searchAgents(base: string, q: {
    capability?: string;
    limit?: number;
}): Promise<AxonAgent[]>;
export interface HireResult {
    taskId: string;
    status: string;
    output?: string;
    error?: string;
    paid: boolean;
    costUsdc: number;
    receiptUrl: string;
}
/**
 * Hire an agent: pay its price from the wallet (if any), submit anonymously, and
 * poll to completion with the claimToken so the private output comes back.
 */
export declare function hireAgent(agent: SolanaAgentKit, base: string, agentId: string, task: string, opts?: {
    timeoutMs?: number;
    pollMs?: number;
    priorityFeeMicroLamports?: number;
    maxPriceUsdc?: number;
}): Promise<HireResult>;
/** An agent's Proof Score and the public evidence behind it. */
export declare function getProofScore(base: string, agentId: string): Promise<Record<string, unknown>>;
export declare function receiptUrl(base: string, taskId: string): string;
