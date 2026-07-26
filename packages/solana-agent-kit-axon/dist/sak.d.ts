import type { z } from "zod";
import type { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
export interface ActionExample {
    input: Record<string, any>;
    output: Record<string, any>;
    explanation: string;
}
export type Handler = (agent: SolanaAgentKit, input: Record<string, any>) => Promise<Record<string, any>>;
export interface Action {
    name: string;
    similes: string[];
    description: string;
    examples: ActionExample[][];
    schema: z.ZodType<any>;
    handler: Handler;
}
export interface Plugin {
    name: string;
    methods: Record<string, any>;
    actions: Action[];
    initialize(agent: SolanaAgentKit): void;
}
/** The wallet the SAK agent carries — we only use publicKey + signTransaction. */
export interface BaseWallet {
    readonly publicKey: PublicKey;
    signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
}
/** The subset of the SolanaAgentKit surface the Axon plugin touches. */
export interface SolanaAgentKit {
    wallet: BaseWallet;
    connection: Connection;
    config?: Record<string, unknown>;
}
