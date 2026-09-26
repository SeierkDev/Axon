// Somebody has stolen an allowance key. What can they do, and what does the owner see?
//
// The contract's limits are the hard wall and have their own tests, including a flood of simultaneous
// hires on a real chain (allowancePayment.chain.test.ts). These are the thief's other moves: spend a
// wallet that is not the key's, hammer the API, pay a quote twice, and drain the day into an agent of
// their own; and whether the owner's dashboard says so when it happens.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import { createAgent } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import { createAllowanceKey } from "@/lib/allowanceKeys";
import { keyWarnings, noteAllowanceHire, KEY_HIRES_PER_MINUTE, BURST_HIRES } from "@/lib/allowanceWatch";
import { payFromAllowance, AllowancePaymentError } from "@/lib/allowancePayment";
import { logger } from "@/lib/logger";
import { toWei } from "@/lib/money";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as listKeys } from "@/app/api/allowance/keys/route";
import type { Agent } from "@/sdk/types";

const wallet = () => `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
const HOUR = 3_600_000;

function agent(opts: { owner?: string; price?: string; createdAt?: string } = {}): string {
  const a: Agent = {
    agentId: `abuse-${randomUUID().slice(0, 8)}`,
    name: "Abuse Test Agent",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: opts.owner ?? wallet(),
    provider: "anthropic",
    price: opts.price ?? "0.0005 ETH",
    reputation: 0,
    createdAt: opts.createdAt ?? new Date(Date.now() - 30 * 24 * HOUR).toISOString(),
  };
  createAgent(a);
  if (opts.createdAt) getDb().prepare("UPDATE agents SET created_at = ? WHERE agent_id = ?").run(opts.createdAt, a.agentId);
  return a.agentId;
}

function post(key: string, body: Record<string, unknown>) {
  return hire(new NextRequest("http://localhost/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ task: "x", paymentMethod: "allowance", ...body }),
  }));
}

let owner: string;
beforeEach(() => { owner = wallet(); });

/** A hire this key "made": a task and its reservation, at a chosen time and state. */
function spent(keyId: string, to: string, opts: { minutesAgo?: number; eth?: string; state?: string; wallet?: string } = {}) {
  const at = new Date(Date.now() - (opts.minutesAgo ?? 1) * 60_000).toISOString();
  const task = createTask({ fromAgent: opts.wallet ?? owner, toAgent: to, task: "x" });
  getDb().prepare(`
    INSERT INTO allowance_reservations (task_id, tx_id, owner, token, task_key, agent_key, amount_units, reserve_tx, state, created_at, api_key_id, eth_wei)
    VALUES (?, ?, ?, '0x0000000000000000000000000000000000000000', ?, 'a', ?, ?, ?, ?, ?, ?)
  `).run(task.taskId, randomUUID(), opts.wallet ?? owner, `0x${randomUUID()}`, toWei(opts.eth ?? "0.0005")!.toString(),
    `0x${randomUUID()}`, opts.state ?? "settled", at, keyId, toWei(opts.eth ?? "0.0005")!.toString());
}

describe("a stolen key cannot reach past its own wallet", () => {
  it("naming another wallet as the payer is refused", async () => {
    const stolen = createAllowanceKey(owner);
    const res = await post(stolen.apiKey, { from: wallet(), to: agent() });
    expect(res.status).toBe(403);
  });

  it("naming an agent somebody else owns as the payer is refused", async () => {
    const stolen = createAllowanceKey(owner);
    const theirs = agent({ owner: wallet() });
    const res = await post(stolen.apiKey, { from: theirs, to: agent() });
    expect(res.status).toBe(403);
  });

  it("cannot mint itself a full key", async () => {
    const stolen = createAllowanceKey(owner);
    const { POST: mint } = await import("@/app/api/auth/keys/route");
    const res = await mint(new NextRequest("http://localhost/api/auth/keys", { method: "POST", headers: { "x-api-key": stolen.apiKey } }));
    expect(res.status).toBe(403);
  });
});

describe("a stolen key cannot hammer", () => {
  it(`is rate limited to ${KEY_HIRES_PER_MINUTE} hires a minute`, async () => {
    const stolen = createAllowanceKey(owner);
    const to = agent();
    const statuses: number[] = [];
    for (let i = 0; i <= KEY_HIRES_PER_MINUTE; i++) statuses.push((await post(stolen.apiKey, { from: owner, to })).status);
    // Allowances are off in this environment, so the first ten are refused for that. The eleventh
    // never gets as far as asking.
    expect(statuses.slice(0, KEY_HIRES_PER_MINUTE).every((s) => s !== 429)).toBe(true);
    expect(statuses[KEY_HIRES_PER_MINUTE]).toBe(429);
  });

  it("each key has its own limit, so one key's flood does not lock out another", async () => {
    const stolen = createAllowanceKey(owner);
    const mine = createAllowanceKey(owner);
    const to = agent();
    for (let i = 0; i <= KEY_HIRES_PER_MINUTE; i++) await post(stolen.apiKey, { from: owner, to });
    expect((await post(mine.apiKey, { from: owner, to })).status).not.toBe(429);
  });
});

describe("a quote cannot be paid twice", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.AXON_ALLOWANCE_ADDRESS = "0x1111111111111111111111111111111111111111";
    process.env.AXON_ALLOWANCE_OPERATOR_KEY = `0x${"22".repeat(32)}`;
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = "0x3333333333333333333333333333333333333333";
  });
  afterEach(() => { process.env = { ...env }; });

  function quote(opts: { consumed?: boolean; expired?: boolean } = {}) {
    const id = randomUUID();
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO axon_quotes (quote_id, reference, eth_wei, axon_units, sqrt_price_x96, pay_to, created_at, expires_at, consumed_at, tx_hash)
      VALUES (?, NULL, '500000000000000', '1000', '1', '0x0', ?, ?, ?, ?)
    `).run(id, new Date(now - 60_000).toISOString(), new Date(now + (opts.expired ? -1_000 : 600_000)).toISOString(),
      opts.consumed ? new Date().toISOString() : null, opts.consumed ? `0x${randomUUID()}` : null);
    return id;
  }

  it("refuses a quote already paid, before touching the chain", async () => {
    const err = await payFromAllowance({ taskId: randomUUID(), fromAgent: owner, toAgent: agent(), owner, priceString: "0.0005 ETH", quoteId: quote({ consumed: true }) })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AllowancePaymentError);
    expect((err as Error).message).toMatch(/already been paid/);
  });

  it("refuses an expired quote", async () => {
    const err = await payFromAllowance({ taskId: randomUUID(), fromAgent: owner, toAgent: agent(), owner, priceString: "0.0005 ETH", quoteId: quote({ expired: true }) })
      .catch((e) => e);
    expect((err as Error).message).toMatch(/expired/);
  });
});

describe("the owner sees a drain", () => {
  it("nothing is flagged for ordinary use", () => {
    const key = createAllowanceKey(owner);
    const usual = agent();
    spent(key.keyId, usual, { minutesAgo: 26 * 60 }); // paid before today
    spent(key.keyId, usual, { minutesAgo: 30 });
    expect(keyWarnings(key.keyId)).toEqual([]);
  });

  it("paying an agent registered minutes earlier", () => {
    const key = createAllowanceKey(owner);
    const fresh = agent({ createdAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    spent(key.keyId, fresh, { minutesAgo: 5 });
    expect(keyWarnings(key.keyId).map((w) => w.code)).toContain("new_agent");
  });

  it(`${BURST_HIRES} hires in a few minutes, even if they all failed`, () => {
    const key = createAllowanceKey(owner);
    const to = agent();
    for (let i = 0; i < BURST_HIRES; i++) spent(key.keyId, to, { minutesAgo: 2, state: "released" });
    expect(keyWarnings(key.keyId).map((w) => w.code)).toContain("burst");
  });

  it("most of the day's limit inside an hour", () => {
    const key = createAllowanceKey(owner, { maxPerTaskWei: toWei("0.002")!, maxPerDayWei: toWei("0.005")! });
    const to = agent();
    spent(key.keyId, to, { minutesAgo: 40, eth: "0.002" });
    spent(key.keyId, to, { minutesAgo: 20, eth: "0.002" });
    expect(keyWarnings(key.keyId).find((w) => w.code === "burst")?.message).toMatch(/last hour/);
  });

  it("a new user's first hires are not flagged as someone else's spending", () => {
    // Found on the private site: a brand-new wallet's first two hires raised the red banner, because on
    // anyone's first day every agent is one they never paid before.
    const key = createAllowanceKey(owner);
    const first = agent();
    spent(key.keyId, first, { minutesAgo: 30 });
    spent(key.keyId, first, { minutesAgo: 10 });
    expect(keyWarnings(key.keyId)).toEqual([]);
  });

  it("most of today's money to one agent this wallet never paid before", () => {
    const key = createAllowanceKey(owner);
    const usual = agent();
    const stranger = agent();
    spent(key.keyId, usual, { minutesAgo: 26 * 60 });
    spent(key.keyId, stranger, { minutesAgo: 50 });
    spent(key.keyId, stranger, { minutesAgo: 30 });
    expect(keyWarnings(key.keyId).map((w) => w.code)).toContain("one_payee");
  });

  it("is logged once per key and kind a day, not once per hire", () => {
    const warn = vi.spyOn(logger, "warn");
    try {
      const key = createAllowanceKey(owner);
      const fresh = agent({ createdAt: new Date().toISOString() });
      spent(key.keyId, fresh);
      noteAllowanceHire(key.keyId);
      noteAllowanceHire(key.keyId);
      expect(warn.mock.calls.filter((c) => c[0] === "allowance.unusual_spend")).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("reaches the owner's dashboard next to the key", async () => {
    const fullKey = createApiKey(owner).apiKey;
    const key = createAllowanceKey(owner, { label: "Cursor" });
    spent(key.keyId, agent({ createdAt: new Date().toISOString() }));
    const res = await listKeys(new NextRequest("http://localhost/api/allowance/keys", { headers: { "x-api-key": fullKey } }));
    const body = (await res.json()) as { keys: { label: string; warnings: { code: string }[] }[] };
    expect(body.keys.find((k) => k.label === "Cursor")?.warnings.map((w) => w.code)).toContain("new_agent");
  });
});
