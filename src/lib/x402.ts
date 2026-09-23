// x402 payment protocol support (spec version x402/1).
// Spec: https://x402.org
//
// Flow:
//   1. Client GETs or POSTs a paid resource → server returns 402 + X-Payment-Required header
//   2. Client pays on-chain, obtains a transaction signature
//   3. Client retries with X-Payment header containing the signed proof
//   4. Server verifies on-chain and serves the resource

import {
  parsePaymentAmount,
  PAYMENT_RECEIVER_WALLET_ADDRESS,
  SETTLEMENT_TOKEN_ADDRESS,
  ETH_DECIMALS,
  verifyIncomingPayment,
} from "./money";
import { CHAIN_ID } from "./chain";
import { createQuote, axonPaymentsEnabled, QUOTE_TTL_SECONDS, settleQuote } from "./axonQuote";

export const X402_VERSION = "x402/1" as const;
export const X402_SCHEME = "exact" as const;

/** x402 names a network with a CAIP-2 identifier; for an EVM chain that is eip155 plus its id. */
function networkId(): string {
  return `eip155:${CHAIN_ID}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface X402PaymentOption {
  scheme: typeof X402_SCHEME;
  network: string;
  maxAmountRequired: string; // wei (18 decimals), e.g. "50000000000000000" = 0.05 ETH
  resource: string;          // full URL of the resource being paid for
  description: string;
  mimeType: string;
  payToAddress: string;
  requiredDeadlineSeconds: number;
  asset: string;
  extra: {
    // Optional, because an arbitrary ERC-20's name and symbol are on the token rather than in our
    // configuration. A client that needs them reads them from the contract, which is authoritative
    // in a way that a string we typed here would not be.
    name?: string;
    symbol?: string;
    decimals: number;
    contractAddress?: string; // only when an ERC-20 is configured; native ETH has no contract
    // The quote this option's amount was pinned against. Present only on a token option: the rate
    // between the agent's ETH price and the token moves, so the amount is only meaningful together
    // with the quote that fixed it. A client echoes this back when it pays.
    quoteId?: string;
  };
}

export interface X402Requirements {
  version: typeof X402_VERSION;
  accepts: X402PaymentOption[];
}

export interface X402PaymentPayload {
  signature: string; // confirmed transaction hash
  from: string;      // payer's wallet address (base58)
  // Set when the client took a token option rather than the native one. Optional, so a client that
  // has never heard of quotes still pays in ETH exactly as before.
  quoteId?: string;
}

export interface X402PaymentHeader {
  scheme: typeof X402_SCHEME;
  network: string;
  payload: X402PaymentPayload;
}

// ── Build ─────────────────────────────────────────────────────────────────────

/** The native option, which is what every client understood before tokens existed. */
function ethOption(opts: { resource: string; description: string; wei: bigint }): X402PaymentOption {
  return {
    scheme: X402_SCHEME,
    network: networkId(),
    // Wei, as a string. The amount never passes through a float on its way to the client, so
    // what is quoted is exactly what gets checked on-chain.
    maxAmountRequired: opts.wei.toString(),
    resource: opts.resource,
    description: opts.description,
    mimeType: "application/json",
    payToAddress: PAYMENT_RECEIVER_WALLET_ADDRESS,
    requiredDeadlineSeconds: 300, // client has 5 minutes to complete payment
    asset: "ETH",
    extra: { name: "Ether", symbol: "ETH", decimals: ETH_DECIMALS },
  };
}

export function buildX402Requirements(opts: {
  resource: string;
  price: string;      // e.g. "0.05 ETH"
  description: string;
}): X402Requirements | null {
  if (!PAYMENT_RECEIVER_WALLET_ADDRESS) return null;

  const parsed = parsePaymentAmount(opts.price);
  if (!parsed) return null;

  return { version: X402_VERSION, accepts: [ethOption({ ...opts, wei: parsed.wei })] };
}

/**
 * The same requirements, with an $AXON option alongside the native one.
 *
 * accepts is a list because a server may take more than one thing, so this adds rather than
 * replaces: a client that has never heard of the token still sees the ETH option exactly where it
 * was. Nothing is removed and nothing changes shape for anyone who was already paying.
 *
 * The token amount is pinned to a quote, because the rate between the agent's ETH price and $AXON
 * moves and an amount without a quote behind it is a number that will be wrong by the time it is
 * paid. The quote id rides along in `extra` and the client echoes it back when it pays.
 *
 * Asking is best effort. If the pool cannot be read, or settlement is switched off, the caller gets
 * the ETH-only requirements rather than an error: a 402 that cannot be answered is worse than one
 * that offers one way to pay instead of two.
 */
export async function buildX402RequirementsWithAxon(opts: {
  resource: string;
  price: string;
  description: string;
  /** The agent's own terms. Absent, or not opted in, means the token is never offered. */
  axon?: { acceptsAxon?: boolean; axonDiscountBps?: number };
}): Promise<X402Requirements | null> {
  const base = buildX402Requirements(opts);
  if (!base || !axonPaymentsEnabled()) return base;
  // Opting in is the agent's decision, not the platform's. Quoting a currency its owner never agreed
  // to would be committing them to take it.
  if (!opts.axon?.acceptsAxon) return base;

  const parsed = parsePaymentAmount(opts.price);
  if (!parsed) return base;

  // One quote per resource, price and window, rather than one per request. A 402 is cheap to ask for
  // and a crawler could ask a thousand times; without this each ask would write a row. The window is
  // the quote's own lifetime, so a client that retries inside it is offered the same amount it was
  // offered a moment ago, and one that comes back later gets a fresh price.
  const window = Math.floor(Date.now() / (QUOTE_TTL_SECONDS * 1000));
  const discountBps = opts.axon.axonDiscountBps ?? 0;
  const quoted = await createQuote({
    ethWei: parsed.wei,
    reference: opts.resource,
    discountBps,
    // The discount is part of the key. Two agents at the same price but different terms owe different
    // amounts, and sharing a quote between them would quote one of them the other's price.
    idempotencyKey: `x402:${opts.resource}:${parsed.wei}:${discountBps}:${window}`,
  });
  if (!quoted.ok) return base;

  const axon: X402PaymentOption = {
    scheme: X402_SCHEME,
    network: networkId(),
    maxAmountRequired: quoted.quote.axonUnits.toString(),
    resource: opts.resource,
    description: opts.description,
    mimeType: "application/json",
    payToAddress: quoted.quote.payTo,
    // The quote's own expiry, so the deadline a client is given is the deadline actually enforced.
    requiredDeadlineSeconds: Math.max(
      0,
      Math.round((Date.parse(quoted.quote.expiresAt) - Date.now()) / 1000),
    ),
    asset: SETTLEMENT_TOKEN_ADDRESS,
    extra: {
      contractAddress: SETTLEMENT_TOKEN_ADDRESS,
      decimals: ETH_DECIMALS,
      quoteId: quoted.quote.quoteId,
    },
  };

  return { ...base, accepts: [...base.accepts, axon] };
}

export function encodeRequirements(req: X402Requirements): string {
  return Buffer.from(JSON.stringify(req)).toString("base64");
}

// ── Parse ─────────────────────────────────────────────────────────────────────

// Decodes and validates the X-Payment request header sent by the client
export function decodePaymentHeader(raw: string): X402PaymentHeader | null {
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<X402PaymentHeader>;

    if (
      parsed.scheme !== X402_SCHEME ||
      typeof parsed.network !== "string" ||
      typeof parsed.payload?.signature !== "string" ||
      parsed.payload.signature.length === 0 ||
      typeof parsed.payload?.from !== "string" ||
      parsed.payload.from.length === 0
    ) {
      return null;
    }

    return parsed as X402PaymentHeader;
  } catch {
    return null;
  }
}

// ── Verify ────────────────────────────────────────────────────────────────────

// Verifies the on-chain ETH payment described in an X-Payment header.
// price must be in the same format as the agent's price field, e.g. "0.05 ETH".
// Throws for server configuration errors (missing env vars) so callers can return 503.
// Returns { valid: false } only for genuine payment failures.
export async function verifyX402Payment(
  header: X402PaymentHeader,
  price: string
): Promise<{ valid: boolean; error?: string }> {
  // A client that took the token option says so by echoing the quote back. What gets checked is then
  // the amount that quote pinned, not the ETH price: those are different numbers in different units,
  // and checking the price here would refuse every token payment ever made.
  if (header.payload.quoteId) {
    if (!axonPaymentsEnabled()) {
      return { valid: false, error: "This server is not taking token payments" };
    }
    const settled = await settleQuote({
      quoteId: header.payload.quoteId,
      txHash: header.payload.signature,
      payer: header.payload.from,
    });
    return settled.ok ? { valid: true } : { valid: false, error: settled.detail ?? settled.reason };
  }

  const parsed = parsePaymentAmount(price);
  if (!parsed) return { valid: false, error: "Agent has an unrecognised price format" };

  try {
    const ok = await verifyIncomingPayment(header.payload.signature, parsed, header.payload.from);
    return ok
      ? { valid: true }
      : { valid: false, error: "Payment signature did not verify on-chain" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Verification failed";
    // Config errors (missing wallet / API key) must propagate so callers return 503, not 402
    if (/is not set|API_KEY|PRIVATE_KEY|RPC_URL/i.test(msg)) throw err;
    return { valid: false, error: msg };
  }
}

// ── Helpers for client-side SDK ───────────────────────────────────────────────

// Builds the base64 X-Payment header value from a confirmed signature + payer address.
// network must come from the X402Requirements the server sent — do NOT read process.env here
// because this function may be called in browser/edge contexts where SOLANA_NETWORK is undefined.
export function buildPaymentHeader(
  signature: string,
  from: string,
  network: string,
  quoteId?: string,
): string {
  const header: X402PaymentHeader = {
    scheme: X402_SCHEME,
    network,
    // Present only when the client took a token option. Leaving it off is how every existing client
    // keeps paying in ETH without knowing anything about this.
    payload: { signature, from, ...(quoteId ? { quoteId } : {}) },
  };
  return Buffer.from(JSON.stringify(header)).toString("base64");
}

// Parses the X-Payment-Required header from a 402 response into structured requirements
export function decodeRequirements(raw: string): X402Requirements | null {
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(json) as Partial<X402Requirements>;
    if (parsed.version !== X402_VERSION || !Array.isArray(parsed.accepts) || parsed.accepts.length === 0) {
      return null;
    }
    return parsed as X402Requirements;
  } catch {
    return null;
  }
}
