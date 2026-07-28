// Turning an approved purchase into an actual order.
//
// This is the only place money genuinely leaves. Everything before it is
// proposal and consent; everything here is irreversible, so the order of
// operations matters:
//
//   verify the buyer's signature  →  place the order with the business
//   →  redeem the intent (single-use)  →  record it on the trace
//
// The redemption comes AFTER the order exists, because the failure we care about
// is buying twice, not failing to record once. A crash between the two leaves a
// real order with an un-redeemed intent — recoverable by reconciliation, and the
// intent's own ceiling and TTL stop it being re-spent in the meantime.

import { createHash } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { verifyWalletSignature } from "./identity";
import { logger } from "./logger";
import { queueWebhookEvent } from "./webhooks";
import { safeAppendTraceEvent, hashContent, traceIdForTask } from "./traceEvents";
import { discoverBusiness, getCheckout, completeCheckout, getOrder, UcpError, type UcpPaymentInstrument } from "./ucp";
import {
  getSpendMandate,
  committedInPeriod,
  getPurchaseIntent,
  consumePurchaseIntent,
  failPurchaseIntent,
  setOrderStatus,
  CommerceError,
  type PurchaseIntent,
} from "./commerce";

/**
 * Exactly what the buyer puts their name to. Canonical and self-describing: a
 * signature is worthless if the signer couldn't tell what they were agreeing to,
 * and it must not be replayable against a different cart, price, or moment.
 */
export function mandateMessage(intent: PurchaseIntent): string {
  return [
    "Axon purchase authorisation",
    `intent: ${intent.intentId}`,
    `business: ${intent.businessHost}`,
    `items: ${intent.itemsHash}`,
    `amount: ${intent.amount.toFixed(2)} ${intent.currency}`,
    `ceiling: ${intent.maxAmount.toFixed(2)} ${intent.currency}`,
    `expires: ${intent.expiresAt}`,
  ].join("\n");
}

/**
 * Record the buyer's signature against an intent. Verified against the owner's
 * own wallet, so a signature from anyone else — including the agent — is refused.
 */
export function attachMandate(intentId: string, signatureB64: string): PurchaseIntent {
  const intent = getPurchaseIntent(intentId);
  if (!intent) throw new CommerceError(`purchase intent '${intentId}' not found`, "NOT_FOUND");

  // A mandate is non-repudiable proof of one specific purchase. Allowing it to be
  // attached to (or overwritten on) an intent that has already been bought would
  // undermine exactly the thing it exists to prove.
  if (intent.status !== "proposed" && intent.status !== "approved") {
    throw new CommerceError(`intent is '${intent.status}' — its authorisation can no longer be set`, "NOT_SIGNABLE");
  }

  const message = mandateMessage(intent);
  const ok = verifyWalletSignature({ walletAddress: intent.ownerWallet, message, signatureB64 });
  if (!ok) {
    throw new CommerceError("signature does not match the buyer's wallet for this exact purchase", "BAD_SIGNATURE");
  }

  getDb().prepare(
    "UPDATE purchase_intents SET mandate_message = ?, mandate_signature = ? WHERE intent_id = ?",
  ).run(message, signatureB64, intentId);
  void syncToTurso();
  return getPurchaseIntent(intentId)!;
}

function storedMandate(intentId: string): { message: string; signature: string } | null {
  const r = getDb().prepare(
    "SELECT mandate_message, mandate_signature FROM purchase_intents WHERE intent_id = ?",
  ).get(intentId) as { mandate_message: string | null; mandate_signature: string | null } | undefined;
  return r?.mandate_message && r.mandate_signature ? { message: r.mandate_message, signature: r.mandate_signature } : null;
}

/**
 * How much of the approval window must remain before a purchase may be started.
 * Sized for discovery + re-price + complete, each capped at the UCP client's 20s.
 */
const COMPLETION_MARGIN_MS = 90_000;

export interface CompletionResult {
  intent: PurchaseIntent;
  orderId: string;
  settledAmount: number;
  currency: string;
}

/**
 * Place the order. Safe to call more than once for the same intent: the second
 * call finds it already purchased and returns that, rather than buying again.
 */
export async function completeApprovedPurchase(
  intentId: string,
  /**
   * The buyer's payment credential, produced by one of the business's payment
   * handlers on their side. UCP requires it alongside the mandate — a signature
   * alone authorises, it doesn't pay. Axon forwards it and never stores it.
   */
  instrument: UcpPaymentInstrument,
): Promise<CompletionResult> {
  const intent = getPurchaseIntent(intentId);
  if (!intent) throw new CommerceError(`purchase intent '${intentId}' not found`, "NOT_FOUND");

  // Idempotent by design — a retry after a timeout must not place a second order.
  if (intent.status === "purchased") {
    return { intent, orderId: intent.orderId!, settledAmount: intent.amount, currency: intent.currency };
  }
  if (intent.status !== "approved") {
    throw new CommerceError(`intent is '${intent.status}', not approved`, "NOT_APPROVED");
  }
  // Completion makes up to three calls to someone else's server, each with a 20s
  // timeout. Starting one with seconds left on the approval risks placing the
  // order and then finding the intent expired before it can be redeemed — a real
  // charge with no record. Refuse to begin unless the window can outlast the work.
  const msLeft = new Date(intent.expiresAt).getTime() - Date.now();
  if (msLeft <= 0) throw new CommerceError("this approval has expired", "EXPIRED");
  if (msLeft < COMPLETION_MARGIN_MS) {
    throw new CommerceError(
      "this approval is about to expire — too close to start a purchase safely. Approve it again.",
      "EXPIRING",
    );
  }
  const mandate = storedMandate(intentId);
  if (!mandate) {
    throw new CommerceError("the buyer has not signed this purchase", "UNSIGNED");
  }
  if (!intent.checkoutId) {
    throw new CommerceError("no checkout session was opened for this intent", "NO_CHECKOUT");
  }

  const startedAt = Date.now();
  let order;
  try {
    const business = await discoverBusiness(intent.businessHost);

    // Re-price BEFORE paying, not after. The old order of operations charged the
    // card and then refused to record an over-ceiling settlement — which caught
    // the problem but left the buyer's money gone. Reading the live session first
    // turns that into a purchase that simply doesn't happen.
    const live = await getCheckout(business, intent.checkoutId);
    // Re-check the budget at the only moment that is authoritative: just before
    // the charge. Proposals are checked too, but they can be made faster than
    // they are approved, so this is the line that actually holds.
    const budget = getSpendMandate(intent.mandateId);
    if (!budget || budget.status !== "active") {
      failPurchaseIntent(intentId, "the spend mandate was revoked before this could be charged");
      throw new CommerceError("the budget authorising this purchase has been revoked", "MANDATE_REVOKED");
    }
    const committed = committedInPeriod(budget, intentId);
    if (committed + live.total > budget.maxPerPeriod) {
      failPurchaseIntent(
        intentId,
        `would exceed the ${budget.maxPerPeriod} ${budget.currency} per-${budget.period} budget`,
      );
      throw new CommerceError(
        `This would take the ${budget.period}'s spending to ${(committed + live.total).toFixed(2)} of ${budget.maxPerPeriod} ${budget.currency}. Nothing was charged.`,
        "OVER_PERIOD_BUDGET",
      );
    }

    // Compare like with like. A ceiling of 200 USD against a total quoted in a
    // heavier currency would wave through roughly twice the value it was meant
    // to allow, because nothing here would notice the units changed.
    if (live.currency.toUpperCase() !== intent.currency.toUpperCase()) {
      failPurchaseIntent(
        intentId,
        `business re-priced in ${live.currency}, but this was approved in ${intent.currency}`,
      );
      throw new CommerceError(
        `The business is now pricing in ${live.currency}, not the ${intent.currency} you approved. Nothing was charged.`,
        "CURRENCY_CHANGED",
      );
    }

    if (live.total > intent.maxAmount) {
      failPurchaseIntent(
        intentId,
        `price moved to ${live.total} ${live.currency}, above the approved ceiling ${intent.maxAmount}`,
      );
      throw new CommerceError(
        `The price moved to ${live.total} ${live.currency}, above the ${intent.maxAmount} you approved. Nothing was charged.`,
        "PRICE_MOVED",
      );
    }
    // The business validates the mandate and settles against its own processor.
    // Axon never sees a payment credential at any point in this call.
    order = await completeCheckout(business, intent.checkoutId, instrument, mandate.signature);
  } catch (err) {
    const reason = err instanceof UcpError ? err.message : err instanceof Error ? err.message : "checkout failed";
    // Leave the intent approved and signed so this is retryable — a business
    // being down shouldn't cost the buyer their consent.
    logger.error("commerce.checkout_failed", "Could not complete a UCP checkout", { intentId, reason });
    throw new CommerceError(reason, "CHECKOUT_FAILED");
  }

  const settled = order.total > 0 ? order.total : intent.amount;
  const purchased = consumePurchaseIntent(intentId, {
    orderId: order.orderId,
    checkoutId: intent.checkoutId,
    settledAmount: settled,
  });
  if (!purchased) {
    // The order exists but we refused to record it — almost always because the
    // business settled above the ceiling the buyer approved. Say so loudly: this
    // is the one state a human needs to look at.
    logger.error("commerce.settled_unredeemed", "Order placed but the intent could not be redeemed", {
      intentId, orderId: order.orderId, settled, ceiling: intent.maxAmount,
    });
    throw new CommerceError(
      `the business settled ${settled} ${order.currency}, above the approved ceiling of ${intent.maxAmount} — order ${order.orderId} needs review`,
      "OVER_CEILING",
    );
  }

  // On the receipt, in the same trace as the work that led to it. Same privacy
  // face as everything else: the business and the amount, hashes for the rest.
  safeAppendTraceEvent({
    traceId: intent.taskId ? traceIdForTask(intent.taskId) : intent.intentId,
    taskId: intent.taskId ?? null,
    kind: "purchase.completed",
    fromAgent: intent.agentId,
    inputHash: intent.itemsHash,
    outputHash: hashContent(order.orderId),
    latencyMs: Date.now() - startedAt,
    meta: {
      business: intent.businessHost,
      amount: settled,
      currency: order.currency,
      approvedCeiling: intent.maxAmount,
      // Commits to the buyer's signed consent without exposing it.
      mandateHash: createHash("sha256").update(mandate.signature).digest("hex"),
    },
  });

  try {
    queueWebhookEvent(intent.agentId, "purchase.completed", {
      intentId, orderId: order.orderId, amount: settled, currency: order.currency,
      businessHost: intent.businessHost,
    });
  } catch {
    /* notification is best-effort */
  }

  logger.info("commerce.order_placed", "Agent completed a real-world purchase", {
    intentId, agentId: intent.agentId, businessHost: intent.businessHost, orderId: order.orderId, amount: settled,
  });
  return { intent: purchased, orderId: order.orderId, settledAmount: settled, currency: order.currency };
}

/**
 * Refresh post-purchase state (shipped, delivered, returned). This is what will
 * eventually tell us whether the buyer KEPT what the agent chose — the only
 * honest measure of whether it shopped well.
 */
export async function refreshOrderStatus(intentId: string): Promise<string | null> {
  const intent = getPurchaseIntent(intentId);
  if (!intent?.orderId) return null;
  try {
    const business = await discoverBusiness(intent.businessHost);
    const order = await getOrder(business, intent.orderId);
    if (order?.status) {
      setOrderStatus(intentId, order.status);
      return order.status;
    }
  } catch {
    /* the business may not expose order lookups; not fatal */
  }
  return intent.orderStatus ?? null;
}

/** Mark an intent failed from a caller that already knows why. */
export function abandonPurchase(intentId: string, reason: string): void {
  failPurchaseIntent(intentId, reason);
}
