import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonClient } from "../src/sdk";

function signChallenge(keypair: Keypair, challenge: string): string {
  const message = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(message, keypair.secretKey);
  return Buffer.from(signature).toString("base64");
}

async function jsonFetch<T>(
  endpoint: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${endpoint}${path}`, init);
  const body = await res.text();
  const data = body ? JSON.parse(body) : {};

  if (!res.ok) {
    const message =
      typeof data?.error === "string" ? data.error : `${res.status} ${res.statusText}`;
    throw new Error(`${path}: ${message}`);
  }

  return data as T;
}

async function main() {
  const endpoint = process.env.AXON_SMOKE_ENDPOINT ?? "http://localhost:3000";
  const wallet = Keypair.generate();
  const walletAddress = wallet.publicKey.toBase58();
  const capability = `smoke-proof-${Date.now()}`;
  const agentId = `smoke-agent-${Date.now()}`;
  const agentKeys = Keypair.generate();

  const unauthenticated = new AxonClient();
  unauthenticated.init({ endpoint });

  const authChallenge = await unauthenticated.createAuthChallenge(walletAddress);
  const authResult = await unauthenticated.verifyAuthChallenge({
    walletAddress,
    challenge: authChallenge.challenge,
    signature: signChallenge(wallet, authChallenge.challenge),
  });

  const axon = new AxonClient();
  axon.init({ endpoint, apiKey: authResult.apiKey });

  const agent = await axon.register({
    agentId,
    name: "Smoke Test Agent",
    capabilities: [capability, "testing", "local-smoke"],
    publicKey: Buffer.from(agentKeys.publicKey.toBytes()).toString("base64"),
    walletAddress,
  });

  const discovered = await axon.findAgents({ capability, limit: 5 });
  if (!discovered.some((candidate) => candidate.agentId === agent.agentId)) {
    throw new Error("Registered agent was not discoverable by capability");
  }

  const task = await axon.sendTask({
    from: walletAddress,
    to: agent.agentId,
    task: "Return a short smoke-test confirmation.",
    context: {
      cleanup: "npm run cleanup:demo",
      source: "scripts/smoke-first-task.ts",
    },
  });

  axon.onTask(async (incoming) => ({
    success: true,
    output: `Smoke test handled ${incoming.taskId}`,
  }));

  const processed = await axon.processNextTask(agent.agentId);
  if (!processed?.success) {
    throw new Error(processed?.error ?? "processNextTask did not complete a task");
  }

  const completed = await axon.getTask(task.taskId);
  if (completed.status !== "completed" || !completed.output) {
    throw new Error(`Task ended in unexpected state: ${completed.status}`);
  }

  const receipt = await axon.getReceipt(task.taskId);
  if (!receipt.receipt) {
    throw new Error("Receipt endpoint returned an empty receipt");
  }

  const dashboard = await jsonFetch<{
    walletAddress: string;
    agents: Array<{ agentId: string }>;
  }>(endpoint, "/api/auth/me", {
    headers: { Authorization: `Bearer ${authResult.apiKey}` },
  });

  if (
    dashboard.walletAddress !== walletAddress ||
    !dashboard.agents.some((candidate) => candidate.agentId === agent.agentId)
  ) {
    throw new Error("Dashboard identity endpoint did not include the smoke agent");
  }

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    walletAddress,
    apiKeyPrefix: authResult.keyPrefix,
    agentId: agent.agentId,
    taskId: completed.taskId,
    taskStatus: completed.status,
    output: completed.output,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
