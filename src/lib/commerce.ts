// Real-world purchasing — the authorization layer.
//
// An agent granted "commerce" can shop and check out over UCP. This module is
// everything that has to be true before money actually leaves: whose details the
// goods go to, how much that agent is allowed to spend, and what exactly a human
// approved. The UCP wire protocol lives in ./ucp; this file is the part that
// says yes or no.
//
// Three invariants it exists to hold:
//   1. A purchase intent is SINGLE-USE. A retried task cannot buy twice.
//   2. An approval binds to a ceiling and expires. Approving "$180" cannot settle
//      at $210, and cannot be redeemed tomorrow.
//   3. Buyer PII never leaves this module in the clear, and never reaches a trace.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { encrypt, decrypt } from "./crypto";
import { logger } from "./logger";
import { queueWebhookEvent } from "./webhooks";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommerceContact {
  name: string;
  email: string;
  phone?: string;
}

export interface CommerceAddress {
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
}

export interface CommerceProfile {
  profileId: string;
  ownerWallet: string;
  label: string;
  status: "active" | "frozen" | "deleted";
  paymentHandler?: string;
  createdAt: string;
  updatedAt: string;
}

/** The profile plus its decrypted PII. Never serialize this to a trace or a receipt. */
export interface CommerceProfilePrivate extends CommerceProfile {
  contact: CommerceContact;
  address: CommerceAddress;
}

export type MandatePeriod = "day" | "week" | "month";

export interface SpendMandate {
  mandateId: string;
  ownerWallet: string;
  agentId: string;
  profileId: string;
  maxPerPurchase: number;
  maxPerPeriod: number;
  period: MandatePeriod;
  currency: string;
  autoApproveUnder: number;
  allowedHosts?: string[];
  status: "active" | "revoked";
  expiresAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export type IntentStatus = "proposed" | "approved" | "purchased" | "declined" | "expired" | "failed";

export interface PurchaseIntent {
  intentId: string;
  taskId?: string;
  agentId: string;
  ownerWallet: string;
  mandateId: string;
  profileId: string;
  businessHost: string;
  summary: string;
  itemsHash: string;
  amount: number;
  maxAmount: number;
  currency: string;
  status: IntentStatus;
  checkoutId?: string;
  orderId?: string;
  orderStatus?: string;
  failure?: string;
  expiresAt: string;
  createdAt: string;
  decidedAt?: string;
  purchasedAt?: string;
  /** True once the buyer has signed. The signature itself is never returned. */
  signed?: boolean;
  /** Within the mandate's auto-approve threshold: no decision needed, but the
   *  buyer still signs it. AP2 has no way to consent to a purchase in advance. */
  preCleared?: boolean;
}

/** How long an approval stays redeemable. Prices and stock move; consent shouldn't outlive them. */
export const INTENT_TTL_MS = 30 * 60 * 1000;

// ── Row mapping ───────────────────────────────────────────────────────────────

interface ProfileRow {
  profile_id: string; owner_wallet: string; label: string; contact_enc: string; address_enc: string;
  payment_handler: string | null; status: string; created_at: string; updated_at: string;
}
interface MandateRow {
  mandate_id: string; owner_wallet: string; agent_id: string; profile_id: string;
  max_per_purchase: number; max_per_period: number; period: string; currency: string;
  auto_approve_under: number; allowed_hosts: string | null; status: string;
  expires_at: string | null; created_at: string; revoked_at: string | null;
}
interface IntentRow {
  intent_id: string; task_id: string | null; agent_id: string; owner_wallet: string;
  mandate_id: string; profile_id: string; business_host: string; summary: string; items_hash: string;
  amount: number; max_amount: number; currency: string; status: string; checkout_id: string | null;
  order_id: string | null; order_status: string | null; failure: string | null;
  expires_at: string; created_at: string; decided_at: string | null; purchased_at: string | null;
  mandate_message: string | null; mandate_signature: string | null;
  pre_cleared: number;
}

const toProfile = (r: ProfileRow): CommerceProfile => ({
  profileId: r.profile_id, ownerWallet: r.owner_wallet, label: r.label,
  status: r.status as CommerceProfile["status"], paymentHandler: r.payment_handler ?? undefined,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const toMandate = (r: MandateRow): SpendMandate => ({
  mandateId: r.mandate_id, ownerWallet: r.owner_wallet, agentId: r.agent_id, profileId: r.profile_id,
  maxPerPurchase: r.max_per_purchase, maxPerPeriod: r.max_per_period, period: r.period as MandatePeriod,
  currency: r.currency, autoApproveUnder: r.auto_approve_under,
  allowedHosts: r.allowed_hosts ? (JSON.parse(r.allowed_hosts) as string[]) : undefined,
  status: r.status as SpendMandate["status"], expiresAt: r.expires_at ?? undefined,
  createdAt: r.created_at, revokedAt: r.revoked_at ?? undefined,
});
const toIntent = (r: IntentRow): PurchaseIntent => ({
  intentId: r.intent_id, taskId: r.task_id ?? undefined, agentId: r.agent_id, ownerWallet: r.owner_wallet,
  mandateId: r.mandate_id, profileId: r.profile_id, businessHost: r.business_host, summary: r.summary,
  itemsHash: r.items_hash, amount: r.amount, maxAmount: r.max_amount, currency: r.currency,
  status: r.status as IntentStatus, checkoutId: r.checkout_id ?? undefined,
  orderId: r.order_id ?? undefined, orderStatus: r.order_status ?? undefined,
  failure: r.failure ?? undefined, expiresAt: r.expires_at, createdAt: r.created_at,
  decidedAt: r.decided_at ?? undefined, purchasedAt: r.purchased_at ?? undefined,
  signed: Boolean(r.mandate_signature),
  preCleared: r.pre_cleared === 1,
});

// ── Profiles ──────────────────────────────────────────────────────────────────

export function createCommerceProfile(opts: {
  ownerWallet: string; label: string; contact: CommerceContact; address: CommerceAddress;
}): CommerceProfile {
  const profileId = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO commerce_profiles (profile_id, owner_wallet, label, contact_enc, address_enc, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(profileId, opts.ownerWallet, opts.label.trim(), encrypt(JSON.stringify(opts.contact)), encrypt(JSON.stringify(opts.address)), now, now);
  void syncToTurso();
  return getCommerceProfile(profileId)!;
}

/** Public shape — safe to return from an API. Carries no PII. */
export function getCommerceProfile(profileId: string): CommerceProfile | null {
  const r = getDb().prepare("SELECT * FROM commerce_profiles WHERE profile_id = ?").get(profileId) as ProfileRow | undefined;
  return r ? toProfile(r) : null;
}

/**
 * Profile WITH decrypted contact and address. Only the UCP checkout call should
 * reach for this, and its result must never be logged, traced, or returned to an
 * agent — the agent is granted the capability, not the details.
 */
export function getCommerceProfilePrivate(profileId: string): CommerceProfilePrivate | null {
  const r = getDb().prepare("SELECT * FROM commerce_profiles WHERE profile_id = ?").get(profileId) as ProfileRow | undefined;
  if (!r) return null;
  return {
    ...toProfile(r),
    contact: JSON.parse(decrypt(r.contact_enc)) as CommerceContact,
    address: JSON.parse(decrypt(r.address_enc)) as CommerceAddress,
  };
}

/**
 * Forget a buyer's details. Scrubs the encrypted contact and address and retires
 * the profile, but deliberately KEEPS the purchase records — those carry no
 * personal data (business, amount, summary) and are the buyer's own ledger.
 * Erasing personal data and destroying someone's spend history are different
 * asks, and only the first one was made.
 */
export function forgetCommerceProfile(profileId: string, ownerWallet: string): boolean {
  const now = new Date().toISOString();
  const changed = getDb().prepare(
    `UPDATE commerce_profiles
     SET contact_enc = ?, address_enc = ?, status = 'deleted', updated_at = ?
     WHERE profile_id = ? AND owner_wallet = ? AND status != 'deleted'`,
  ).run(encrypt("{}"), encrypt("{}"), now, profileId, ownerWallet).changes;

  if (changed > 0) {
    // A retired profile must not be spendable against.
    getDb().prepare(
      "UPDATE spend_mandates SET status = 'revoked', revoked_at = ? WHERE profile_id = ? AND status = 'active'",
    ).run(now, profileId);
    void syncToTurso();
    logger.info("commerce.profile_forgotten", "Buyer details erased; purchase history retained", { profileId });
  }
  return changed > 0;
}

export function listCommerceProfiles(ownerWallet: string): CommerceProfile[] {
  const rows = getDb().prepare("SELECT * FROM commerce_profiles WHERE owner_wallet = ? ORDER BY created_at DESC").all(ownerWallet) as ProfileRow[];
  return rows.map(toProfile);
}

// ── Mandates ──────────────────────────────────────────────────────────────────

export function createSpendMandate(opts: {
  ownerWallet: string; agentId: string; profileId: string;
  maxPerPurchase: number; maxPerPeriod: number; period?: MandatePeriod;
  currency?: string; autoApproveUnder?: number; allowedHosts?: string[]; expiresAt?: string;
}): SpendMandate {
  const profile = getCommerceProfile(opts.profileId);
  if (!profile) throw new Error(`commerce profile '${opts.profileId}' not found`);
  if (profile.ownerWallet !== opts.ownerWallet) throw new Error("profile belongs to a different owner");

  const mandateId = randomUUID();
  getDb().prepare(
    `INSERT INTO spend_mandates (mandate_id, owner_wallet, agent_id, profile_id, max_per_purchase, max_per_period,
       period, currency, auto_approve_under, allowed_hosts, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    mandateId, opts.ownerWallet, opts.agentId, opts.profileId,
    opts.maxPerPurchase, opts.maxPerPeriod, opts.period ?? "month", opts.currency ?? "USD",
    opts.autoApproveUnder ?? 0, opts.allowedHosts?.length ? JSON.stringify(opts.allowedHosts) : null,
    opts.expiresAt ?? null, new Date().toISOString(),
  );
  void syncToTurso();
  return getSpendMandate(mandateId)!;
}

export function getSpendMandate(mandateId: string): SpendMandate | null {
  const r = getDb().prepare("SELECT * FROM spend_mandates WHERE mandate_id = ?").get(mandateId) as MandateRow | undefined;
  return r ? toMandate(r) : null;
}

/** The live mandate an agent may spend under, if any. Expiry is checked here, not by a sweeper. */
export function getActiveMandate(agentId: string): SpendMandate | null {
  const rows = getDb().prepare(
    "SELECT * FROM spend_mandates WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC",
  ).all(agentId) as MandateRow[];
  const now = new Date().toISOString();
  for (const r of rows) {
    if (r.expires_at && r.expires_at <= now) continue;
    return toMandate(r);
  }
  return null;
}

export function listSpendMandates(ownerWallet: string): SpendMandate[] {
  const rows = getDb().prepare("SELECT * FROM spend_mandates WHERE owner_wallet = ? ORDER BY created_at DESC").all(ownerWallet) as MandateRow[];
  return rows.map(toMandate);
}

export function revokeSpendMandate(mandateId: string): boolean {
  const changed = getDb().prepare(
    "UPDATE spend_mandates SET status = 'revoked', revoked_at = ? WHERE mandate_id = ? AND status = 'active'",
  ).run(new Date().toISOString(), mandateId).changes;
  void syncToTurso();
  return changed > 0;
}

/**
 * Stop everything, now. Revokes every mandate this owner holds and voids intents
 * that haven't been redeemed. With real money in play this is table stakes: one
 * control that means "my agent stops spending", not a per-mandate cleanup job.
 */
export function killSwitch(ownerWallet: string): { mandatesRevoked: number; intentsVoided: number } {
  const db = getDb();
  const now = new Date().toISOString();
  let mandatesRevoked = 0, intentsVoided = 0;
  db.transaction(() => {
    mandatesRevoked = db.prepare(
      "UPDATE spend_mandates SET status = 'revoked', revoked_at = ? WHERE owner_wallet = ? AND status = 'active'",
    ).run(now, ownerWallet).changes;
    intentsVoided = db.prepare(
      "UPDATE purchase_intents SET status = 'declined', decided_at = ?, failure = 'killed by owner' WHERE owner_wallet = ? AND status IN ('proposed','approved')",
    ).run(now, ownerWallet).changes;
    db.prepare("UPDATE commerce_profiles SET status = 'frozen', updated_at = ? WHERE owner_wallet = ?").run(now, ownerWallet);
  })();
  void syncToTurso();
  logger.warn("commerce.kill_switch", "Owner halted all agent spending", { ownerWallet, mandatesRevoked, intentsVoided });
  return { mandatesRevoked, intentsVoided };
}

// ── Spend accounting ──────────────────────────────────────────────────────────

function periodStart(period: MandatePeriod, now = new Date()): string {
  const d = new Date(now);
  if (period === "day") d.setUTCHours(0, 0, 0, 0);
  else if (period === "week") { const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); d.setUTCHours(0, 0, 0, 0); }
  else { d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); }
  return d.toISOString();
}

/** What this mandate has actually spent in the current period — purchased only. */
export function spentInPeriod(mandate: SpendMandate): number {
  const row = getDb().prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM purchase_intents WHERE mandate_id = ? AND status = 'purchased' AND purchased_at >= ?",
  ).get(mandate.mandateId, periodStart(mandate.period)) as { total: number };
  return Math.round(row.total * 100) / 100;
}

/**
 * Spend that is already COMMITTED this period — bought, or approved and on its
 * way. Budget checks use this rather than spentInPeriod, because an approval is
 * money the buyer has already agreed to part with.
 *
 * Counting only completed purchases let two proposals each pass a check while
 * neither had been charged yet, and a £100 budget then spend £120. `exclude`
 * lets the completion path re-check without counting the very intent it is about
 * to charge.
 */
export function committedInPeriod(mandate: SpendMandate, excludeIntentId?: string): number {
  const start = periodStart(mandate.period);
  const row = getDb().prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM purchase_intents
     WHERE mandate_id = ? AND status IN ('purchased','approved')
       AND COALESCE(purchased_at, created_at) >= ?
       AND intent_id IS NOT ?`,
  ).get(mandate.mandateId, start, excludeIntentId ?? null) as { total: number };
  return Math.round(row.total * 100) / 100;
}

// ── Purchase intents ──────────────────────────────────────────────────────────

export interface ProposeResult {
  intent: PurchaseIntent;
  /** Within the mandate's threshold: the buyer needn't decide, only sign. */
  preCleared: boolean;
}

export class CommerceError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CommerceError";
  }
}

/**
 * Propose a purchase. Every spend rule is enforced here, before anything is
 * redeemable — mandate liveness, per-purchase cap, remaining period budget, and
 * the business allowlist. Under the mandate's auto-approve threshold it lands
 * already approved; otherwise it waits for a human.
 */
export function proposePurchase(opts: {
  agentId: string; taskId?: string; businessHost: string; summary: string;
  itemsHash: string; amount: number; currency?: string;
  /** The open UCP checkout session this proposal prices. Completion needs it. */
  checkoutId?: string;
}): ProposeResult {
  const mandate = getActiveMandate(opts.agentId);
  if (!mandate) throw new CommerceError(`agent '${opts.agentId}' has no active spend mandate`, "NO_MANDATE");

  const profile = getCommerceProfile(mandate.profileId);
  if (!profile || profile.status !== "active") {
    throw new CommerceError("the buyer's commerce profile is frozen or missing", "PROFILE_UNAVAILABLE");
  }

  const currency = opts.currency ?? mandate.currency;
  if (currency !== mandate.currency) {
    throw new CommerceError(`mandate is denominated in ${mandate.currency}, not ${currency}`, "CURRENCY_MISMATCH");
  }
  if (!(opts.amount > 0)) throw new CommerceError("purchase amount must be positive", "BAD_AMOUNT");
  if (opts.amount > mandate.maxPerPurchase) {
    throw new CommerceError(
      `${opts.amount} ${currency} exceeds the per-purchase cap of ${mandate.maxPerPurchase}`, "OVER_PER_PURCHASE_CAP",
    );
  }
  const committed = committedInPeriod(mandate);
  if (committed + opts.amount > mandate.maxPerPeriod) {
    throw new CommerceError(
      `this would spend ${(committed + opts.amount).toFixed(2)} of a ${mandate.maxPerPeriod} ${currency} per-${mandate.period} budget`,
      "OVER_PERIOD_BUDGET",
    );
  }
  if (mandate.allowedHosts?.length && !mandate.allowedHosts.includes(opts.businessHost)) {
    throw new CommerceError(`'${opts.businessHost}' is not in this mandate's allowed businesses`, "HOST_NOT_ALLOWED");
  }

  // Under the owner's own threshold (0 unless they raised it) this purchase
  // needs no decision from them. It still needs their signature — AP2 has no
  // notion of consenting to a specific purchase before it exists, so an intent
  // that skipped to 'approved' here could never actually be completed.
  const preCleared = mandate.autoApproveUnder > 0 && opts.amount <= mandate.autoApproveUnder;
  const now = new Date();
  const intentId = randomUUID();

  getDb().prepare(
    `INSERT INTO purchase_intents (intent_id, task_id, agent_id, owner_wallet, mandate_id, profile_id,
       business_host, summary, items_hash, amount, max_amount, currency, status, checkout_id, pre_cleared, expires_at, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    intentId, opts.taskId ?? null, opts.agentId, mandate.ownerWallet, mandate.mandateId, mandate.profileId,
    opts.businessHost, opts.summary.slice(0, 2000), opts.itemsHash,
    opts.amount, opts.amount, currency,
    "proposed",
    opts.checkoutId ?? null,
    preCleared ? 1 : 0,
    new Date(now.getTime() + INTENT_TTL_MS).toISOString(),
    now.toISOString(),
    null,
  );
  void syncToTurso();
  const intent = getPurchaseIntent(intentId)!;
  // Tell the buyer something is waiting on them. Per-agent webhook, never a
  // broadcast channel — one buyer's purchases are nobody else's business.
  try {
    // Always "proposed": nothing has been bought at this point, and a
    // pre-cleared purchase is still waiting on the buyer's signature.
    queueWebhookEvent(opts.agentId, "purchase.proposed", {
      intentId: intent.intentId,
      agentId: intent.agentId,
      businessHost: intent.businessHost,
      summary: intent.summary,
      amount: intent.amount,
      currency: intent.currency,
      expiresAt: intent.expiresAt,
      preCleared,
      // Where to go and decide. A time-limited approval whose notification
      // doesn't say where to approve is a notification that expires unread.
      approvalUrl: `${(process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://axon-agents.com").replace(/\/$/, "")}/commerce`,
    });
  } catch (err) {
    logger.warn("commerce.notify_failed", "Could not queue the purchase webhook", { err, intentId });
  }
  return { intent, preCleared };
}

export function getPurchaseIntent(intentId: string): PurchaseIntent | null {
  const r = getDb().prepare("SELECT * FROM purchase_intents WHERE intent_id = ?").get(intentId) as IntentRow | undefined;
  return r ? toIntent(r) : null;
}

export function listPurchaseIntents(
  ownerWallet: string,
  limit = 50,
  status?: string,
): PurchaseIntent[] {
  // Filter in SQL, not after. Taking the newest N and *then* keeping the ones
  // that match hides an older purchase still waiting on its owner behind newer
  // decided ones — and a purchase you are never shown is one you can never
  // approve.
  const rows = status
    ? (getDb().prepare(
        "SELECT * FROM purchase_intents WHERE owner_wallet = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
      ).all(ownerWallet, status, limit) as IntentRow[])
    : (getDb().prepare(
        "SELECT * FROM purchase_intents WHERE owner_wallet = ? ORDER BY created_at DESC LIMIT ?",
      ).all(ownerWallet, limit) as IntentRow[]);
  return rows.map(toIntent);
}

/** Approve a pending intent. Only from 'proposed', and only before it expires. */
export function approvePurchase(intentId: string, ownerWallet: string): PurchaseIntent | null {
  const now = new Date().toISOString();
  const changed = getDb().prepare(
    `UPDATE purchase_intents SET status = 'approved', decided_at = ?
     WHERE intent_id = ? AND owner_wallet = ? AND status = 'proposed' AND expires_at > ?`,
  ).run(now, intentId, ownerWallet, now).changes;
  void syncToTurso();
  return changed > 0 ? getPurchaseIntent(intentId) : null;
}

export function declinePurchase(intentId: string, ownerWallet: string): PurchaseIntent | null {
  const now = new Date().toISOString();
  const changed = getDb().prepare(
    `UPDATE purchase_intents SET status = 'declined', decided_at = ?
     WHERE intent_id = ? AND owner_wallet = ? AND status IN ('proposed','approved')`,
  ).run(now, intentId, ownerWallet).changes;
  void syncToTurso();
  return changed > 0 ? getPurchaseIntent(intentId) : null;
}

/**
 * Redeem an approved intent — the single-use gate, and the reason a retried task
 * can't buy twice. The status flip and the order record happen in ONE conditional
 * UPDATE, so two concurrent callers cannot both win. Returns null if this intent
 * was already spent, declined, or has expired.
 *
 * `settledAmount` is checked against the approved ceiling: a checkout that came
 * back dearer than what the human agreed to is refused, not quietly completed.
 */
export function consumePurchaseIntent(
  intentId: string,
  order: { orderId: string; checkoutId?: string; settledAmount: number },
): PurchaseIntent | null {
  const now = new Date().toISOString();
  const intent = getPurchaseIntent(intentId);
  if (!intent) return null;
  if (order.settledAmount > intent.maxAmount) {
    failPurchaseIntent(intentId, `settled ${order.settledAmount} above the approved ceiling ${intent.maxAmount}`);
    return null;
  }
  const changed = getDb().prepare(
    `UPDATE purchase_intents SET status = 'purchased', order_id = ?, checkout_id = ?, amount = ?, purchased_at = ?
     WHERE intent_id = ? AND status = 'approved' AND expires_at > ?`,
  ).run(order.orderId, order.checkoutId ?? null, order.settledAmount, now, intentId, now).changes;
  void syncToTurso();
  if (changed === 0) return null;
  logger.info("commerce.purchased", "Purchase completed against an approved intent", {
    intentId, agentId: intent.agentId, businessHost: intent.businessHost, amount: order.settledAmount,
  });
  return getPurchaseIntent(intentId);
}

export function failPurchaseIntent(intentId: string, reason: string): void {
  getDb().prepare(
    "UPDATE purchase_intents SET status = 'failed', failure = ?, decided_at = ? WHERE intent_id = ? AND status IN ('proposed','approved')",
  ).run(reason.slice(0, 500), new Date().toISOString(), intentId);
  void syncToTurso();
}

/** Post-purchase state from UCP order management (shipped, delivered, returned). */
export function setOrderStatus(intentId: string, orderStatus: string): void {
  getDb().prepare("UPDATE purchase_intents SET order_status = ? WHERE intent_id = ?").run(orderStatus, intentId);
  void syncToTurso();
}

/** Sweep intents nobody acted on. Cheap to call; safe to call often. */
export function expireStaleIntents(): number {
  const changed = getDb().prepare(
    "UPDATE purchase_intents SET status = 'expired' WHERE status IN ('proposed','approved') AND expires_at <= ?",
  ).run(new Date().toISOString()).changes;
  if (changed > 0) void syncToTurso();
  return changed;
}

/** What an owner's agents have actually spent — the statement behind the approvals. */
export function spendSummary(ownerWallet: string): {
  purchased: number; totalSpent: number; pending: number; currency: string;
} {
  const row = getDb().prepare(
    `SELECT COUNT(*) FILTER (WHERE status = 'purchased') AS purchased,
            COALESCE(SUM(amount) FILTER (WHERE status = 'purchased'), 0) AS total,
            COUNT(*) FILTER (WHERE status IN ('proposed','approved')) AS pending
     FROM purchase_intents WHERE owner_wallet = ?`,
  ).get(ownerWallet) as { purchased: number; total: number; pending: number };
  // Read the currency actually used rather than assuming dollars — a total in
  // the wrong unit is worse than no total.
  const cur = getDb().prepare(
    "SELECT currency FROM purchase_intents WHERE owner_wallet = ? ORDER BY created_at DESC LIMIT 1",
  ).get(ownerWallet) as { currency: string } | undefined;
  return {
    purchased: row.purchased,
    totalSpent: Math.round(row.total * 100) / 100,
    pending: row.pending,
    currency: cur?.currency ?? "USD",
  };
}

// ── Track record ──────────────────────────────────────────────────────────────

/** Post-purchase states that mean the buyer kept it, or sent it back. */
const KEPT = ["delivered", "completed", "fulfilled"];
const RETURNED = ["returned", "refunded", "cancelled", "canceled"];

export interface CommerceTrackRecord {
  agentId: string;
  purchases: number;
  kept: number;
  returned: number;
  pending: number;
  totalSpent: number;
  /** kept / (kept + returned), or null until something has actually resolved. */
  keepRate: number | null;
}

/**
 * Did the buyer keep what this agent chose?
 *
 * Every marketplace can tell you an agent completed a task. This is the only
 * signal that says it chose *well* — and it can't be self-reported, because it
 * comes from the order's own post-purchase state. It's the commerce-native
 * version of a receipt: not "the agent says it shopped well", but "the buyer
 * kept it".
 */
export function commerceTrackRecord(agentId: string): CommerceTrackRecord {
  const rows = getDb().prepare(
    "SELECT order_status, amount FROM purchase_intents WHERE agent_id = ? AND status = 'purchased'",
  ).all(agentId) as { order_status: string | null; amount: number }[];

  let kept = 0, returned = 0, pending = 0, totalSpent = 0;
  for (const r of rows) {
    totalSpent += r.amount;
    const s = (r.order_status ?? "").toLowerCase();
    if (KEPT.includes(s)) kept++;
    else if (RETURNED.includes(s)) returned++;
    else pending++;
  }
  const resolved = kept + returned;
  return {
    agentId,
    purchases: rows.length,
    kept,
    returned,
    pending,
    totalSpent: Math.round(totalSpent * 100) / 100,
    keepRate: resolved > 0 ? Math.round((kept / resolved) * 1000) / 1000 : null,
  };
}

/**
 * Purchases whose post-purchase state is still worth asking the business about.
 *
 * `ownerWallet` filters in SQL rather than after the fact — fetching a global
 * window and filtering in memory means that once other buyers have more
 * unresolved orders than the window, this buyer's never appear in it and their
 * status silently stops updating.
 */
export function intentsAwaitingOrderStatus(limit = 25, ownerWallet?: string): PurchaseIntent[] {
  const unresolved =
    `status = 'purchased' AND order_id IS NOT NULL
     AND (order_status IS NULL OR order_status NOT IN ('delivered','completed','fulfilled','returned','refunded','cancelled','canceled'))`;
  const rows = ownerWallet
    ? (getDb().prepare(
        `SELECT * FROM purchase_intents WHERE owner_wallet = ? AND ${unresolved} ORDER BY purchased_at ASC LIMIT ?`,
      ).all(ownerWallet, limit) as IntentRow[])
    : (getDb().prepare(
        `SELECT * FROM purchase_intents WHERE ${unresolved} ORDER BY purchased_at ASC LIMIT ?`,
      ).all(limit) as IntentRow[]);
  return rows.map(toIntent);
}
