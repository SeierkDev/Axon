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
//
// With Anvil installed it also runs a local fork of Robinhood Chain, deploys the real Allowance
// contract on it, funds an allowance from a development wallet, and points the server at the fork, so
// the SDK pays for a hire from a real allowance. The fork's ETH is not real, and the model keys are
// blanked, so the paid task fails at once instead of spending anything: which also proves the refund
// comes back to the allowance by itself.

import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PORT = Number(process.env.PORT ?? 3199);
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT = "sdk-e2e-agent";

const AXON_TOKEN = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";
const RECEIVER = "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9";

// Anvil's standard development keys: the fork gives each of them test ETH.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ALLOWANCE_OWNER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const OPERATOR_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const ANVIL = [join(homedir(), ".foundry/bin/anvil")].find(existsSync);
const ANVIL_PORT = PORT + 1;
const FORK_RPC = `http://127.0.0.1:${ANVIL_PORT}`;

const dir = mkdtempSync(join(tmpdir(), "axon-sdk-e2e-"));
const dbPath = join(dir, "e2e.db");
let server;
let anvil;

const say = (s) => process.stdout.write(`${s}\n`);

function cleanup() {
  if (server && !server.killed) server.kill("SIGTERM");
  if (anvil && !anvil.killed) anvil.kill("SIGTERM");
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
  // Blanked so a paid task in these tests fails at once rather than calling a model and spending.
  // Next does not overwrite a variable that is already set, even to empty, with one from .env.local.
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  XAI_API_KEY: "",
};

/**
 * A fork of Robinhood Chain with the Allowance contract on it and an allowance funded, or null when
 * Anvil is not installed. Returns what the server and the tests need to know.
 */
async function startAllowanceChain() {
  if (!ANVIL) return null;
  const artifact = join(ROOT, "contracts/out/Allowance.sol/Allowance.json");
  if (!existsSync(artifact)) execSync("forge build", { cwd: join(ROOT, "contracts"), stdio: "ignore", env: { ...process.env, PATH: `${join(homedir(), ".foundry/bin")}:${process.env.PATH}` } });

  anvil = spawn(ANVIL, ["--fork-url", env.AXON_RPC_URL, "--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
  const pub = createPublicClient({ transport: http(FORK_RPC) });
  for (let i = 0; i < 120; i++) {
    try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }

  const { abi, bytecode } = JSON.parse(readFileSync(artifact, "utf8"));
  const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), transport: http(FORK_RPC) });
  const operator = privateKeyToAccount(OPERATOR_KEY).address;
  const hash = await deployer.deployContract({ abi, bytecode: bytecode.object, args: [RECEIVER, AXON_TOKEN, deployer.account.address, operator], chain: null });
  const address = (await pub.waitForTransactionReceipt({ hash })).contractAddress;

  // The owner funds an ETH allowance and sets the default limits, from their own wallet.
  const owner = createWalletClient({ account: privateKeyToAccount(ALLOWANCE_OWNER_KEY), transport: http(FORK_RPC) });
  const block = await pub.getBlock();
  for (const [functionName, args, value] of [
    ["deposit", [], parseEther("0.01")],
    ["setRules", ["0x0000000000000000000000000000000000000000", parseEther("0.0005"), parseEther("0.005"), block.timestamp + 30n * 86_400n]],
  ]) {
    const tx = await owner.writeContract({ address, abi, functionName, args, value, chain: null });
    await pub.waitForTransactionReceipt({ hash: tx });
  }
  return { address, owner: owner.account.address.toLowerCase() };
}

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

  const chain = await startAllowanceChain();
  if (chain) {
    say(`allowance contract on a local fork at ${chain.address}`);
    Object.assign(env, {
      AXON_RPC_URL: FORK_RPC,
      AXON_ALLOWANCE_ADDRESS: chain.address,
      AXON_ALLOWANCE_OPERATOR_KEY: OPERATOR_KEY,
    });
  } else {
    say("Anvil not found: the allowance tests will be skipped");
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

  const allowanceEnv = {};
  if (chain) {
    allowanceEnv.AXON_E2E_ALLOWANCE_OWNER = chain.owner;
    allowanceEnv.AXON_E2E_ALLOWANCE_KEY = run(
      `npx tsx -e 'import { createApiKey } from "@/lib/identity"; console.log(createApiKey("${chain.owner}").apiKey);'`,
    ).trim().split("\n").pop();
  }

  say("running the live tests\n");
  execSync("npx vitest run test/live.integration.test.ts --reporter=verbose", {
    cwd: join(ROOT, "packages/sdk"),
    env: { ...process.env, AXON_E2E_URL: URL, AXON_E2E_KEY: key, AXON_E2E_OWNER: OWNER, AXON_E2E_AGENT: AGENT, ...allowanceEnv },
    stdio: "inherit",
  });
}

main().then(
  () => { cleanup(); process.exit(0); },
  (err) => { say(`\nFAILED: ${err.message}`); cleanup(); process.exit(1); },
);
