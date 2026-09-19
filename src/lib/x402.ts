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
  TOKEN_ADDRESS,
  ETH_DECIMALS,
  verifyIncomingPayment,
} from "./money";
import { CHAIN_ID } from "./chain";

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
    name: string;
    symbol: string;
    decimals: number;
    contractAddress?: string; // only when an ERC-20 is configured; native ETH has no contract
  };
}

export interface X402Requirements {
  version: typeof X402_VERSION;
  accepts: X402PaymentOption[];
}

export interface X402PaymentPayload {
  signature: string; // confirmed transaction hash
  from: string;      // payer's wallet address (base58)
}

export interface X402PaymentHeader {
  scheme: typeof X402_SCHEME;
  network: string;
  payload: X402PaymentPayload;
}

// ── Build ─────────────────────────────────────────────────────────────────────

export function buildX402Requirements(opts: {
  resource: string;
  price: string;      // e.g. "0.05 ETH"
  description: string;
}): X402Requirements | null {
  if (!PAYMENT_RECEIVER_WALLET_ADDRESS) return null;

  const parsed = parsePaymentAmount(opts.price);
  if (!parsed) return null;

  return {
    version: X402_VERSION,
    accepts: [
      {
        scheme: X402_SCHEME,
        network: networkId(),
        // Wei, as a string. The amount never passes through a float on its way to the client, so
        // what is quoted is exactly what gets checked on-chain.
        maxAmountRequired: parsed.wei.toString(),
        resource: opts.resource,
        description: opts.description,
        mimeType: "application/json",
        payToAddress: PAYMENT_RECEIVER_WALLET_ADDRESS,
        requiredDeadlineSeconds: 300, // client has 5 minutes to complete payment
        asset: "ETH",
        extra: {
          name: "Ether",
          symbol: "ETH",
          decimals: ETH_DECIMALS,
          ...(TOKEN_ADDRESS ? { contractAddress: TOKEN_ADDRESS } : {}),
        },
      },
    ],
  };
}

// Encodes requirements as base64 for the X-Payment-Required response header
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
export function buildPaymentHeader(signature: string, from: string, network: string): string {
  const header: X402PaymentHeader = {
    scheme: X402_SCHEME,
    network,
    payload: { signature, from },
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
