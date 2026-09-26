// Allowance keys: what they can do, and everything they must not.
//
// The security of the feature is a default: every route treats an allowance key as no key unless the
// route was written to take one. Most of these tests are an allowance key knocking on doors that
// should stay shut.

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createApiKey, authenticateApiKey } from "@/lib/identity";
import { createAgent } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import {
  createAllowanceKey,
  keyInputError,
  keyLimitError,
  keySpentTodayWei,
  listAllowanceKeys,
  revokeAllowanceKey,
} from "@/lib/allowanceKeys";
import { DEFAULT_MAX_PER_TASK_WEI, DEFAULT_MAX_PER_DAY_WEI } from "@/lib/allowancePolicy";
import { toWei } from "@/lib/money";
import { GET as listFullKeys, POST as mintFullKey } from "@/app/api/auth/keys/route";
import { GET as listKeys, POST as mintKey } from "@/app/api/allowance/keys/route";
import { DELETE as revokeKey } from "@/app/api/allowance/keys/[keyId]/route";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as readTask } from "@/app/api/tasks/[taskId]/route";
import { GET as listPayments } from "@/app/api/allowance/payments/route";
import type { Agent } from "@/sdk/types";

const wallet = () => `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;

function req(url: string, key: string | null, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function agent(price?: string): string {
  const a: Agent = {
    agentId: `k-${randomUUID().slice(0, 8)}`,
    name: "Key Test Agent",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: wallet(),
    provider: "anthropic",
    price,
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a.agentId;
}

let owner: string;
let fullKey: string;

beforeEach(() => {
  owner = wallet();
  fullKey = createApiKey(owner).apiKey;
});

describe("minting and listing", () => {
  it("a new allowance key starts with the allowance defaults and a 30-day expiry", () => {
    const k = createAllowanceKey(owner, { label: "Claude" });
    expect(k.limits.maxPerTaskWei).toBe(DEFAULT_MAX_PER_TASK_WEI);
    expect(k.limits.maxPerDayWei).toBe(DEFAULT_MAX_PER_DAY_WEI);
    expect(k.limits.allowedAgents).toBeNull();
    const days = (Date.parse(k.limits.expiresAt) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it("refuses limits that make no sense", () => {
    expect(keyInputError({ maxPerTaskWei: 0n })).toMatch(/per-task/);
    expect(keyInputError({ maxPerTaskWei: 10n, maxPerDayWei: 5n })).toMatch(/daily/);
    expect(keyInputError({ expiresInDays: 0 })).toMatch(/expires/);
    expect(keyInputError({ allowedAgents: [] })).toMatch(/empty/);
    expect(keyInputError({ allowedAgents: ["a", "a"] })).toMatch(/twice/);
  });

  it("is minted, listed and revoked through the API with a full key", async () => {
    const minted = await mintKey(req("/api/allowance/keys", fullKey, "POST", { label: "Cursor", maxPerTask: "0.0002", maxPerDay: "0.001" }));
    expect(minted.status).toBe(201);
    const body = (await minted.json()) as { keyId: string; apiKey: string; maxPerTask: string };
    expect(body.maxPerTask).toBe("0.0002");

    const listed = (await (await listKeys(req("/api/allowance/keys", fullKey))).json()) as { keys: { keyId: string; label: string }[] };
    expect(listed.keys.map((k) => k.label)).toContain("Cursor");

    const revoked = await revokeKey(req(`/api/allowance/keys/${body.keyId}`, fullKey, "DELETE"), { params: Promise.resolve({ keyId: body.keyId }) });
    expect(revoked.status).toBe(200);
    expect(authenticateApiKey(req("/", body.apiKey), { allowAllowanceScope: true })).toBeNull();
  });

  it("another wallet cannot revoke it", async () => {
    const k = createAllowanceKey(owner);
    const stranger = createApiKey(wallet()).apiKey;
    const res = await revokeKey(req(`/api/allowance/keys/${k.keyId}`, stranger, "DELETE"), { params: Promise.resolve({ keyId: k.keyId }) });
    expect(res.status).toBe(404);
    expect(listAllowanceKeys(owner)).toHaveLength(1);
  });
});

describe("an allowance key is refused everywhere it was not invited", () => {
  it("is not a key at all unless a route opts in", () => {
    const k = createAllowanceKey(owner);
    expect(authenticateApiKey(req("/", k.apiKey))).toBeNull();
    expect(authenticateApiKey(req("/", k.apiKey), { allowAllowanceScope: true })?.scope).toBe("allowance");
  });

  it("cannot mint keys of either kind, or list them, and is told why", async () => {
    const k = createAllowanceKey(owner);
    for (const res of [
      await mintFullKey(req("/api/auth/keys", k.apiKey, "POST")),
      await listFullKeys(req("/api/auth/keys", k.apiKey)),
      await mintKey(req("/api/allowance/keys", k.apiKey, "POST", {})),
      await listKeys(req("/api/allowance/keys", k.apiKey)),
    ]) {
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).toMatch(/allowance key/);
    }
  });

  it("cannot revoke other keys", async () => {
    const k = createAllowanceKey(owner);
    const other = createAllowanceKey(owner);
    const res = await revokeKey(req(`/api/allowance/keys/${other.keyId}`, k.apiKey, "DELETE"), { params: Promise.resolve({ keyId: other.keyId }) });
    expect(res.status).toBe(403);
  });

  it("cannot hire a free agent, or pay any way but the allowance", async () => {
    const k = createAllowanceKey(owner);
    const free = await hire(req("/api/tasks", k.apiKey, "POST", { from: owner, to: agent(), task: "x" }));
    expect(free.status).toBe(403);
    const onchain = await hire(req("/api/tasks", k.apiKey, "POST", { from: owner, to: agent("0.0001 ETH"), task: "x", paymentSignature: "0xabc" }));
    expect(onchain.status).toBe(403);
    const balance = await hire(req("/api/tasks", k.apiKey, "POST", { from: owner, to: agent("0.0001 ETH"), task: "x", paymentMethod: "balance" }));
    expect(balance.status).toBe(403);
  });

  it("reads only tasks it hired itself, not everything its owner has", async () => {
    const k = createAllowanceKey(owner);
    const to = agent("0.0001 ETH");
    const mine = createTask({ fromAgent: owner, toAgent: to, task: "mine" });
    const ownersOther = createTask({ fromAgent: owner, toAgent: to, task: "the owner's own" });
    getDb().prepare(`
      INSERT INTO allowance_reservations (task_id, tx_id, owner, token, task_key, agent_key, amount_units, reserve_tx, state, created_at, api_key_id, eth_wei)
      VALUES (?, ?, ?, '0x0000000000000000000000000000000000000000', ?, 'a', '1', ?, 'reserved', ?, ?, '1')
    `).run(mine.taskId, randomUUID(), owner, `0x${randomUUID()}`, `0x${randomUUID()}`, new Date().toISOString(), k.keyId);

    const ok = await readTask(req(`/api/tasks/${mine.taskId}`, k.apiKey), { params: Promise.resolve({ taskId: mine.taskId }) });
    expect(ok.status).toBe(200);
    const denied = await readTask(req(`/api/tasks/${ownersOther.taskId}`, k.apiKey), { params: Promise.resolve({ taskId: ownersOther.taskId }) });
    expect(denied.status).toBe(403);
    const byOwner = await readTask(req(`/api/tasks/${ownersOther.taskId}`, fullKey), { params: Promise.resolve({ taskId: ownersOther.taskId }) });
    expect(byOwner.status).toBe(200);
  });

  it("stops working the moment it is revoked", async () => {
    const k = createAllowanceKey(owner);
    expect(revokeAllowanceKey(k.keyId, owner)).toBe(true);
    const res = await hire(req("/api/tasks", k.apiKey, "POST", { from: owner, to: agent("0.0001 ETH"), task: "x", paymentMethod: "allowance" }));
    expect(res.status).toBe(401);
  });
});

describe("the key's own limits", () => {
  function reservation(keyId: string, wei: bigint, state: string, createdAt = new Date().toISOString()) {
    getDb().prepare(`
      INSERT INTO allowance_reservations (task_id, tx_id, owner, token, task_key, agent_key, amount_units, reserve_tx, state, created_at, api_key_id, eth_wei)
      VALUES (?, ?, ?, '0x0000000000000000000000000000000000000000', ?, 'a', ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), randomUUID(), owner, `0x${randomUUID()}`, wei.toString(), `0x${randomUUID()}`, state, createdAt, keyId, wei.toString());
  }

  it("refuses over the per-task limit, off the allowed list, or after expiry", () => {
    const k = createAllowanceKey(owner, { maxPerTaskWei: toWei("0.0002")!, allowedAgents: ["good-agent"] });
    expect(keyLimitError(k.keyId, "good-agent", toWei("0.0003")!)).toMatch(/per-task/);
    expect(keyLimitError(k.keyId, "other-agent", toWei("0.0001")!)).toMatch(/allowed list/);
    expect(keyLimitError(k.keyId, "good-agent", toWei("0.0001")!)).toBeNull();
    expect(keyLimitError(k.keyId, "good-agent", toWei("0.0001")!, Date.now() + 31 * 86_400_000)).toMatch(/expired/);
  });

  it("counts reserved and settled work toward the day, not released or reclaimed", () => {
    const k = createAllowanceKey(owner, { maxPerTaskWei: toWei("0.0005")!, maxPerDayWei: toWei("0.001")! });
    reservation(k.keyId, toWei("0.0004")!, "settled");
    reservation(k.keyId, toWei("0.0004")!, "reserved");
    reservation(k.keyId, toWei("0.0005")!, "released");
    reservation(k.keyId, toWei("0.0005")!, "reclaimed");
    reservation(k.keyId, toWei("0.0005")!, "settled", new Date(Date.now() - 2 * 86_400_000).toISOString());
    expect(keySpentTodayWei(k.keyId)).toBe(toWei("0.0008"));
    expect(keyLimitError(k.keyId, "any", toWei("0.0002")!)).toBeNull();
    expect(keyLimitError(k.keyId, "any", toWei("0.0003")!)).toMatch(/daily limit/);
  });
});

describe("GET /api/allowance/payments", () => {
  function reservationFor(keyId: string | null, taskId = randomUUID()) {
    getDb().prepare(`
      INSERT INTO allowance_reservations (task_id, tx_id, owner, token, task_key, agent_key, amount_units, reserve_tx, state, created_at, api_key_id, eth_wei)
      VALUES (?, ?, ?, '0x0000000000000000000000000000000000000000', ?, 'a', '250000000000000', ?, 'settled', ?, ?, '250000000000000')
    `).run(taskId, randomUUID(), owner, `0x${randomUUID()}`, `0x${randomUUID()}`, new Date().toISOString(), keyId);
    return taskId;
  }

  it("a full key sees every payment from its allowance, with which key paid", async () => {
    const claude = createAllowanceKey(owner, { label: "Claude" });
    const a = reservationFor(claude.keyId);
    const b = reservationFor(null);
    const res = await listPayments(req("/api/allowance/payments", fullKey));
    const body = (await res.json()) as { payments: { taskId: string; amount: string; paidWithKey: { label: string } | null }[] };
    expect(body.payments.map((p) => p.taskId).sort()).toEqual([a, b].sort());
    expect(body.payments.find((p) => p.taskId === a)).toMatchObject({ amount: "0.00025", paidWithKey: { label: "Claude" } });
  });

  it("an allowance key sees only what it paid for", async () => {
    const claude = createAllowanceKey(owner, { label: "Claude" });
    const cursor = createAllowanceKey(owner, { label: "Cursor" });
    const mine = reservationFor(claude.keyId);
    reservationFor(cursor.keyId);
    reservationFor(null);
    const res = await listPayments(req("/api/allowance/payments", claude.apiKey));
    const body = (await res.json()) as { payments: { taskId: string }[] };
    expect(body.payments.map((p) => p.taskId)).toEqual([mine]);
  });

  it("another wallet sees none of them", async () => {
    reservationFor(null);
    const stranger = createApiKey(wallet()).apiKey;
    const body = (await (await listPayments(req("/api/allowance/payments", stranger))).json()) as { payments: unknown[] };
    expect(body.payments).toEqual([]);
  });
});
