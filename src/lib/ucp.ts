// Universal Commerce Protocol client — how an Axon agent actually transacts.
//
// UCP (ucp.dev, co-developed by Google and Shopify) lets an agent buy from a
// business without either side pre-arranging anything: agents onboard by
// publishing a signed profile (RFC 9421), and the business stays merchant of
// record and holds the PSP contract. Axon never touches a card number.
//
// Shapes follow spec version 2026-04-08. Two things about it bite badly if you
// assume otherwise, so they are handled at this boundary and nowhere else:
//
//   1. MONEY IS IN MINOR UNITS. `amount` is an integer of the currency's minor
//      unit (ISO 4217) — 18000 is $180.00. Everything above this module works in
//      decimal, so conversion happens here only. Getting this wrong doesn't
//      error, it mis-authorises by a factor of 100.
//   2. THE TOTAL IS NOT A FIELD. `totals` is an array of typed entries; the
//      order total is the one with type "total".

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from "crypto";
import { publicHttpFetch } from "./urlSecurity";
import { logger } from "./logger";

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 3_000_000;
const SHOPPING_SERVICE = "dev.ucp.shopping";

// ── Money ─────────────────────────────────────────────────────────────────────

// Currencies whose minor unit isn't 1/100. Anything unlisted is assumed to have
// two decimal places, which covers the overwhelming majority.
const MINOR_UNIT_EXPONENT: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, XOF: 0, XAF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};
const factor = (currency: string): number => 10 ** (MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2);

/** Minor units → decimal. 18000 USD → 180. */
export function fromMinor(amount: number, currency: string): number {
  return Math.round((amount / factor(currency)) * 1e6) / 1e6;
}
/** Decimal → minor units. 180 USD → 18000. */
export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * factor(currency));
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UcpPaymentHandler {
  /** Handler namespace, e.g. "com.google.pay". */
  namespace: string;
  id: string;
  version?: string;
  config?: Record<string, unknown>;
}

export interface UcpBusinessProfile {
  host: string;
  version?: string;
  /** Base URL of the shopping service; every path hangs off this. */
  endpoint: string;
  capabilities: string[];
  paymentHandlers: UcpPaymentHandler[];
}

export interface UcpProduct {
  id: string;
  title: string;
  price: number; // decimal
  currency: string;
  url?: string;
  image?: string;
  availability?: string;
}

export interface UcpLineItem {
  productId: string;
  quantity: number;
}

/**
 * A payment credential produced by one of the business's payment handlers, on
 * the BUYER's side. Axon forwards it opaquely and never inspects or stores it.
 */
export interface UcpPaymentInstrument {
  id: string;
  handlerId: string;
  type: string;
  credential: Record<string, unknown>;
  billingAddress?: Record<string, unknown>;
}

export interface UcpCheckoutSession {
  checkoutId: string;
  status: string;
  total: number; // decimal
  currency: string;
  paymentHandlers: UcpPaymentHandler[];
  /** The business says it will accept a completion call. */
  readyToComplete: boolean;
  messages: string[];
}

export interface UcpOrder {
  orderId: string;
  total: number;
  currency: string;
  status?: string;
}

export interface UcpBuyer {
  contact: { name: string; email: string; phone?: string };
  address: { line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string };
}

export class UcpError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "UcpError";
  }
}

// ── Agent identity ────────────────────────────────────────────────────────────

export function agentProfileUrl(): string {
  // Request-free: this runs in the worker, which has no NextRequest to read a
  // host from. Same fallback the MCP server uses.
  const origin = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://axon-agents.com").replace(/\/$/, "");
  return `${origin}/.well-known/ucp-agent`;
}

/** The key id businesses see in our signatures and on our published profile. */
export const AGENT_KEY_ID = "axon";

/**
 * Our signing key, or null when none is configured. Ed25519 is the expected
 * shape — the algorithm label is derived from the key rather than assumed, so a
 * signature never claims to be something it isn't.
 */
export function agentSigningKey(): { key: KeyObject; alg: string } | null {
  const pem = process.env.UCP_AGENT_PRIVATE_KEY;
  if (!pem) return null;
  try {
    const key = createPrivateKey(pem);
    const alg =
      key.asymmetricKeyType === "ed25519" ? "ed25519"
      : key.asymmetricKeyType === "ec" ? "ecdsa-p256-sha256"
      : "rsa-pss-sha512";
    return { key, alg };
  } catch (err) {
    logger.warn("ucp.key_unreadable", "UCP_AGENT_PRIVATE_KEY could not be parsed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The public half, as a JWK, for businesses to verify against. */
export function agentPublicJwk(): Record<string, unknown> | null {
  const signing = agentSigningKey();
  if (!signing) return null;
  try {
    return {
      ...(createPublicKey(signing.key).export({ format: "jwk" }) as Record<string, unknown>),
      kid: AGENT_KEY_ID,
      use: "sig",
      alg: signing.alg,
    };
  } catch {
    return null;
  }
}

/** RFC 9421 request signature. Businesses verify against our published profile. */
function signRequest(method: string, url: string, body: string): Record<string, string> | null {
  const signing = agentSigningKey();
  if (!signing) return null;
  const created = Math.floor(Date.now() / 1000);
  const target = new URL(url);
  const digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
  const params = `("@method" "@authority" "@path" "content-digest");created=${created};keyid="${AGENT_KEY_ID}";alg="${signing.alg}"`;
  const base =
    `"@method": ${method.toUpperCase()}\n` +
    `"@authority": ${target.host}\n` +
    `"@path": ${target.pathname}\n` +
    `"content-digest": ${digest}\n` +
    `"@signature-params": ${params}`;
  try {
    // Ed25519 signs the message directly — passing it through a SHA-256 digest
    // wrapper (createSign) throws, which is what this used to do.
    const sig = cryptoSign(
      signing.alg === "ed25519" ? null : "sha256",
      Buffer.from(base, "utf8"),
      signing.key,
    );
    return {
      "Content-Digest": digest,
      "Signature-Input": `sig1=${params}`,
      Signature: `sig1=:${sig.toString("base64")}:`,
    };
  } catch (err) {
    logger.warn("ucp.sign_failed", "Could not sign UCP request — sending unsigned", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function ucpFetch<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const body = init.body === undefined ? "" : JSON.stringify(init.body);
  const headers: Record<string, string> = {
    Accept: "application/json",
    // A structured field, not a bare URL.
    "UCP-Agent": `profile="${agentProfileUrl()}"`,
  };
  if (body) headers["Content-Type"] = "application/json";
  Object.assign(headers, signRequest(method, url, body) ?? {});

  const res = await publicHttpFetch(url, {
    method, headers, ...(body ? { body } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    maxResponseBytes: MAX_BYTES,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new UcpError(
      `${new URL(url).host} returned HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      "HTTP_ERROR",
    );
  }
  return (await res.json()) as T;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

type RawHandlers = Record<string, { id?: string; version?: string; config?: Record<string, unknown> }[]>;

interface RawDiscovery {
  ucp?: {
    version?: string;
    services?: Record<string, { transport?: string; endpoint?: string }[]>;
    capabilities?: Record<string, unknown[]>;
    payment_handlers?: RawHandlers;
  };
}

function readHandlers(raw: RawHandlers | undefined): UcpPaymentHandler[] {
  const out: UcpPaymentHandler[] = [];
  for (const [namespace, entries] of Object.entries(raw ?? {})) {
    for (const h of entries ?? []) {
      if (typeof h?.id === "string") out.push({ namespace, id: h.id, version: h.version, config: h.config });
    }
  }
  return out;
}

/**
 * Read a business's `/.well-known/ucp`. Everything hangs off this: the shopping
 * service's base URL, the capabilities it supports, and the payment handlers the
 * buyer can produce a credential with.
 */
export async function discoverBusiness(host: string): Promise<UcpBusinessProfile> {
  const clean = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) {
    throw new UcpError(`'${host}' is not a valid business host`, "BAD_HOST");
  }
  const raw = await ucpFetch<RawDiscovery>(`https://${clean}/.well-known/ucp`);
  const rest = (raw.ucp?.services?.[SHOPPING_SERVICE] ?? []).find(
    (s) => (s.transport ?? "rest") === "rest" && typeof s.endpoint === "string",
  );
  if (!rest?.endpoint) {
    throw new UcpError(`${clean} does not publish a REST '${SHOPPING_SERVICE}' service`, "NOT_SHOPPABLE");
  }
  return {
    host: clean,
    version: raw.ucp?.version,
    endpoint: rest.endpoint.replace(/\/$/, ""),
    capabilities: Object.keys(raw.ucp?.capabilities ?? {}),
    paymentHandlers: readHandlers(raw.ucp?.payment_handlers),
  };
}

// ── Catalogue ─────────────────────────────────────────────────────────────────

interface RawProduct {
  id?: string; title?: string; name?: string;
  price?: { amount?: number; currency?: string };
  url?: string; image_url?: string; availability?: string;
}

export async function searchCatalog(profile: UcpBusinessProfile, query: string, limit = 10): Promise<UcpProduct[]> {
  const url = `${profile.endpoint}/products?q=${encodeURIComponent(query)}&limit=${Math.min(Math.max(limit, 1), 25)}`;
  const raw = await ucpFetch<{ products?: RawProduct[]; items?: RawProduct[] }>(url);
  return (raw.products ?? raw.items ?? [])
    .map((p): UcpProduct | null => {
      const title = p.title ?? p.name;
      if (!p.id || !title) return null;
      const currency = p.price?.currency ?? "USD";
      return {
        id: p.id,
        title,
        price: typeof p.price?.amount === "number" ? fromMinor(p.price.amount, currency) : 0,
        currency,
        url: p.url,
        image: p.image_url,
        availability: p.availability,
      };
    })
    .filter((p): p is UcpProduct => p !== null);
}

// ── Checkout ──────────────────────────────────────────────────────────────────

interface RawSession {
  id?: string; status?: string; currency?: string;
  totals?: { type?: string; amount?: number }[];
  messages?: { text?: string; content?: string }[];
  order?: { id?: string; status?: string };
  ucp?: { payment_handlers?: RawHandlers };
}

/** The order total is the entry in `totals` typed "total" — there is no total field. */
function readTotal(raw: RawSession): { total: number; currency: string } {
  const currency = raw.currency ?? "USD";
  const entry = (raw.totals ?? []).find((t) => t.type === "total");
  if (!entry || typeof entry.amount !== "number") {
    throw new UcpError("checkout session did not include a 'total'", "NO_TOTAL");
  }
  return { total: fromMinor(entry.amount, currency), currency };
}

function toSession(raw: RawSession): UcpCheckoutSession {
  if (!raw.id) throw new UcpError("business did not return a checkout session id", "NO_CHECKOUT_ID");
  const { total, currency } = readTotal(raw);
  return {
    checkoutId: raw.id,
    status: raw.status ?? "incomplete",
    total,
    currency,
    paymentHandlers: readHandlers(raw.ucp?.payment_handlers),
    readyToComplete: raw.status === "ready_for_complete",
    messages: (raw.messages ?? []).map((m) => m.text ?? m.content ?? "").filter(Boolean),
  };
}

// UCP splits a name into first/last and uses schema.org-style address fields.
function nameParts(name: string): { first_name: string; last_name: string } {
  const parts = name.trim().split(/\s+/);
  return { first_name: parts[0] ?? "", last_name: parts.slice(1).join(" ") || parts[0] || "" };
}
function toUcpBuyer(buyer: UcpBuyer) {
  return {
    ...nameParts(buyer.contact.name),
    email: buyer.contact.email,
    ...(buyer.contact.phone ? { phone_number: buyer.contact.phone } : {}),
  };
}
function toPostalAddress(buyer: UcpBuyer) {
  return {
    ...nameParts(buyer.contact.name),
    street_address: buyer.address.line1,
    ...(buyer.address.line2 ? { extended_address: buyer.address.line2 } : {}),
    address_locality: buyer.address.city,
    ...(buyer.address.region ? { address_region: buyer.address.region } : {}),
    postal_code: buyer.address.postalCode,
    address_country: buyer.address.country,
    ...(buyer.contact.phone ? { phone_number: buyer.contact.phone } : {}),
  };
}

/**
 * Open a checkout session. This prices the order for real — tax and shipping
 * included — which is the number the buyer is asked to approve. Their details go
 * straight from encrypted storage into this request and are never returned to
 * the agent.
 */
export async function createCheckout(
  profile: UcpBusinessProfile,
  items: UcpLineItem[],
  buyer: UcpBuyer,
): Promise<UcpCheckoutSession> {
  if (items.length === 0) throw new UcpError("cannot open a checkout with an empty cart", "EMPTY_CART");
  const raw = await ucpFetch<RawSession>(`${profile.endpoint}/checkout-sessions`, {
    method: "POST",
    body: {
      meta: { "ucp-agent": { profile: agentProfileUrl() } },
      line_items: items.map((i) => ({ item: { id: i.productId }, quantity: i.quantity })),
      buyer: toUcpBuyer(buyer),
      fulfillment: { address: toPostalAddress(buyer) },
      context: { address_country: buyer.address.country },
    },
  });
  return toSession(raw);
}

/** Re-read a session — status and totals move as the business prices it. */
export async function getCheckout(profile: UcpBusinessProfile, checkoutId: string): Promise<UcpCheckoutSession> {
  return toSession(
    await ucpFetch<RawSession>(`${profile.endpoint}/checkout-sessions/${encodeURIComponent(checkoutId)}`),
  );
}

/**
 * Finish the purchase.
 *
 * Two things are required and NEITHER can be produced by the agent:
 *   - `instrument` — a payment credential from one of the business's payment
 *     handlers, created on the buyer's side. Forwarded opaquely; never inspected.
 *   - `checkoutMandate` — the buyer's signed AP2 consent to this exact purchase.
 */
export async function completeCheckout(
  profile: UcpBusinessProfile,
  checkoutId: string,
  instrument: UcpPaymentInstrument,
  checkoutMandate: string,
): Promise<UcpOrder> {
  const raw = await ucpFetch<RawSession>(
    `${profile.endpoint}/checkout-sessions/${encodeURIComponent(checkoutId)}/complete`,
    {
      method: "POST",
      body: {
        payment: {
          instruments: [
            {
              id: instrument.id,
              handler_id: instrument.handlerId,
              type: instrument.type,
              selected: true,
              credential: instrument.credential,
              ...(instrument.billingAddress ? { billing_address: instrument.billingAddress } : {}),
            },
          ],
        },
        ap2: { checkout_mandate: checkoutMandate },
      },
    },
  );
  const orderId = raw.order?.id;
  if (!orderId) {
    const why = (raw.messages ?? []).map((m) => m.text ?? m.content).filter(Boolean).join("; ");
    throw new UcpError(
      `checkout did not produce an order${why ? `: ${why}` : ` (status ${raw.status ?? "unknown"})`}`,
      "NO_ORDER",
    );
  }
  const { total, currency } = readTotal(raw);
  return { orderId, total, currency, status: raw.order?.status ?? raw.status };
}

/** Post-purchase state — shipment, delivery, returns. */
export async function getOrder(profile: UcpBusinessProfile, orderId: string): Promise<UcpOrder | null> {
  try {
    const raw = await ucpFetch<{ id?: string; status?: string; currency?: string; totals?: { type?: string; amount?: number }[] }>(
      `${profile.endpoint}/orders/${encodeURIComponent(orderId)}`,
    );
    if (!raw.id) return null;
    const currency = raw.currency ?? "USD";
    const total = (raw.totals ?? []).find((t) => t.type === "total")?.amount;
    return {
      orderId: raw.id,
      total: typeof total === "number" ? fromMinor(total, currency) : 0,
      currency,
      status: raw.status,
    };
  } catch {
    return null;
  }
}

/** Stable commitment to a cart, so an approval binds to exact contents. */
export function hashLineItems(host: string, items: UcpLineItem[]): string {
  const canonical = items.map((i) => `${i.productId}x${i.quantity}`).sort().join("|");
  return createHash("sha256").update(`${host}:${canonical}`, "utf8").digest("hex");
}
