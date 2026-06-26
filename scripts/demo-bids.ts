// Demo helper for the bidding showcase: makes a few registered agents submit
// competing bids on your most recent open task — so you can record in one take.
//
//   1. Post a task in the UI (/open-tasks) with "Post as" = your wallet/agent.
//   2. Run:  npm run demo:bids -- <yourWalletOrAgentId>
//   3. Watch the bids roll into the panel.
//
// Endpoint defaults to http://localhost:3000 (override with AXON_DEMO_ENDPOINT,
// e.g. your Railway URL). Bidder identities are cached in
// scripts/.demo-bidders.json so re-runs reuse the same named agents.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AxonClient } from "../src/sdk";

const ENDPOINT = process.env.AXON_DEMO_ENDPOINT ?? "http://localhost:3000";
const CACHE = join(process.cwd(), "scripts", ".demo-bidders.json");

// The personas that will bid — varied price / ETA / pitch so the competition
// reads well on camera. All prices are <= 0.10 USDC so they pass a 0.10 budget.
const BIDDERS = [
  { agentId: "scholar-synth", name: "Scholar Synth", price: "0.04 USDC", etaSeconds: 90, message: "Concise protocol summary — fast turnaround." },
  { agentId: "deep-dive-ai", name: "Deep Dive AI", price: "0.08 USDC", etaSeconds: 300, message: "Thorough analysis with cited sources." },
  { agentId: "quick-quill", name: "Quick Quill", price: "0.06 USDC", etaSeconds: 150, message: "Accurate and ready to start now." },
];

type Json = Record<string, unknown>;

function signChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(nacl.sign.detached(new TextEncoder().encode(challenge), keypair.secretKey)).toString("base64");
}

async function request<T = Json>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${ENDPOINT}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

function authHeaders(apiKey?: string): Record<string, string> {
  return { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

async function login(keypair: Keypair): Promise<string> {
  const walletAddress = keypair.publicKey.toBase58();
  const client = new AxonClient();
  client.init({ endpoint: ENDPOINT });
  const { challenge } = await client.createAuthChallenge(walletAddress);
  const { apiKey } = await client.verifyAuthChallenge({ walletAddress, challenge, signature: signChallenge(keypair, challenge) });
  return apiKey;
}

// Stable bidder wallets across runs so the agent names stay clean and reusable.
function loadOrCreateWallets(): Keypair[] {
  if (existsSync(CACHE)) {
    const saved = JSON.parse(readFileSync(CACHE, "utf8")) as { secretKeys: string[] };
    if (saved.secretKeys?.length === BIDDERS.length) {
      return saved.secretKeys.map((sk) => Keypair.fromSecretKey(Buffer.from(sk, "base64")));
    }
  }
  const wallets = BIDDERS.map(() => Keypair.generate());
  writeFileSync(CACHE, JSON.stringify({ secretKeys: wallets.map((w) => Buffer.from(w.secretKey).toString("base64")) }, null, 2));
  return wallets;
}

async function ensureAgent(apiKey: string, persona: typeof BIDDERS[number], wallet: Keypair): Promise<void> {
  const res = await request("/api/agents", {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      agentId: persona.agentId,
      name: persona.name,
      capabilities: ["research", "summarization"],
      publicKey: Buffer.from(wallet.publicKey.toBytes()).toString("base64"),
      walletAddress: wallet.publicKey.toBase58(),
    }),
  });
  if (res.status === 201) return; // freshly registered
  // Already registered on a prior run — fine as long as it's ours.
  const existing = await request<{ walletAddress?: string }>(`/api/agents/${encodeURIComponent(persona.agentId)}`);
  if (existing.status === 200 && existing.body.walletAddress === wallet.publicKey.toBase58()) return;
  throw new Error(`could not register '${persona.agentId}' (HTTP ${res.status}). If the name is taken by another agent, delete ${CACHE} and edit the names in this script.`);
}

async function main() {
  const poster = process.argv.slice(2)[0] ?? process.env.AXON_DEMO_POSTER;
  if (!poster) {
    console.error("Usage: npm run demo:bids -- <yourWalletOrAgentId>   (the same 'Post as' value you used in the UI)");
    process.exit(1);
  }

  // Find the open task you just posted (most recent open one for this poster).
  const found = await request<{ openTasks: { openTaskId: string; task: string; maxBudget?: string }[] }>(
    `/api/open-tasks?from=${encodeURIComponent(poster)}&status=open`
  );
  const openTask = found.body.openTasks?.[0];
  if (!openTask) {
    console.error(`No open task found for '${poster}' at ${ENDPOINT}.`);
    console.error("Post a task in the UI first (Request quotes), then re-run this.");
    process.exit(1);
  }
  console.log(`Bidding on: "${openTask.task}"  (${openTask.openTaskId})`);

  const wallets = loadOrCreateWallets();
  for (let i = 0; i < BIDDERS.length; i++) {
    const persona = BIDDERS[i];
    const wallet = wallets[i];
    try {
      const apiKey = await login(wallet);
      await ensureAgent(apiKey, persona, wallet);
      const res = await request<{ error?: string }>(`/api/open-tasks/${openTask.openTaskId}/bids`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ agentId: persona.agentId, price: persona.price, etaSeconds: persona.etaSeconds, message: persona.message }),
      });
      if (res.status === 201) {
        console.log(`  ✓ ${persona.name} bid ${persona.price} (~${persona.etaSeconds}s)`);
      } else {
        console.log(`  ✗ ${persona.name}: ${res.body.error ?? `HTTP ${res.status}`}`);
      }
    } catch (err) {
      console.log(`  ✗ ${persona.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log("Done — switch back to the browser; the bids panel polls every 2.5s.");
}

main().catch((err) => {
  console.error("demo:bids failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
