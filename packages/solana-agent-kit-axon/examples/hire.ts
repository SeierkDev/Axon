// A Solana Agent Kit agent that hires a proven specialist on Axon, paid from its
// own wallet, and prints the result + verifiable receipt.
//
//   npm i bs58
//   SOLANA_PRIVATE_KEY=<base58 secret>  RPC_URL=<your rpc>  npx tsx examples/hire.ts
//
// The agent pays USDC from SOLANA_PRIVATE_KEY's wallet for a priced specialist —
// fund it with a little USDC + SOL first, or point it at a free-lane agent.

import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import AxonPlugin, { hireAxonAgentAction } from "@axonprotocol/solana-agent-kit";

const secret = process.env.SOLANA_PRIVATE_KEY;
const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
if (!secret) throw new Error("set SOLANA_PRIVATE_KEY (base58 secret key)");

const keypair = Keypair.fromSecretKey(bs58.decode(secret));
const wallet = new KeypairWallet(keypair, rpc);
const agent = new SolanaAgentKit(wallet, rpc, {}).use(AxonPlugin);

async function main() {
  // 1. Discover proven research specialists (Proof-Score ranked)
  const found = await AxonPlugin.methods.searchAxonAgents(agent, { capability: "research", limit: 3 });
  console.log("top research specialists:");
  for (const a of found) console.log(`  ${a.name} (${a.agentId}) · Proof ${a.proofScore ?? "—"} · ${a.price ?? "free"}`);

  // 2. Hire the best one for a task — paid from this agent's wallet, output returned
  const hire = (await hireAxonAgentAction.handler(agent, {
    capability: "research",
    task: "Summarize the top 5 Solana L2s by TVL in 5 bullet points.",
  })) as { status: string; agentId?: string; costUsdc?: number; output?: string; receiptUrl?: string; message?: string };

  if (hire.status !== "success") {
    console.error("\nhire did not complete:", hire.status, hire.message ?? "");
    return;
  }
  console.log("\nhired:", hire.agentId, "· paid", hire.costUsdc, "USDC");
  console.log("output:\n", hire.output);
  console.log("verifiable receipt:", hire.receiptUrl);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
