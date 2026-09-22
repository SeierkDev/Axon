// Drive the real private launch page in Chrome with a stubbed wallet, and capture what it would send.
//
// Nothing is signed and nothing is written: the eligibility API is intercepted so no agent is created,
// and eth_sendTransaction is answered by the stub instead of a wallet. What this checks is the part no
// test could reach: connect, the chain switch, the two transactions the page builds, and the receipt
// parsing that finds the pot address.

import { spawn } from "node:child_process";
import WebSocket from "ws";

const SITE = process.env.CHECK_SITE ?? "https://axon-private-production.up.railway.app";
const AGENT = "browser-check-agent";
const WALLET = "0xccde58f296379d5ba93d924ca63004d29c2e34dc";
const FACTORY = "0xb2c910d4cf68a5b7c12e78e9bcdf7fd0cbd6b527";
const POT = "0x1111111111111111111111111111111111111111";
const SPLITTER = "0x2222222222222222222222222222222222222222";
const TOPIC = "0xd5d85f0fe0a8544cd7c0e92198eb873e17ff8afa11902012df256501406eb359";
const FEE_WEI = "500000000000000";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=/tmp/axon-browsercheck-profile",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
      const t = await res.json();
      if (t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("Chrome never came up");
}

const ws = new WebSocket(await targetWs(), { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((r) => ws.once("open", r));

let id = 0;
const pending = new Map();
const events = [];
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");

// ── the wallet stub, installed before any page script runs ────────────────────────────────────────
// Built here and injected as finished JSON. Composing the topics inside the injected source meant the
// nested interpolation never ran, the topics were the literal text "${WALLET}", and the page's decode
// found no pot: a broken stub that looked exactly like a broken page.
const RECEIPT = {
  status: "0x1",
  logs: [{
    address: FACTORY,
    topics: [TOPIC, `0x${pad(WALLET)}`, `0x${pad(POT)}`, `0x${pad(SPLITTER)}`],
    data: `0x${(7000).toString(16).padStart(64, "0")}`,
  }],
};

await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__sent = [];
    window.__calls = [];
    const RECEIPT = ${JSON.stringify(RECEIPT)};
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        window.__calls.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts") return ["${WALLET}"];
        // Deliberately the WRONG chain first, so the page's switch prompt has to fire.
        if (method === "eth_chainId") return window.__switched ? "0x1237" : "0x1";
        if (method === "wallet_switchEthereumChain") {
          // A wallet that has never added Robinhood Chain, which is the ordinary case for a chain this
          // new. MetaMask answers 4902 here, and a page that does not catch it dead-ends.
          if (!window.__added) { const e = new Error("Unrecognized chain ID"); e.code = 4902; throw e; }
          window.__switched = true; return null;
        }
        if (method === "wallet_addEthereumChain") { window.__added = true; window.__switched = true; window.__addParams = params[0]; return null; }
        if (method === "eth_sendTransaction") {
          window.__sent.push(params[0]);
          return "0x" + String(window.__sent.length).padStart(64, "0");
        }
        if (method === "eth_getTransactionReceipt") return RECEIPT;
        return null;
      },
      on: () => {}, removeListener: () => {},
    };
  `,
});

// ── intercept the eligibility API so nothing is created on the site ───────────────────────────────
await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/agent-launch/*" }] });

const body = JSON.stringify({
  eligible: true,
  reason: null,
  agent: { agentId: AGENT, name: "Browser Check Agent", walletAddress: WALLET, verificationStatus: "verified" },
  record: { tasksCompleted: 0, tasksFailed: 0, reputation: 0, registeredAt: "2026-09-22T00:00:00Z" },
  launchFeeWei: FEE_WEI,
  factory: FACTORY,
  chainId: 4663,
  maxDevBps: 9000,
});

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.method === "Fetch.requestPaused") {
    await send("Fetch.fulfillRequest", {
      requestId: msg.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "content-type", value: "application/json" }],
      body: Buffer.from(body).toString("base64"),
    }).catch(() => {});
  }
});

await send("Page.navigate", { url: `${SITE}/launch/${AGENT}` });
await sleep(6000);

const report = { steps: [] };

// ── connect ───────────────────────────────────────────────────────────────────────────────────────
report.steps.push(await evaluate(`(() => {
  const b = [...document.querySelectorAll("button")].find(x => /connect/i.test(x.textContent));
  if (!b) return { step: "connect", ok: false, note: "no connect button", body: document.body.innerText.slice(0, 300) };
  b.click();
  return { step: "connect", ok: true };
})()`));
await sleep(2500);

// ── fill the form ─────────────────────────────────────────────────────────────────────────────────
report.steps.push(await evaluate(`(() => {
  const setVal = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const inputs = [...document.querySelectorAll("input, textarea")];
  // The fields are labelled rather than placeheld, so match on the label text above each one.
  const byLabel = (re) => inputs.find((i) => {
    const lab = i.closest("label") || document.querySelector('label[for="' + i.id + '"]');
    const text = (lab?.innerText || "") + " " + (i.placeholder || "") + " " + (i.name || "") + " " + (i.id || "");
    return re.test(text);
  });
  // The labels are not associated with the inputs, so fall back to document order, which the page
  // renders as NAME, TICKER, IMAGE URL, DESCRIPTION, FIRST BUY.
  const name = byLabel(/\\bname\\b/i) || inputs[0];
  const sym = byLabel(/ticker|symbol/i) || inputs[1];
  const logo = byLabel(/image|logo/i) || inputs[2];
  if (name) setVal(name, "Browser Check");
  if (sym) setVal(sym, "BCHK");
  if (logo) setVal(logo, "ipfs://bafybrowsercheck");
  return {
    step: "fill", ok: true, inputs: inputs.length,
    filled: { name: !!name, ticker: !!sym, image: !!logo },
    values: inputs.map(i => i.value),
  };
})()`));
await sleep(1200);

// ── deploy, then launch ───────────────────────────────────────────────────────────────────────────
for (const [label, re] of [["deploy", /deploy/i], ["launch", /launch/i]]) {
  report.steps.push(await evaluate(`(() => {
    const all = [...document.querySelectorAll("button")];
    const b = all.filter(x => ${re}.test(x.textContent) && !x.disabled);
    const seen = all.map(x => x.textContent.trim() + (x.disabled ? " [disabled]" : ""));
    if (!b.length) return { step: "${label}", ok: false, buttons: seen };
    b[0].click();
    return { step: "${label}", ok: true, clicked: b[0].textContent.trim(), buttons: seen };
  })()`));
  await sleep(8000);
}

report.addedChain = await evaluate("window.__addParams ?? null");
report.calls = await evaluate("window.__calls");
report.sent = await evaluate("window.__sent");
report.pageText = await evaluate("document.body.innerText.slice(0, 600)");

console.log(JSON.stringify(report, null, 2));

// ── what the run had to show, or it did not pass ──────────────────────────────────────────────────
// Printing a report and exiting zero makes every run look like a success, including the ones where the
// page sent nothing at all. These are the things that were actually broken at some point, so these are
// the things asserted: the chain offer (the page dead-ended without it), the factory call, and a launch
// carrying the fee.
const DEPLOY_PAIR = "0x5b54a1d6";
const LAUNCH = "0xbe1687d6";
const failures = [];
const must = (cond, why) => { if (!cond) failures.push(why); };

must(report.calls.includes("eth_requestAccounts"), "never asked the wallet for an account");
must(
  report.addedChain?.chainId === "0x1237",
  "a wallet that answered 4902 was never offered the chain, so the flow dead-ends for anyone who has not added it",
);
must(report.sent.length === 2, `expected two transactions, got ${report.sent.length}`);
must(report.sent[0]?.to?.toLowerCase() === FACTORY, "the first transaction did not go to the factory");
must(report.sent[0]?.data?.startsWith(DEPLOY_PAIR), "the first transaction is not deployPair");
must(report.sent[1]?.data?.startsWith(LAUNCH), "the second transaction is not launch");
must(BigInt(report.sent[1]?.value ?? 0) === BigInt(FEE_WEI), "the launch did not carry the Pons fee");

ws.close();
chrome.kill("SIGKILL");

if (failures.length) {
  console.error("\nFAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.error("\nPASSED: connect, chain offer, deployPair, launch with the fee");
process.exit(0);
