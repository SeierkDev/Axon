#!/usr/bin/env node
// Build something with the SDK, the way somebody reading the README would.
//
//   node scripts/sdk-developer-check.mjs
//
// The install check proved the package loads. This proves it works: a clean project, the installed
// tarball, and two programs written straight out of the README. One runs an agent that answers work
// and earns. The other finds it, hires it, pays it, and reads the receipt.
//
// The paid hire really settles. The chain check runs in its mock lane, which the server has for
// exactly this, so the whole path is exercised — the 402, the payment header, verification,
// escrow, the worker, settlement and the receipt — without spending anything.
//
// Nothing here touches production and nothing is published.

import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 3197);
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = new globalThis.URL("..", import.meta.url).pathname;
const SDK = join(ROOT, "packages/sdk");
const OWNER = "0x1111111111111111111111111111111111111111";
const BUYER_WALLET = "0x2222222222222222222222222222222222222222";
const RECEIVER = "0x419fCbc1c4A7f85BB517f3C12D13068Db0D49cB9";
const AXON_TOKEN = "0xB5E40b5F16996E9D76ec2B16E7A4Ead3c06a9Fa2";

const work = mkdtempSync(join(tmpdir(), "axon-dev-"));
const app = join(work, "my-agent-project");
let server, worker;
let failures = 0;

const say = (s) => process.stdout.write(`${s}\n`);
const pass = (l, d = "") => say(`  PASS  ${l}${d ? "  " + d : ""}`);
const fail = (l, d) => { say(`  FAIL  ${l}  ${d}`); failures++; };

function cleanup() {
  for (const p of [worker, server]) if (p && !p.killed) p.kill("SIGTERM");
  try { rmSync(work, { recursive: true, force: true }); } catch { /* temporary */ }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const env = {
  ...process.env,
  DATABASE_PATH: join(work, "dev.db"),
  PORT: String(PORT),
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_CHANNEL_ID: "",
  NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS: RECEIVER,
  AXON_SETTLEMENT_TOKEN_ADDRESS: AXON_TOKEN,
  AXON_TOKEN_ADDRESS: AXON_TOKEN,
  AXON_RPC_URL: process.env.AXON_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  CRON_SECRET: "sdk-dev",
  SEED_SECRET: "sdk-dev-secret",
  // The server's own test lane for payments. Everything upstream of the chain runs for real.
  AXON_PAYMENT_VERIFIER: "mock",
};

const sh = (cmd, cwd = ROOT) =>
  execSync(cmd, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function waitFor(fn, what, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await fn()) return true; } catch { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  say("\n── a developer starts a project ─────────────────────────");
  sh("npm run build", SDK);
  const packed = sh(`npm pack --pack-destination ${work}`, SDK).trim().split("\n").pop();
  execSync(`mkdir -p ${app}`);
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "my-agent-project", private: true, type: "module", version: "1.0.0" }, null, 2));
  sh(`npm install --no-audit --no-fund ${join(work, packed)}`, app);
  pass("npm install @axonprotocol/sdk");

  if (!existsSync(join(ROOT, ".next"))) sh("npm run build");
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: ROOT, env, stdio: "ignore" });
  await waitFor(async () => (await fetch(`${URL}/api/agents`)).ok, "the server");
  const ownerKey = sh(`npx tsx -e 'import { createApiKey } from "@/lib/identity"; console.log(createApiKey("${OWNER}").apiKey);'`).trim().split("\n").pop();
  const buyerKey = sh(`npx tsx -e 'import { createApiKey } from "@/lib/identity"; console.log(createApiKey("${BUYER_WALLET}").apiKey);'`).trim().split("\n").pop();
  pass("an Axon to talk to", URL);

  // ── the agent, written from the README's runtime section ──────────────────
  writeFileSync(join(app, "worker.mjs"), `
import { AxonClient, defineAgent } from "@axonprotocol/sdk";

const axon = new AxonClient({ endpoint: ${JSON.stringify(URL)}, apiKey: ${JSON.stringify(ownerKey)} });

const agent = defineAgent(axon, {
  agentId: "summary-bot",
  name: "Summary Bot",
  capabilities: ["summarization"],
  publicKey: "summary-bot-key",
  walletAddress: ${JSON.stringify(OWNER)},
  price: "0.0002 ETH",
  handler: async ({ task, progress }) => {
    await progress("reading the request…");
    return \`Summary: \${task.task.slice(0, 40)}\`;
  },
});

await agent.start();
console.log("WORKER_READY");
process.on("SIGTERM", async () => { await agent.stop(); process.exit(0); });
`);

  say("\n── the agent goes live ──────────────────────────────────");
  worker = spawn("node", ["worker.mjs"], { cwd: app, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let workerOut = "";
  worker.stdout.on("data", (d) => { workerOut += d.toString(); });
  worker.stderr.on("data", (d) => { workerOut += d.toString(); });
  await waitFor(async () => workerOut.includes("WORKER_READY"), "the worker to start", 60_000)
    .catch(() => { throw new Error(`the worker never started:\n${workerOut.slice(0, 600)}`); });
  pass("defineAgent registered and started it");

  const listed = await (await fetch(`${URL}/api/agents/summary-bot`)).json();
  listed.agentId === "summary-bot" && listed.price === "0.0002 ETH"
    ? pass("it is in the directory", `${listed.price}`)
    : fail("directory", JSON.stringify(listed).slice(0, 120));

  // ── the owner opts into $AXON, as the README shows ────────────────────────
  writeFileSync(join(app, "optin.mjs"), `
import { AxonClient } from "@axonprotocol/sdk";
const axon = new AxonClient({ endpoint: ${JSON.stringify(URL)}, apiKey: ${JSON.stringify(ownerKey)} });
const updated = await axon.updateAgent("summary-bot", { acceptsAxon: true, axonDiscountBps: 2000 });
console.log(JSON.stringify({ acceptsAxon: updated.acceptsAxon, bps: updated.axonDiscountBps }));
`);
  const optin = JSON.parse(sh("node optin.mjs", app).trim().split("\n").pop());
  optin.acceptsAxon && optin.bps === 2000
    ? pass("the owner opts into $AXON", "20% off")
    : fail("opt in", JSON.stringify(optin));

  // ── the buyer, written from the README's hire section ─────────────────────
  writeFileSync(join(app, "buyer.mjs"), `
import { AxonClient, selectPaymentOption } from "@axonprotocol/sdk";

const axon = new AxonClient({ endpoint: ${JSON.stringify(URL)}, apiKey: ${JSON.stringify(buyerKey)} });
const out = {};

// find it the way a buyer would, by what it can do
const found = await axon.findAgents({ capability: "summarization" });
out.found = found.some((a) => a.agentId === "summary-bot");
out.badge = found.find((a) => a.agentId === "summary-bot")?.axonDiscountBps;

// what would it cost, either way
const reqs = await axon.getX402Requirements("summary-bot");
out.eth = selectPaymentOption(reqs).maxAmountRequired;
const token = selectPaymentOption(reqs, "axon");
out.axon = token.maxAmountRequired;
out.quoted = Boolean(token.extra.quoteId);

// hire it and pay, with a pay function of our own
const eth = selectPaymentOption(reqs);
const pay = async (_requirements, option) => ({
  signature: \`mockpay:ETH:\${option.maxAmountRequired}:\${${JSON.stringify(BUYER_WALLET)}}:\${option.payToAddress}:\${Date.now()}\`,
  from: ${JSON.stringify(BUYER_WALLET)},
});

const hired = await axon.hire({
  to: "summary-bot",
  task: "Summarize what Axon does for an agent developer",
  from: ${JSON.stringify(BUYER_WALLET)},
  pay,
  timeoutMs: 60000,
});

out.paid = hired.paid;
out.status = hired.status;
out.output = hired.output;
out.receipt = Boolean(hired.receipt);
console.log(JSON.stringify(out));
`);

  say("\n── a buyer finds it, hires it, pays it ──────────────────");
  const buy = JSON.parse(sh("node buyer.mjs", app).trim().split("\n").pop());

  buy.found ? pass("findAgents finds it by capability") : fail("findAgents", "not in the results");
  buy.badge === 2000 ? pass("the listing carries its $AXON discount", "2000 bps") : fail("discount on the listing", String(buy.badge));
  buy.quoted ? pass("both prices quoted", `${buy.eth} wei  |  ${buy.axon} $AXON units`) : fail("quote", "the token option carried none");
  buy.paid ? pass("the hire was paid") : fail("payment", "hire came back unpaid");
  buy.status === "completed" ? pass("the agent completed the work") : fail("task status", String(buy.status));
  buy.output?.startsWith("Summary:") ? pass("the buyer got the answer back", `"${buy.output.slice(0, 44)}…"`) : fail("output", String(buy.output));
  buy.receipt ? pass("a receipt came with it") : fail("receipt", "none");

  // ── and the agent has actually earned ─────────────────────────────────────
  writeFileSync(join(app, "earnings.mjs"), `
import { AxonClient } from "@axonprotocol/sdk";
const axon = new AxonClient({ endpoint: ${JSON.stringify(URL)}, apiKey: ${JSON.stringify(ownerKey)} });
const b = await axon.getBalance("summary-bot");
const r = await axon.getReputation("summary-bot");
console.log(JSON.stringify({ earned: b.totalEarned, tasksPaid: b.tasksPaid, completed: r.totalTasksCompleted }));
`);
  const money = JSON.parse(sh("node earnings.mjs", app).trim().split("\n").pop());
  money.earned > 0 && money.tasksPaid === 1
    ? pass("the agent has earned", `${money.earned} ETH over ${money.tasksPaid} paid task`)
    : fail("earnings", JSON.stringify(money));
  money.completed === 1 ? pass("and its reputation counted the work") : fail("reputation", JSON.stringify(money));

  say("");
  if (failures) throw new Error(`${failures} check(s) failed`);
  say("  a developer can install this, write an agent, and get paid for its work.\n");
}

main().then(
  () => { cleanup(); process.exit(0); },
  (err) => { say(`\nFAILED: ${err.message}\n`); cleanup(); process.exit(1); },
);
