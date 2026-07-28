// Tests for src/lib/commerce.ts — the authorization layer behind real-world
// purchases. These cover the invariants that matter because actual money moves:
// an intent is single-use, an approval binds to a ceiling and expires, and PII
// never escapes in the clear.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import {
  createCommerceProfile,
  getCommerceProfile,
  getCommerceProfilePrivate,
  listCommerceProfiles,
  createSpendMandate,
  getActiveMandate,
  revokeSpendMandate,
  killSwitch,
  spentInPeriod,
  proposePurchase,
  approvePurchase,
  declinePurchase,
  consumePurchaseIntent,
  getPurchaseIntent,
  expireStaleIntents,
  spendSummary,
  CommerceError,
  listPurchaseIntents,
} from "@/lib/commerce";

const TEST_INSTRUMENT = { id: "pi_1", handlerId: "h_1", type: "card", credential: { type: "token", token: "tok_test" } };

const CONTACT = { name: "Ada Lovelace", email: "ada@example.com", phone: "+15550001111" };
const ADDRESS = { line1: "12 Analytical Way", city: "London", postalCode: "EC1A 1BB", country: "GB" };

let n = 0;
const wallet = () => `wallet-${++n}-${randomUUID().slice(0, 8)}`;

function setup(opts: { maxPerPurchase?: number; maxPerPeriod?: number; autoApproveUnder?: number; allowedHosts?: string[] } = {}) {
  const ownerWallet = wallet();
  const agentId = `shopper-${randomUUID().slice(0, 8)}`;
  const profile = createCommerceProfile({ ownerWallet, label: "Home", contact: CONTACT, address: ADDRESS });
  const mandate = createSpendMandate({
    ownerWallet,
    agentId,
    profileId: profile.profileId,
    maxPerPurchase: opts.maxPerPurchase ?? 500,
    maxPerPeriod: opts.maxPerPeriod ?? 1000,
    autoApproveUnder: opts.autoApproveUnder ?? 0,
    allowedHosts: opts.allowedHosts,
  });
  return { ownerWallet, agentId, profile, mandate };
}

const propose = (agentId: string, amount: number, host = "shop.example.com") =>
  proposePurchase({ agentId, businessHost: host, summary: `${amount} of things`, itemsHash: "a".repeat(64), amount });

// ── PII ───────────────────────────────────────────────────────────────────────

describe("commerce profiles", () => {
  it("keeps contact and address out of the public shape and out of the raw row", () => {
    const ownerWallet = wallet();
    const profile = createCommerceProfile({ ownerWallet, label: "Home", contact: CONTACT, address: ADDRESS });

    // The shape an API would return carries no PII at all.
    expect(JSON.stringify(getCommerceProfile(profile.profileId))).not.toContain("Ada Lovelace");
    expect(JSON.stringify(getCommerceProfile(profile.profileId))).not.toContain("Analytical Way");

    // …and it isn't sitting in the database in the clear either.
    const row = getDb().prepare("SELECT * FROM commerce_profiles WHERE profile_id = ?").get(profile.profileId);
    const raw = JSON.stringify(row);
    expect(raw).not.toContain("Ada Lovelace");
    expect(raw).not.toContain("Analytical Way");
    expect(raw).not.toContain("ada@example.com");
  });

  it("round-trips the details for the one caller allowed to see them", () => {
    const ownerWallet = wallet();
    const profile = createCommerceProfile({ ownerWallet, label: "Home", contact: CONTACT, address: ADDRESS });
    const priv = getCommerceProfilePrivate(profile.profileId)!;
    expect(priv.contact).toEqual(CONTACT);
    expect(priv.address).toEqual(ADDRESS);
    expect(listCommerceProfiles(ownerWallet)).toHaveLength(1);
  });
});

// ── Spend rules ───────────────────────────────────────────────────────────────

describe("proposePurchase: spend rules", () => {
  it("refuses an agent with no mandate", () => {
    expect(() => propose(`ungranted-${randomUUID().slice(0, 6)}`, 10)).toThrow(CommerceError);
  });

  it("refuses a purchase over the per-purchase cap", () => {
    const { agentId } = setup({ maxPerPurchase: 100 });
    expect(() => propose(agentId, 101)).toThrow(/per-purchase cap/);
  });

  it("refuses once the period budget would be exceeded", () => {
    const { agentId } = setup({ maxPerPurchase: 500, maxPerPeriod: 150 });
    const first = propose(agentId, 100).intent;
    approvePurchase(first.intentId, first.ownerWallet);
    consumePurchaseIntent(first.intentId, { orderId: "o1", settledAmount: 100 });

    expect(spentInPeriod(getActiveMandate(agentId)!)).toBe(100);
    expect(() => propose(agentId, 60)).toThrow(/per-month budget/);
    // …but something that fits still goes through.
    expect(propose(agentId, 40).intent.status).toBe("proposed");
  });

  it("only counts completed purchases toward the budget", () => {
    const { agentId } = setup({ maxPerPeriod: 150 });
    propose(agentId, 100); // proposed, never approved
    expect(spentInPeriod(getActiveMandate(agentId)!)).toBe(0);
  });

  it("honours a business allowlist", () => {
    const { agentId } = setup({ allowedHosts: ["shop.example.com"] });
    expect(propose(agentId, 20, "shop.example.com").intent.status).toBe("proposed");
    expect(() => propose(agentId, 20, "elsewhere.example.com")).toThrow(/not in this mandate/);
  });

  it("refuses a non-positive amount", () => {
    const { agentId } = setup();
    expect(() => propose(agentId, 0)).toThrow(/must be positive/);
  });

  it("does not spend under a revoked mandate", () => {
    const { agentId, mandate } = setup();
    revokeSpendMandate(mandate.mandateId);
    expect(getActiveMandate(agentId)).toBeNull();
    expect(() => propose(agentId, 10)).toThrow(/no active spend mandate/);
  });
});

// ── Approval ──────────────────────────────────────────────────────────────────

describe("approval", () => {
  it("needs a human by default", () => {
    const { agentId } = setup();
    const { intent, preCleared } = propose(agentId, 42);
    expect(preCleared).toBe(false);
    expect(intent.status).toBe("proposed");
  });

  it("a pre-cleared purchase still waits to be signed, and can then complete", () => {
    // AP2 has no way to consent to a purchase before it exists, so the threshold
    // removes the DECISION, never the signature. An intent that jumped straight
    // to 'approved' here could never be completed — completion needs a mandate.
    const { agentId } = setup({ autoApproveUnder: 25 });
    const under = propose(agentId, 20);
    expect(under.preCleared).toBe(true);
    expect(under.intent.status).toBe("proposed");
    expect(under.intent.preCleared).toBe(true);
    expect(under.intent.signed).toBe(false);

    const over = propose(agentId, 30);
    expect(over.preCleared).toBe(false);
    expect(over.intent.preCleared).toBe(false);
  });

  it("never claims a purchase happened when only a proposal did", async () => {
    const { getDb } = await import("@/lib/db");
    const { createAgent } = await import("@/lib/agents");
    const ownerWallet = wallet();
    const agentId = `pc-${randomUUID().slice(0, 8)}`;
    createAgent({
      agentId, name: "PreCleared", capabilities: ["shopping"], publicKey: `pk-${agentId}`,
      walletAddress: "11111111111111111111111111111111", provider: "anthropic",
      reputation: 0, createdAt: new Date().toISOString(),
    });
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({
      ownerWallet, agentId, profileId: profile.profileId,
      maxPerPurchase: 500, maxPerPeriod: 900, autoApproveUnder: 50,
    });
    getDb().prepare(
      "INSERT INTO webhooks (webhook_id, agent_id, url, events, secret, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ).run(randomUUID(), agentId, "https://hook.example.com/y", JSON.stringify(["purchase.proposed", "purchase.completed"]), "s", new Date().toISOString());

    propose(agentId, 20); // comfortably under the threshold
    const row = getDb().prepare(
      "SELECT event_type FROM webhook_deliveries ORDER BY created_at DESC LIMIT 1",
    ).get() as { event_type: string };
    // Nothing was bought — saying "completed" would have a buyer's integration
    // record a purchase that never happened.
    expect(row.event_type).toBe("purchase.proposed");
  });

  it("cannot be approved by someone else", () => {
    const { agentId } = setup();
    const { intent } = propose(agentId, 42);
    expect(approvePurchase(intent.intentId, wallet())).toBeNull();
    expect(getPurchaseIntent(intent.intentId)!.status).toBe("proposed");
  });

  it("a declined intent can't then be approved", () => {
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 42);
    expect(declinePurchase(intent.intentId, ownerWallet)!.status).toBe("declined");
    expect(approvePurchase(intent.intentId, ownerWallet)).toBeNull();
  });
});

// ── The invariants that protect real money ────────────────────────────────────

describe("consumePurchaseIntent: single use", () => {
  it("a retried task cannot buy the same thing twice", () => {
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 80);
    approvePurchase(intent.intentId, ownerWallet);

    const first = consumePurchaseIntent(intent.intentId, { orderId: "order-1", settledAmount: 80 });
    expect(first!.status).toBe("purchased");
    expect(first!.orderId).toBe("order-1");

    // The retry — same intent, second order. Must not go through.
    expect(consumePurchaseIntent(intent.intentId, { orderId: "order-2", settledAmount: 80 })).toBeNull();
    expect(getPurchaseIntent(intent.intentId)!.orderId).toBe("order-1");
  });

  it("cannot be redeemed without an approval", () => {
    const { agentId } = setup();
    const { intent } = propose(agentId, 80); // still 'proposed'
    expect(consumePurchaseIntent(intent.intentId, { orderId: "o", settledAmount: 80 })).toBeNull();
  });

  it("refuses a checkout that settled above the approved ceiling", () => {
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 180);
    approvePurchase(intent.intentId, ownerWallet);

    // The price moved between approval and checkout.
    expect(consumePurchaseIntent(intent.intentId, { orderId: "o", settledAmount: 210 })).toBeNull();
    const after = getPurchaseIntent(intent.intentId)!;
    expect(after.status).toBe("failed");
    expect(after.failure).toMatch(/above the approved ceiling/);
  });

  it("accepts a checkout that came in cheaper, at the real price", () => {
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 180);
    approvePurchase(intent.intentId, ownerWallet);
    const done = consumePurchaseIntent(intent.intentId, { orderId: "o", settledAmount: 150 })!;
    expect(done.status).toBe("purchased");
    expect(done.amount).toBe(150); // the budget is charged what was actually paid
  });

  it("an expired approval is not redeemable", () => {
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 80);
    approvePurchase(intent.intentId, ownerWallet);
    // Wind the clock past the TTL.
    getDb().prepare("UPDATE purchase_intents SET expires_at = ? WHERE intent_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), intent.intentId);

    expect(consumePurchaseIntent(intent.intentId, { orderId: "o", settledAmount: 80 })).toBeNull();
    expect(expireStaleIntents()).toBeGreaterThan(0);
    expect(getPurchaseIntent(intent.intentId)!.status).toBe("expired");
  });

  it("an expired proposal can no longer be approved", () => {
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 80);
    getDb().prepare("UPDATE purchase_intents SET expires_at = ? WHERE intent_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), intent.intentId);
    expect(approvePurchase(intent.intentId, ownerWallet)).toBeNull();
  });
});

// ── Kill switch ───────────────────────────────────────────────────────────────

describe("killSwitch", () => {
  it("stops everything: mandates revoked, pending intents voided, profile frozen", () => {
    const { agentId, ownerWallet, profile } = setup();
    const pending = propose(agentId, 50).intent;
    const approved = propose(agentId, 60).intent;
    approvePurchase(approved.intentId, ownerWallet);

    const res = killSwitch(ownerWallet);
    expect(res.mandatesRevoked).toBe(1);
    expect(res.intentsVoided).toBe(2);

    expect(getPurchaseIntent(pending.intentId)!.status).toBe("declined");
    expect(getPurchaseIntent(approved.intentId)!.status).toBe("declined");
    expect(getActiveMandate(agentId)).toBeNull();
    expect(getCommerceProfile(profile.profileId)!.status).toBe("frozen");

    // And an already-approved intent can't still be redeemed afterwards.
    expect(consumePurchaseIntent(approved.intentId, { orderId: "o", settledAmount: 60 })).toBeNull();
  });
});

describe("spendSummary", () => {
  it("reports what was actually spent and what is still waiting", () => {
    const { agentId, ownerWallet } = setup();
    const done = propose(agentId, 30).intent;
    approvePurchase(done.intentId, ownerWallet);
    consumePurchaseIntent(done.intentId, { orderId: "o", settledAmount: 30 });
    propose(agentId, 45);

    const s = spendSummary(ownerWallet);
    expect(s).toMatchObject({ purchased: 1, totalSpent: 30, pending: 1 });
  });
});

// ── The grant ─────────────────────────────────────────────────────────────────

describe("the commerce grant", () => {
  it("resolves to search and propose, and never to a 'buy' tool", async () => {
    const { resolveAgentTools, hasTools } = await import("@/lib/agentTools");
    const { agentId } = setup();
    const resolved = resolveAgentTools(["commerce"], { agentId });

    expect(hasTools(resolved)).toBe(true);
    expect(resolved.grants).toEqual(["commerce"]);
    const names = resolved.localTools.map((t) => t.name);
    expect(names).toContain("commerce_search_products");
    expect(names).toContain("commerce_propose_purchase");
    // An agent must never be the last thing between a buyer and their money.
    expect(names.some((n) => /(^|_)buy|checkout_complete|purchase_now/.test(n))).toBe(false);
  });

  it("is skipped rather than half-wired when resolved without an agent", async () => {
    const { resolveAgentTools, hasTools } = await import("@/lib/agentTools");
    const resolved = resolveAgentTools(["commerce"]);
    expect(hasTools(resolved)).toBe(false);
    expect(resolved.grants).toEqual([]);
  });

  it("runs Axon-side, so it needs no particular model", async () => {
    const { toolsActiveFor } = await import("@/lib/agentTools");
    expect(toolsActiveFor({ provider: "anthropic", tools: ["commerce"], providerModel: "claude-haiku-4-5" })).toBe(true);
  });

  it("tells the agent what to do instead of throwing when there is no mandate", async () => {
    const { commerceTools } = await import("@/lib/commerceTools");
    const propose = commerceTools(`nomandate-${randomUUID().slice(0, 6)}`)
      .find((t) => t.name === "commerce_propose_purchase")!;
    const out = await propose.run({ business_host: "shop.example.com", items: [{ product_id: "p1" }], summary: "x" });
    expect(out).toMatch(/no active spend mandate/);
  });
});

// ── The approval endpoint ─────────────────────────────────────────────────────

describe("POST /api/commerce/intents/<id>/decision", () => {
  async function decide(intentId: string, apiKey: string, decision: string, signature?: string) {
    const { POST } = await import("@/app/api/commerce/intents/[intentId]/decision/route");
    const { NextRequest } = await import("next/server");
    return POST(
      new NextRequest(`http://localhost/api/commerce/intents/${intentId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ decision, ...(signature ? { signature } : {}) }),
      }),
      { params: Promise.resolve({ intentId }) },
    );
  }

  // A buyer whose wallet is a real keypair, so approvals can actually be signed.
  async function signingBuyer() {
    const nacl = (await import("tweetnacl")).default;
    const { PublicKey } = await import("@solana/web3.js");
    const { createApiKey } = await import("@/lib/identity");
    const kp = nacl.sign.keyPair();
    const ownerWallet = new PublicKey(kp.publicKey).toBase58();
    const { apiKey } = createApiKey(ownerWallet);
    const agentId = `shopper-${randomUUID().slice(0, 8)}`;
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({ ownerWallet, agentId, profileId: profile.profileId, maxPerPurchase: 500, maxPerPeriod: 900 });
    return { kp, ownerWallet, apiKey, agentId };
  }

  async function sign(intentId: string, secretKey: Uint8Array) {
    const nacl = (await import("tweetnacl")).default;
    const { encodeBase64 } = await import("tweetnacl-util");
    const { mandateMessage } = await import("@/lib/commerceComplete");
    const msg = new TextEncoder().encode(mandateMessage(getPurchaseIntent(intentId)!));
    return encodeBase64(nacl.sign.detached(msg, secretKey));
  }

  it("refuses to approve without the buyer's signature", async () => {
    const { apiKey, agentId } = await signingBuyer();
    const { intent } = propose(agentId, 120);
    const res = await decide(intent.intentId, apiKey, "approve");
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/signature is required/);
    expect(getPurchaseIntent(intent.intentId)!.status).toBe("proposed");
  });

  it("records the signature and approves, then tries to place the order", async () => {
    const { apiKey, agentId, kp } = await signingBuyer();
    const { intent } = propose(agentId, 120);
    const res = await decide(intent.intentId, apiKey, "approve", await sign(intent.intentId, kp.secretKey));

    // The approval and signature stick. Without a payment credential the order
    // can't be placed — 202, not a failure: the consent is recorded and valid.
    const after = getPurchaseIntent(intent.intentId)!;
    expect(after.status).toBe("approved");
    expect(after.signed).toBe(true);
    expect(res.status).toBe(202);
    expect((await res.json() as { reason: string }).reason).toBe("NO_PAYMENT_INSTRUMENT");
  });

  it("declining needs no signature", async () => {
    const { apiKey, agentId } = await signingBuyer();
    const { intent } = propose(agentId, 120);
    const res = await decide(intent.intentId, apiKey, "decline");
    expect(res.status).toBe(200);
    expect(getPurchaseIntent(intent.intentId)!.status).toBe("declined");
  });

  it("hides someone else's purchase behind a 404 rather than a 403", async () => {
    const { createApiKey } = await import("@/lib/identity");
    const stranger = createApiKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const { agentId } = setup();
    const { intent } = propose(agentId, 60);

    const res = await decide(intent.intentId, stranger.apiKey, "approve");
    expect(res.status).toBe(404);
    expect(getPurchaseIntent(intent.intentId)!.status).toBe("proposed");
  });

  it("says plainly when the window has already closed", async () => {
    const { apiKey, agentId, kp } = await signingBuyer();
    const { intent } = propose(agentId, 60);
    const signature = await sign(intent.intentId, kp.secretKey);
    getDb().prepare("UPDATE purchase_intents SET expires_at = ? WHERE intent_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), intent.intentId);

    const res = await decide(intent.intentId, apiKey, "approve", signature);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toMatch(/expired/);
  });

  it("rejects a decision that isn't approve or decline", async () => {
    const { createApiKey } = await import("@/lib/identity");
    const { apiKey } = createApiKey("11111111111111111111111111111111");
    const res = await decide(randomUUID(), apiKey, "maybe");
    expect(res.status).toBe(400);
  });
});

// ── Signing and completion ────────────────────────────────────────────────────

describe("the mandate the buyer signs", () => {
  it("names the exact cart, price, ceiling and deadline", async () => {
    const { mandateMessage } = await import("@/lib/commerceComplete");
    const { agentId } = setup();
    const { intent } = propose(agentId, 180);
    const msg = mandateMessage(intent);

    expect(msg).toContain(intent.intentId);
    expect(msg).toContain("shop.example.com");
    expect(msg).toContain(intent.itemsHash);
    expect(msg).toContain("180.00");
    expect(msg).toContain(intent.expiresAt);
  });

  it("refuses a signature from anyone but the buyer", async () => {
    const nacl = (await import("tweetnacl")).default;
    const { encodeBase64 } = await import("tweetnacl-util");
    const { PublicKey } = await import("@solana/web3.js");
    const { attachMandate, mandateMessage } = await import("@/lib/commerceComplete");
    const { CommerceError } = await import("@/lib/commerce");

    // A buyer whose wallet is a real keypair, so a real signature can be made.
    const kp = nacl.sign.keyPair();
    const ownerWallet = new PublicKey(kp.publicKey).toBase58();
    const agentId = `shopper-${randomUUID().slice(0, 8)}`;
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({ ownerWallet, agentId, profileId: profile.profileId, maxPerPurchase: 500, maxPerPeriod: 900 });
    const { intent } = propose(agentId, 90);

    // Someone else's signature over the right message is still refused.
    const impostor = nacl.sign.keyPair();
    const msg = new TextEncoder().encode(mandateMessage(intent));
    const wrong = encodeBase64(nacl.sign.detached(msg, impostor.secretKey));
    expect(() => attachMandate(intent.intentId, wrong)).toThrow(CommerceError);

    // The buyer's own signature is accepted.
    const right = encodeBase64(nacl.sign.detached(msg, kp.secretKey));
    expect(attachMandate(intent.intentId, right).signed).toBe(true);
  });

  it("a signature for one purchase can't be replayed onto another", async () => {
    const nacl = (await import("tweetnacl")).default;
    const { encodeBase64 } = await import("tweetnacl-util");
    const { PublicKey } = await import("@solana/web3.js");
    const { attachMandate, mandateMessage } = await import("@/lib/commerceComplete");

    const kp = nacl.sign.keyPair();
    const ownerWallet = new PublicKey(kp.publicKey).toBase58();
    const agentId = `shopper-${randomUUID().slice(0, 8)}`;
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({ ownerWallet, agentId, profileId: profile.profileId, maxPerPurchase: 500, maxPerPeriod: 900 });

    const cheap = propose(agentId, 20).intent;
    const dear = propose(agentId, 400).intent;
    const sigForCheap = encodeBase64(
      nacl.sign.detached(new TextEncoder().encode(mandateMessage(cheap)), kp.secretKey),
    );
    // The message names the intent and the amount, so it doesn't transfer.
    expect(() => attachMandate(dear.intentId, sigForCheap)).toThrow(/does not match/);
  });
});

describe("completeApprovedPurchase", () => {
  it("will not place an order that the buyer never signed", async () => {
    const { completeApprovedPurchase } = await import("@/lib/commerceComplete");
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 60);
    approvePurchase(intent.intentId, ownerWallet);
    await expect(completeApprovedPurchase(intent.intentId, TEST_INSTRUMENT)).rejects.toThrow(/has not signed/);
  });

  it("will not place an order that was never approved", async () => {
    const { completeApprovedPurchase } = await import("@/lib/commerceComplete");
    const { agentId } = setup();
    const { intent } = propose(agentId, 60);
    await expect(completeApprovedPurchase(intent.intentId, TEST_INSTRUMENT)).rejects.toThrow(/not approved/);
  });

  it("is idempotent — a retry after an order exists returns it instead of buying again", async () => {
    const { completeApprovedPurchase } = await import("@/lib/commerceComplete");
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 60);
    approvePurchase(intent.intentId, ownerWallet);
    consumePurchaseIntent(intent.intentId, { orderId: "already-placed", settledAmount: 60 });

    const res = await completeApprovedPurchase(intent.intentId, TEST_INSTRUMENT);
    expect(res.orderId).toBe("already-placed");
  });

  it("keeps the checkout session from the proposal, so completion can find it", () => {
    const { agentId } = setup();
    const withSession = proposePurchase({
      agentId, businessHost: "shop.example.com", summary: "s",
      itemsHash: "b".repeat(64), amount: 25, checkoutId: "chk_123",
    });
    expect(withSession.intent.checkoutId).toBe("chk_123");
  });
});

// ── Keep or return ────────────────────────────────────────────────────────────

describe("commerceTrackRecord", () => {
  async function buy(agentId: string, ownerWallet: string, amount: number, orderStatus?: string) {
    const { intent } = propose(agentId, amount);
    approvePurchase(intent.intentId, ownerWallet);
    consumePurchaseIntent(intent.intentId, { orderId: randomUUID(), settledAmount: amount });
    if (orderStatus) {
      const { setOrderStatus } = await import("@/lib/commerce");
      setOrderStatus(intent.intentId, orderStatus);
    }
    return intent.intentId;
  }

  it("counts what the buyer kept against what they sent back", async () => {
    const { commerceTrackRecord } = await import("@/lib/commerce");
    const { agentId, ownerWallet } = setup({ maxPerPeriod: 10_000 });
    await buy(agentId, ownerWallet, 40, "delivered");
    await buy(agentId, ownerWallet, 60, "delivered");
    await buy(agentId, ownerWallet, 30, "returned");
    await buy(agentId, ownerWallet, 20); // still in flight

    const rec = commerceTrackRecord(agentId);
    expect(rec).toMatchObject({ purchases: 4, kept: 2, returned: 1, pending: 1, totalSpent: 150 });
    // Only resolved orders count — an undelivered one isn't evidence either way.
    expect(rec.keepRate).toBeCloseTo(2 / 3, 3);
  });

  it("reports no keep rate until something has actually resolved", async () => {
    const { commerceTrackRecord } = await import("@/lib/commerce");
    const { agentId, ownerWallet } = setup();
    await buy(agentId, ownerWallet, 25);
    expect(commerceTrackRecord(agentId).keepRate).toBeNull();
  });

  it("queues only orders whose fate is still unknown", async () => {
    const { intentsAwaitingOrderStatus } = await import("@/lib/commerce");
    const { agentId, ownerWallet } = setup({ maxPerPeriod: 10_000 });
    const open = await buy(agentId, ownerWallet, 15);
    const done = await buy(agentId, ownerWallet, 15, "delivered");

    const queued = intentsAwaitingOrderStatus(50).map((i) => i.intentId);
    expect(queued).toContain(open);
    expect(queued).not.toContain(done);
  });
});

// ── Proof Score ───────────────────────────────────────────────────────────────

describe("keep rate in the Proof Score", () => {
  async function agentWithPurchases(outcomes: string[]) {
    const { createAgent } = await import("@/lib/agents");
    const ownerWallet = wallet();
    const agentId = `scored-${randomUUID().slice(0, 8)}`;
    createAgent({
      agentId, name: "Scored Agent", capabilities: ["shopping"], publicKey: `pk-${agentId}`,
      walletAddress: "11111111111111111111111111111111", provider: "anthropic",
      reputation: 0, createdAt: new Date().toISOString(),
    });
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({ ownerWallet, agentId, profileId: profile.profileId, maxPerPurchase: 500, maxPerPeriod: 99_999 });
    const { setOrderStatus } = await import("@/lib/commerce");
    for (const status of outcomes) {
      const { intent } = propose(agentId, 10);
      approvePurchase(intent.intentId, ownerWallet);
      consumePurchaseIntent(intent.intentId, { orderId: randomUUID(), settledAmount: 10 });
      setOrderStatus(intent.intentId, status);
    }
    return agentId;
  }

  it("leaves an agent that has never bought anything exactly where it was", async () => {
    const { computeProofScore } = await import("@/lib/proofScore");
    const agentId = await agentWithPurchases([]);
    const proof = computeProofScore(agentId)!;
    // The component doesn't apply, so it isn't there and nothing is renormalised away.
    expect(proof.components.buyerKept).toBeUndefined();
    expect(proof.inputs.keepRate).toBeNull();
    expect(proof.components.quality.weight + proof.components.provenWork.weight).toBeCloseTo(1, 6);
  });

  it("ignores a sample too small to mean anything", async () => {
    const { computeProofScore } = await import("@/lib/proofScore");
    // One return out of two is noise, not a track record.
    const proof = computeProofScore(await agentWithPurchases(["delivered", "returned"]))!;
    expect(proof.components.buyerKept).toBeUndefined();
    expect(proof.inputs.purchasesResolved).toBe(2);
  });

  it("scores an agent whose buyers kept things above one whose buyers sent them back", async () => {
    const { computeProofScore } = await import("@/lib/proofScore");
    const good = computeProofScore(await agentWithPurchases(["delivered", "delivered", "delivered", "delivered"]))!;
    const bad = computeProofScore(await agentWithPurchases(["returned", "returned", "returned", "delivered"]))!;

    expect(good.components.buyerKept!.factor).toBe(1);
    expect(bad.components.buyerKept!.factor).toBeCloseTo(0.25, 3);
    expect(good.score).toBeGreaterThan(bad.score);
  });

  it("publishes the method so the number stays recomputable", async () => {
    const { computeProofScore } = await import("@/lib/proofScore");
    const proof = computeProofScore(await agentWithPurchases(["delivered", "delivered", "delivered"]))!;
    expect(proof.method.version).toBe("proof-score-v2");
    expect(proof.method.weights.buyerKept).toBeGreaterThan(0);
    expect(proof.method.formula).toMatch(/keepRate/);

    // The published formula must actually reproduce the published score.
    const c = proof.components;
    const sum = c.quality.weight + c.provenWork.weight + c.buyerKept!.weight;
    const recomputed = Math.round(
      (1000 * c.quality.weight * c.quality.factor) / sum +
        (1000 * c.provenWork.weight * c.provenWork.factor) / sum +
        (1000 * c.buyerKept!.weight * c.buyerKept!.factor) / sum,
    );
    expect(Math.abs(recomputed - proof.score)).toBeLessThanOrEqual(1);
  });
});

// ── Wire shapes (validated against the UCP 2026-04-08 spec) ───────────────────

describe("UCP money handling", () => {
  it("reads minor units, which is the difference between $180 and $18,000", async () => {
    const { fromMinor, toMinor } = await import("@/lib/ucp");
    // The spec sends integers in the currency's minor unit. Treating 18000 as
    // dollars would authorise a hundred times the intended amount.
    expect(fromMinor(18000, "USD")).toBe(180);
    expect(toMinor(180, "USD")).toBe(18000);
    // Zero-decimal and three-decimal currencies are not 1/100.
    expect(fromMinor(18000, "JPY")).toBe(18000);
    expect(fromMinor(18000, "KWD")).toBe(18);
    // Round-trips for anything we'd actually charge.
    for (const v of [0.01, 9.99, 180, 1234.56]) expect(fromMinor(toMinor(v, "USD"), "USD")).toBeCloseTo(v, 6);
  });
});

describe("completion requires more than a signature", () => {
  it("will not place an order without a payment credential", async () => {
    // UCP wants payment.instruments alongside ap2.checkout_mandate: signing
    // authorises the purchase, it does not pay for it.
    const { completeApprovedPurchase } = await import("@/lib/commerceComplete");
    const fn = completeApprovedPurchase as unknown as (id: string) => Promise<unknown>;
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 60);
    approvePurchase(intent.intentId, ownerWallet);
    // Called with no instrument at all — must not silently proceed.
    await expect(fn(intent.intentId)).rejects.toThrow();
  });
});

// ── Payment handler dispatch ──────────────────────────────────────────────────

describe("payment handler dispatch", () => {
  it("picks a handler Axon can actually run", async () => {
    const { supportedHandler } = await import("@/app/commerce/paymentHandlers");
    expect(supportedHandler([{ namespace: "com.google.pay", id: "h1" }])?.id).toBe("h1");
    // Offered alongside one we can't drive, the runnable one still wins.
    expect(
      supportedHandler([{ namespace: "com.example.unknown", id: "x" }, { namespace: "com.google.pay", id: "h2" }])?.id,
    ).toBe("h2");
  });

  it("says plainly when a business only offers handlers we can't drive", async () => {
    const { supportedHandler, collectPaymentInstrument, UnsupportedHandlerError } =
      await import("@/app/commerce/paymentHandlers");
    expect(supportedHandler([{ namespace: "com.example.unknown", id: "x" }])).toBeNull();

    // The buyer gets a sentence naming the handler, not a dead button.
    await expect(
      collectPaymentInstrument([{ namespace: "com.example.unknown", id: "x" }], {
        total: 10, currency: "USD", businessHost: "shop.example.com",
      }),
    ).rejects.toThrow(UnsupportedHandlerError);

    await expect(
      collectPaymentInstrument([], { total: 10, currency: "USD", businessHost: "shop.example.com" }),
    ).rejects.toThrow(/didn't offer a payment handler/);
  });
});

describe("GET /api/commerce/intents/<id>/payment", () => {
  async function ask(intentId: string, apiKey: string) {
    const { GET } = await import("@/app/api/commerce/intents/[intentId]/payment/route");
    const { NextRequest } = await import("next/server");
    return GET(
      new NextRequest(`http://localhost/api/commerce/intents/${intentId}/payment`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      }),
      { params: Promise.resolve({ intentId }) },
    );
  }

  it("hides someone else's purchase behind a 404", async () => {
    const { createApiKey } = await import("@/lib/identity");
    const stranger = createApiKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const { agentId } = setup();
    const { intent } = propose(agentId, 30);
    expect((await ask(intent.intentId, stranger.apiKey)).status).toBe(404);
  });

  it("refuses when there is no checkout session to pay for", async () => {
    const { createApiKey } = await import("@/lib/identity");
    const ownerWallet = "11111111111111111111111111111111";
    const { apiKey } = createApiKey(ownerWallet);
    const agentId = `shopper-${randomUUID().slice(0, 8)}`;
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({ ownerWallet, agentId, profileId: profile.profileId, maxPerPurchase: 500, maxPerPeriod: 900 });
    const { intent } = propose(agentId, 30); // proposed without a checkoutId
    const res = await ask(intent.intentId, apiKey);
    expect(res.status).toBe(409);
  });
});

// ── Agent identity ────────────────────────────────────────────────────────────

describe("the UCP agent profile", () => {
  it("is served at the URL every request advertises", async () => {
    // Businesses fetch this to verify our signatures. If the URL we send in the
    // UCP-Agent header 404s, identity verification fails on their side.
    const { agentProfileUrl } = await import("@/lib/ucp");
    const { GET } = await import("@/app/.well-known/ucp-agent/route");

    expect(agentProfileUrl().endsWith("/.well-known/ucp-agent")).toBe(true);
    const res = GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; capabilities: string[]; key_id: string };
    expect(body.name).toBe("Axon");
    expect(body.capabilities).toContain("dev.ucp.shopping.checkout");
    expect(body.key_id).toBeTruthy();
  });

  it("publishes a verifiable public key when one is configured, and none when not", async () => {
    const { generateKeyPairSync } = await import("crypto");
    const mod = await import("@/lib/ucp");
    const before = process.env.UCP_AGENT_PRIVATE_KEY;

    delete process.env.UCP_AGENT_PRIVATE_KEY;
    // Absent, not empty — a business can tell "unsigned" from "key we can't read".
    expect(mod.agentPublicJwk()).toBeNull();

    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.UCP_AGENT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

    const jwk = mod.agentPublicJwk()!;
    expect(jwk.kty).toBe("OKP");
    expect(jwk.alg).toBe("ed25519");
    expect(jwk.kid).toBe(mod.AGENT_KEY_ID);
    // The private half must never appear in something we publish.
    expect(jwk.d).toBeUndefined();

    if (before === undefined) delete process.env.UCP_AGENT_PRIVATE_KEY;
    else process.env.UCP_AGENT_PRIVATE_KEY = before;
  });

  it("labels the algorithm from the key rather than assuming one", async () => {
    const { generateKeyPairSync } = await import("crypto");
    const { agentSigningKey } = await import("@/lib/ucp");
    const before = process.env.UCP_AGENT_PRIVATE_KEY;

    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.UCP_AGENT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(agentSigningKey()!.alg).toBe("ed25519");

    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.UCP_AGENT_PRIVATE_KEY = ec.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(agentSigningKey()!.alg).toBe("ecdsa-p256-sha256");

    process.env.UCP_AGENT_PRIVATE_KEY = "not a key";
    expect(agentSigningKey()).toBeNull();

    if (before === undefined) delete process.env.UCP_AGENT_PRIVATE_KEY;
    else process.env.UCP_AGENT_PRIVATE_KEY = before;
  });
});

// ── Money-path ordering ───────────────────────────────────────────────────────

describe("price movement is prevented, not detected", () => {
  it("refuses to sign an intent that has already been bought", async () => {
    // A mandate is proof of ONE transaction. If it could be replaced after the
    // fact, it would prove nothing.
    const nacl = (await import("tweetnacl")).default;
    const { encodeBase64 } = await import("tweetnacl-util");
    const { PublicKey } = await import("@solana/web3.js");
    const { attachMandate, mandateMessage } = await import("@/lib/commerceComplete");

    const kp = nacl.sign.keyPair();
    const ownerWallet = new PublicKey(kp.publicKey).toBase58();
    const agentId = `shopper-${randomUUID().slice(0, 8)}`;
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({ ownerWallet, agentId, profileId: profile.profileId, maxPerPurchase: 500, maxPerPeriod: 900 });

    const { intent } = propose(agentId, 70);
    const sig = encodeBase64(nacl.sign.detached(new TextEncoder().encode(mandateMessage(intent)), kp.secretKey));
    approvePurchase(intent.intentId, ownerWallet);
    attachMandate(intent.intentId, sig);
    consumePurchaseIntent(intent.intentId, { orderId: "o1", settledAmount: 70 });

    expect(() => attachMandate(intent.intentId, sig)).toThrow(/can no longer be set/);
  });

  it("a declined intent can't be signed back to life", async () => {
    const { attachMandate } = await import("@/lib/commerceComplete");
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 40);
    declinePurchase(intent.intentId, ownerWallet);
    expect(() => attachMandate(intent.intentId, "x".repeat(88))).toThrow(/can no longer be set/);
  });
});

describe("the approval notification", () => {
  it("tells the buyer where to go", async () => {
    const { getDb } = await import("@/lib/db");
    const { createAgent } = await import("@/lib/agents");
    const ownerWallet = wallet();
    const agentId = `shopper-${randomUUID().slice(0, 8)}`;
    // A webhook needs a real registered agent to hang off.
    createAgent({
      agentId, name: "Notifier", capabilities: ["shopping"], publicKey: `pk-${agentId}`,
      walletAddress: "11111111111111111111111111111111", provider: "anthropic",
      reputation: 0, createdAt: new Date().toISOString(),
    });
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({ ownerWallet, agentId, profileId: profile.profileId, maxPerPurchase: 500, maxPerPeriod: 900 });

    // Register a webhook so the queued payload can be inspected.
    getDb().prepare(
      "INSERT INTO webhooks (webhook_id, agent_id, url, events, secret, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ).run(randomUUID(), agentId, "https://hook.example.com/x", JSON.stringify(["purchase.proposed"]), "s", new Date().toISOString());

    const { intent } = propose(agentId, 55);
    const row = getDb().prepare(
      "SELECT payload FROM webhook_deliveries WHERE event_type = 'purchase.proposed' ORDER BY created_at DESC LIMIT 1",
    ).get() as { payload: string } | undefined;

    expect(row).toBeTruthy();
    const payload = JSON.parse(row!.payload) as { data: { intentId: string; approvalUrl: string; amount: number } };
    expect(payload.data.intentId).toBe(intent.intentId);
    expect(payload.data.amount).toBe(55);
    expect(payload.data.approvalUrl).toMatch(/\/commerce$/);
  });
});

// ── Receipt rendering ─────────────────────────────────────────────────────────

describe("the receipt timeline knows every kind it can be sent", () => {
  it("has a label for purchase.completed, or the whole page throws", async () => {
    // TimelineClient does KIND_META[e.kind].dot with no fallback. A kind it
    // doesn't know white-screens the receipt — on exactly the traces worth reading.
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/app/r/[taskId]/TimelineClient.tsx", "utf8");
    const { getDb } = await import("@/lib/db");

    // Every kind the backend can actually write must be renderable.
    const kinds = ["task.created", "step.model", "tool.call", "purchase.completed",
      "progress", "task.completed", "task.failed", "settlement.completed"];
    for (const k of kinds) expect(src).toContain(`"${k}"`);
    expect(getDb()).toBeTruthy();
  });
});

// ── Erasure ───────────────────────────────────────────────────────────────────

describe("forgetting a buyer's details", () => {
  it("scrubs the personal data, revokes spending, and keeps the ledger", async () => {
    const { forgetCommerceProfile, getCommerceProfilePrivate, spendSummary } = await import("@/lib/commerce");
    const { getDb } = await import("@/lib/db");
    const { agentId, ownerWallet, profile } = setup();

    const done = propose(agentId, 45).intent;
    approvePurchase(done.intentId, ownerWallet);
    consumePurchaseIntent(done.intentId, { orderId: "o", settledAmount: 45 });

    expect(forgetCommerceProfile(profile.profileId, ownerWallet)).toBe(true);

    // The address is gone from storage entirely, not just hidden.
    const raw = JSON.stringify(getDb().prepare("SELECT * FROM commerce_profiles WHERE profile_id = ?").get(profile.profileId));
    expect(raw).not.toContain("Analytical Way");
    expect(getCommerceProfilePrivate(profile.profileId)!.address).toEqual({});

    // Spending stops…
    expect(getActiveMandate(agentId)).toBeNull();
    expect(() => propose(agentId, 10)).toThrow(/no active spend mandate/);
    // …but the buyer's own record of what they bought survives.
    expect(spendSummary(ownerWallet).purchased).toBe(1);
  });

  it("can't erase someone else's profile, and won't erase twice", async () => {
    const { forgetCommerceProfile } = await import("@/lib/commerce");
    const { ownerWallet, profile } = setup();
    expect(forgetCommerceProfile(profile.profileId, wallet())).toBe(false);
    expect(forgetCommerceProfile(profile.profileId, ownerWallet)).toBe(true);
    expect(forgetCommerceProfile(profile.profileId, ownerWallet)).toBe(false);
  });
});

describe("spendSummary currency", () => {
  it("reports the currency actually spent, not an assumed one", async () => {
    const { spendSummary, proposePurchase } = await import("@/lib/commerce");
    const ownerWallet = wallet();
    const agentId = `eur-${randomUUID().slice(0, 8)}`;
    const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
    createSpendMandate({
      ownerWallet, agentId, profileId: profile.profileId,
      maxPerPurchase: 500, maxPerPeriod: 900, currency: "EUR",
    });
    proposePurchase({
      agentId, businessHost: "shop.example.com", summary: "s",
      itemsHash: "c".repeat(64), amount: 30, currency: "EUR",
    });
    expect(spendSummary(ownerWallet).currency).toBe("EUR");
  });
});

// ── Refresh scoping ───────────────────────────────────────────────────────────

describe("order-status refresh reaches the right buyer", () => {
  it("scopes to the owner in SQL, not after a global window", async () => {
    const { intentsAwaitingOrderStatus, setOrderStatus } = await import("@/lib/commerce");

    async function buyerWithUnresolved(count: number) {
      const ownerWallet = wallet();
      const agentId = `q-${randomUUID().slice(0, 8)}`;
      const profile = createCommerceProfile({ ownerWallet, label: "H", contact: CONTACT, address: ADDRESS });
      createSpendMandate({ ownerWallet, agentId, profileId: profile.profileId, maxPerPurchase: 500, maxPerPeriod: 99_999 });
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const { intent } = propose(agentId, 5);
        approvePurchase(intent.intentId, ownerWallet);
        consumePurchaseIntent(intent.intentId, { orderId: randomUUID(), settledAmount: 5 });
        ids.push(intent.intentId);
      }
      return { ownerWallet, ids };
    }

    // A noisy neighbour with more unresolved orders than any window we'd fetch.
    const noisy = await buyerWithUnresolved(12);
    const quiet = await buyerWithUnresolved(1);

    // Unscoped, the quiet buyer's order is buried behind the noisy one's.
    expect(intentsAwaitingOrderStatus(5).some((i) => i.intentId === quiet.ids[0])).toBe(false);
    // Scoped, it's the only thing returned — which is what the dashboard asks for.
    const mine = intentsAwaitingOrderStatus(5, quiet.ownerWallet);
    expect(mine.map((i) => i.intentId)).toEqual(quiet.ids);
    expect(mine.every((i) => i.ownerWallet === quiet.ownerWallet)).toBe(true);

    // Resolved orders drop out of the queue for that owner.
    setOrderStatus(quiet.ids[0], "delivered");
    expect(intentsAwaitingOrderStatus(5, quiet.ownerWallet)).toHaveLength(0);
    expect(noisy.ids.length).toBe(12);
  });
});

describe("public API surfaces", () => {
  it("documents the commerce endpoints and their schemas", async () => {
    const { readFileSync } = await import("fs");
    const spec = readFileSync("src/app/api/openapi/route.ts", "utf8");
    for (const path of ["/commerce/profiles", "/commerce/mandates", "/commerce/intents", "/commerce/kill"]) {
      expect(spec).toContain(`"${path}"`);
    }
    // No $ref may point at a schema that isn't defined.
    for (const schema of ["CommerceProfile", "SpendMandate", "PurchaseIntent"]) {
      expect(spec).toContain(`${schema}: {`);
    }
  });

  it("lists purchase.completed among the trace event kinds", async () => {
    const { readFileSync } = await import("fs");
    expect(readFileSync("src/app/llms-full.txt/route.ts", "utf8")).toContain("purchase.completed");
  });
});

// ── Setup is reachable ────────────────────────────────────────────────────────

describe("a new buyer can get set up without touching the API", () => {
  it("the purchases page can create both prerequisites", async () => {
    // Granting `commerce` in the publish wizard is a UI flow; if the only way to
    // add a profile and a budget were curl, the grant would be a dead end.
    const { readFileSync } = await import("fs");
    const ui = readFileSync("src/app/commerce/CommerceClient.tsx", "utf8");
    expect(ui).toContain("/api/commerce/profiles");
    expect(ui).toContain("/api/commerce/mandates");
    // …and revoke what's been handed out.
    expect(ui).toContain("/api/commerce/mandates?id=");
  });

  it("the wizard's commerce grant and the mandate route agree on the grant name", async () => {
    const { readFileSync } = await import("fs");
    const wizard = readFileSync("src/app/publish/PublishWizard.tsx", "utf8");
    const route = readFileSync("src/app/api/commerce/mandates/route.ts", "utf8");
    // The route refuses a budget for an agent without the grant, so the string
    // the wizard writes has to be the string the route checks.
    expect(wizard).toContain('grant: "commerce"');
    expect(route).toContain('tools?.includes("commerce")');
  });
});

// ── Budget integrity ──────────────────────────────────────────────────────────

describe("a budget can't be overspent by proposing twice", () => {
  it("counts approved-but-uncharged spend against the period budget", async () => {
    const { committedInPeriod } = await import("@/lib/commerce");
    const { agentId, ownerWallet } = setup({ maxPerPurchase: 100, maxPerPeriod: 100 });

    const first = propose(agentId, 60).intent;
    // Nothing is charged yet, but this is money the buyer has agreed to.
    approvePurchase(first.intentId, ownerWallet);
    expect(committedInPeriod(getActiveMandate(agentId)!)).toBe(60);

    // The second proposal has to see that commitment, or two £60 purchases fit
    // inside a £100 budget.
    expect(() => propose(agentId, 60)).toThrow(/per-month budget/);
    // …and something that genuinely fits still goes through.
    expect(propose(agentId, 40).intent.status).toBe("proposed");
  });

  it("excludes the intent being charged from its own budget check", async () => {
    const { committedInPeriod } = await import("@/lib/commerce");
    const { agentId, ownerWallet } = setup({ maxPerPurchase: 100, maxPerPeriod: 100 });
    const only = propose(agentId, 90).intent;
    approvePurchase(only.intentId, ownerWallet);

    // Counting itself would make every purchase look like a double-spend.
    expect(committedInPeriod(getActiveMandate(agentId)!, only.intentId)).toBe(0);
    expect(committedInPeriod(getActiveMandate(agentId)!)).toBe(90);
  });

  it("a declined proposal frees the budget back up", async () => {
    const { committedInPeriod } = await import("@/lib/commerce");
    const { agentId, ownerWallet } = setup({ maxPerPurchase: 100, maxPerPeriod: 100 });
    const a = propose(agentId, 80).intent;
    approvePurchase(a.intentId, ownerWallet);
    expect(() => propose(agentId, 50)).toThrow(/per-month budget/);

    declinePurchase(a.intentId, ownerWallet);
    expect(committedInPeriod(getActiveMandate(agentId)!)).toBe(0);
    expect(propose(agentId, 50).intent.status).toBe("proposed");
  });

  it("actual spend still reports only what was really charged", async () => {
    const { agentId, ownerWallet } = setup({ maxPerPurchase: 100, maxPerPeriod: 200 });
    const a = propose(agentId, 70).intent;
    approvePurchase(a.intentId, ownerWallet);
    // Committed, not spent — the two numbers mean different things.
    expect(spentInPeriod(getActiveMandate(agentId)!)).toBe(0);
    consumePurchaseIntent(a.intentId, { orderId: "o", settledAmount: 70 });
    expect(spentInPeriod(getActiveMandate(agentId)!)).toBe(70);
  });
});

// ── The completion boundary ───────────────────────────────────────────────────

describe("completion refuses to start work it can't finish safely", () => {
  it("won't begin a purchase that could expire mid-charge", async () => {
    const { completeApprovedPurchase } = await import("@/lib/commerceComplete");
    const { getDb } = await import("@/lib/db");
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 50);
    approvePurchase(intent.intentId, ownerWallet);

    // Still valid — but only just. Completion makes several calls to someone
    // else's server; starting here risks a real charge against an intent that
    // expires before it can be redeemed.
    getDb().prepare("UPDATE purchase_intents SET expires_at = ? WHERE intent_id = ?")
      .run(new Date(Date.now() + 20_000).toISOString(), intent.intentId);

    await expect(completeApprovedPurchase(intent.intentId, TEST_INSTRUMENT)).rejects.toThrow(/about to expire/);
    // The approval is untouched, so it can simply be approved again.
    expect(getPurchaseIntent(intent.intentId)!.status).toBe("approved");
  });

  it("still refuses one that has actually expired", async () => {
    const { completeApprovedPurchase } = await import("@/lib/commerceComplete");
    const { getDb } = await import("@/lib/db");
    const { agentId, ownerWallet } = setup();
    const { intent } = propose(agentId, 50);
    approvePurchase(intent.intentId, ownerWallet);
    getDb().prepare("UPDATE purchase_intents SET expires_at = ? WHERE intent_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), intent.intentId);

    await expect(completeApprovedPurchase(intent.intentId, TEST_INSTRUMENT)).rejects.toThrow(/has expired/);
  });
});

describe("a ceiling only means something in its own currency", () => {
  it("treats a re-price in another currency as a refusal, not a comparison", async () => {
    // 200 USD approved, business now quotes 150 in a currency worth ~2.7x the
    // dollar. Comparing the bare numbers says 150 < 200 and charges ~400 USD.
    const { fromMinor } = await import("@/lib/ucp");
    const approvedCeiling = 200;
    const liveTotalInHeavierCurrency = fromMinor(150_000, "BHD"); // 150 BHD
    expect(liveTotalInHeavierCurrency).toBe(150);
    expect(liveTotalInHeavierCurrency < approvedCeiling).toBe(true); // the trap

    // So the currencies have to match before any comparison is meaningful.
    const { readFileSync } = await import("fs");
    const src = readFileSync("src/lib/commerceComplete.ts", "utf8");
    expect(src).toContain("CURRENCY_CHANGED");
    expect(src.indexOf("CURRENCY_CHANGED")).toBeLessThan(src.indexOf("live.total > intent.maxAmount"));
  });
});


describe("a purchase waiting on you is never hidden behind newer ones", () => {
  it("finds a pending purchase older than a full page of decided ones", () => {
    const { agentId, ownerWallet } = setup({ maxPerPeriod: 100_000 });

    // The one that matters, proposed first.
    const waiting = propose(agentId, 10).intent;

    // Then a full page of purchases that have already been decided.
    const decided: string[] = [];
    for (let i = 0; i < 60; i++) decided.push(propose(agentId, 1).intent.intentId);
    getDb()
      .prepare(`UPDATE purchase_intents SET status = 'purchased' WHERE intent_id IN (${decided.map(() => "?").join(",")})`)
      .run(...decided);

    // Filtering the page instead of the table loses it entirely: the 50 newest
    // rows are all decided, so the owner is shown nothing to approve.
    const page = listPurchaseIntents(ownerWallet, 50);
    expect(page.filter((i) => i.status === "proposed")).toHaveLength(0);

    // Filtering in SQL finds it.
    const pending = listPurchaseIntents(ownerWallet, 50, "proposed");
    expect(pending.map((i) => i.intentId)).toContain(waiting.intentId);
  });
});
