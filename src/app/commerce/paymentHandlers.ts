"use client";

// Payment handlers — where the buyer's card actually gets involved.
//
// UCP needs `payment.instruments[]` at completion as well as the signed mandate:
// signing authorises a purchase, it doesn't pay for it. The credential is
// produced by one of the BUSINESS's payment handlers, running in the buyer's
// browser. Axon never sees a card number; it forwards whatever opaque credential
// the handler hands back.
//
// Everything handler-specific lives behind this dispatcher on purpose. Each
// handler defines its own credential shape, so a wrong guess about one of them
// is one function in this file rather than a change to the checkout path.
//
// ⚠️ The Google Pay credential shape below is written from Google's published
// API, NOT verified against a live UCP business. It is the first thing to check
// against a real checkout session.

export interface PaymentInstrument {
  id: string;
  handlerId: string;
  type: string;
  credential: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
}

export interface HandlerDescriptor {
  namespace: string;
  id: string;
  version?: string;
  config?: Record<string, unknown>;
}

export interface HandlerContext {
  total: number;
  currency: string;
  businessHost: string;
}

export class UnsupportedHandlerError extends Error {
  constructor(readonly namespaces: string[]) {
    super(
      namespaces.length
        ? `This business pays through ${namespaces.join(", ")}, which Axon can't run yet.`
        : "This business didn't offer a payment handler.",
    );
    this.name = "UnsupportedHandlerError";
  }
}

type HandlerRunner = (h: HandlerDescriptor, ctx: HandlerContext) => Promise<PaymentInstrument>;

// ── Google Pay ────────────────────────────────────────────────────────────────

interface GooglePayClient {
  loadPaymentData(request: Record<string, unknown>): Promise<{
    paymentMethodData?: { type?: string; tokenizationData?: { token?: string; type?: string }; info?: Record<string, unknown> };
  }>;
}
interface GooglePayNamespace {
  payments: { api: { PaymentsClient: new (opts: { environment: string }) => GooglePayClient } };
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(el);
  });
}

const googlePay: HandlerRunner = async (handler, ctx) => {
  await loadScript("https://pay.google.com/gp/p/js/pay.js");
  const g = (window as unknown as { google?: GooglePayNamespace }).google;
  if (!g?.payments?.api?.PaymentsClient) throw new Error("Google Pay did not load.");

  const cfg = handler.config ?? {};
  // The business supplies its own gateway configuration and environment; we run
  // the button against them and never substitute our own.
  const environment = typeof cfg.environment === "string" ? cfg.environment : "TEST";
  const allowedPaymentMethods = Array.isArray(cfg.allowed_payment_methods)
    ? (cfg.allowed_payment_methods as Record<string, unknown>[])
    : null;
  if (!allowedPaymentMethods) {
    throw new Error("This business's Google Pay handler didn't publish allowed payment methods.");
  }

  const client = new g.payments.api.PaymentsClient({ environment });
  const result = await client.loadPaymentData({
    apiVersion: 2,
    apiVersionMinor: 0,
    allowedPaymentMethods,
    merchantInfo: (cfg.merchant_info as Record<string, unknown>) ?? {},
    transactionInfo: {
      totalPriceStatus: "FINAL",
      // Google Pay wants a decimal string, unlike UCP's minor units.
      totalPrice: ctx.total.toFixed(2),
      currencyCode: ctx.currency,
    },
  });

  const token = result.paymentMethodData?.tokenizationData?.token;
  if (!token) throw new Error("Google Pay returned no payment token.");

  return {
    id: `gpay_${Date.now()}`,
    handlerId: handler.id,
    type: result.paymentMethodData?.type === "CARD" ? "card" : "tokenized_card",
    credential: {
      type: result.paymentMethodData?.tokenizationData?.type ?? "PAYMENT_GATEWAY",
      token,
    },
  };
};

// ── Dispatcher ────────────────────────────────────────────────────────────────

const RUNNERS: Record<string, HandlerRunner> = {
  "com.google.pay": googlePay,
};

/** Whether Axon can run any of the handlers this business offers. */
export function supportedHandler(handlers: HandlerDescriptor[]): HandlerDescriptor | null {
  return handlers.find((h) => h.namespace in RUNNERS) ?? null;
}

/**
 * Run the buyer's payment handler and return the credential to forward. Throws
 * UnsupportedHandlerError when the business only offers handlers we can't drive
 * — the caller should say so plainly rather than leave the buyer clicking.
 */
export async function collectPaymentInstrument(
  handlers: HandlerDescriptor[],
  ctx: HandlerContext,
): Promise<PaymentInstrument> {
  const handler = supportedHandler(handlers);
  if (!handler) throw new UnsupportedHandlerError(handlers.map((h) => h.namespace));
  return RUNNERS[handler.namespace](handler, ctx);
}
