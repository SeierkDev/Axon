#!/usr/bin/env node
// Run the SDK's live tests against a real server.
//
//   node scripts/sdk-e2e.mjs
//
// Boots the built app on a scratch database, registers an agent to experiment on, mints a key for
// its owner, runs packages/sdk/test/live.integration.test.ts against it, and tears the whole thing
// down again. Nothing touches production and nothing spends money: the payment tests use
// transactions that do not exist, so what they prove is the refusal and what it leaves behind.
//
// The one thing it needs from the outside is a chain to read the pool price from, because a token
// quote is a real number off a real pool. That read is free.

import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 3199);
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "sdk-e2e-agent";

const AXON_TOKEN = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9";

const dir = mkdtempSync(join(tmpdir(), "axon-sdk-e2e-"));
const dbPath = join(dir, "e2e.db");
let server;

const say = (s) => process.stdout.write(`${s}\n`);

function cleanup() {
  if (server && !server.killed) server.kill("SIGTERM");
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* it was temporary anyway */ }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const env = {
  ...process.env,
  DATABASE_PATH: dbPath,
  PORT: String(PORT),
  // Blanked deliberately. A local server loads .env.local, which holds the real bot token, and a
  // registration broadcasts: without this, running the tests posts to the live channel.
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHANNEL_ID: "",
  NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS: RECEIVER,
  AXON_SETTLEMENT_TOKEN_ADDRESS: AXON_TOKEN,
  AXON_TOKEN_ADDRESS: AXON_TOKEN,
  AXON_RPC_URL: process.env.AXON_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  CRON_SECRET: "sdk-e2e",
  // Pinned so the server and the key-minting below agree. It salts the API key hash, and Next reads
  // it from .env.local while a bare tsx call does not, so leaving it to chance mints a key the
  // server cannot recognise.
  SEED_SECRET: "sdk-e2e-secret",
};

async function waitForServer(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${URL}/api/agents`, { signal: AbortSignal.timeout(4_000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`the server did not come up on ${URL}`);
}

function run(cmd, extraEnv = {}) {
  return execSync(cmd, { cwd: ROOT, env: { ...env, ...extraEnv }, encoding: "utf8" });
}

async function main() {
  if (!existsSync(join(ROOT, ".next"))) {
    say("building the app first (no .next found)");
    run("npm run build");
  }

  say(`starting a server on ${URL} with a scratch database`);
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  await waitForServer();

  // A quote is refused when the live price sits far from the last one on record. A scratch database
  // has none, so the first quote sets the reference and everything after it is compared to that.
  say("minting an owner key and registering the agent under test");
  const key = run(
    `npx tsx -e 'import { createApiKey } from "@/lib/identity"; console.log(createApiKey("${OWNER}").apiKey);'`,
  ).trim().split("\n").pop();

  const registered = await fetch(`${URL}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      agentId: AGENT,
      name: "SDK E2E Agent",
      capabilities: ["research"],
      publicKey: "sdk-e2e",
      walletAddress: OWNER,
      price: "0.00025 ETH",
    }),
  });
  if (!registered.ok && registered.status !== 409) {
    throw new Error(`could not register the test agent: ${registered.status} ${await registered.text()}`);
  }

  say("running the live tests\n");
  execSync("npx vitest run test/live.integration.test.ts --reporter=verbose", {
    cwd: join(ROOT, "packages/sdk"),
    env: { ...process.env, AXON_E2E_URL: URL, AXON_E2E_KEY: key, AXON_E2E_OWNER: OWNER, AXON_E2E_AGENT: AGENT },
    stdio: "inherit",
  });
}

main().then(
  () => { cleanup(); process.exit(0); },
  (err) => { say(`\nFAILED: ${err.message}`); cleanup(); process.exit(1); },
);
