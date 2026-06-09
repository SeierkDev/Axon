import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonClient } from "../src/sdk";

function signChallenge(keypair: Keypair, challenge: string): string {
  const message = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(message, keypair.secretKey);
  return Buffer.from(signature).toString("base64");
}

function agentOutput(input: string): string {
  return [
    "Demo Echo Agent completed the task.",
    "",
    `Input: ${input}`,
    "",
    "What happened:",
    "1. Axon accepted the task.",
    "2. The demo agent claimed it from the queue.",
    "3. The SDK submitted this result back to Axon.",
  ].join("\n");
}

async function main() {
  const endpoint = process.env.AXON_DEMO_ENDPOINT ?? "http://localhost:3000";
  const taskText =
    process.argv.slice(2).join(" ").trim() ||
    "Explain Axon in one sentence for a developer.";

  const wallet = Keypair.generate();
  const agentKeys = Keypair.generate();
  const walletAddress = wallet.publicKey.toBase58();
  const agentId = `demo-echo-${Date.now()}`;
  const capability = `demo-${Date.now()}`;

  const setupClient = new AxonClient();
  setupClient.init({ endpoint });

  const authChallenge = await setupClient.createAuthChallenge(walletAddress);
  const authResult = await setupClient.verifyAuthChallenge({
    walletAddress,
    challenge: authChallenge.challenge,
    signature: signChallenge(wallet, authChallenge.challenge),
  });

  const axon = new AxonClient();
  axon.init({ endpoint, apiKey: authResult.apiKey });

  const agent = await axon.register({
    agentId,
    name: "Demo Echo Agent",
    capabilities: ["demo", "echo", "local-demo", capability],
    publicKey: Buffer.from(agentKeys.publicKey.toBytes()).toString("base64"),
    walletAddress,
  });

  axon.onTask(async (task) => ({
    success: true,
    output: agentOutput(task.task),
  }));

  const task = await axon.sendTask({
    from: walletAddress,
    to: agent.agentId,
    task: taskText,
    context: {
      demo: true,
      cleanup: "npm run cleanup:demo",
      runner: "scripts/demo-agent.ts",
    },
  });

  const result = await axon.processNextTask(agent.agentId);
  if (!result?.success) {
    throw new Error(result?.error ?? "Demo agent did not complete the task");
  }

  const completed = await axon.getTask(task.taskId);
  const receipt = await axon.getReceipt(task.taskId);

  console.log(`Axon demo agent completed a real task.

Endpoint:   ${endpoint}
Agent:      ${completed.toAgent}
Wallet:     ${walletAddress}
Task:       ${completed.taskId}
Status:     ${completed.status}
API key:    ${authResult.apiKey}

Result:
${completed.output}

Receipt:
${JSON.stringify(receipt.receipt, null, 2)}

Open ${endpoint}/dashboard and paste the API key above to inspect the agent, task, and receipt.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
