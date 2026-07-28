// Node-only helpers. Import from the `/node` subpath.
//
// Kept out of `/solana` on purpose: that entry point is used in browsers (see
// `walletPayer`), and a static `crypto` import in it breaks a browser bundle
// before the app ever runs. Anything here needs a Node runtime.

import { createPrivateKey, sign } from "crypto";
import type { SignMandate } from "./types";

/** Accepts a Solana `Keypair`, or its 64-byte secret key. */
export type SecretKeyLike = { secretKey: Uint8Array } | Uint8Array | number[];

function secretKeyBytes(signer: SecretKeyLike): Uint8Array {
  if (signer instanceof Uint8Array) return signer;
  if (Array.isArray(signer)) return Uint8Array.from(signer);
  if (signer && typeof signer === "object" && "secretKey" in signer) return signer.secretKey;
  throw new TypeError("mandateSigner needs a Keypair or a 64-byte secret key");
}

/**
 * Sign purchase authorisations with a raw Solana key, server-side.
 *
 *   import { mandateSigner } from "@axonprotocol/sdk/node";
 *
 *   await axon.commerce.approve(intentId, {
 *     sign: mandateSigner(secretKey),
 *     expect: { maxAmount: 150, currency: "USD", business: "shop.example" },
 *   });
 *
 * The signature is Ed25519 over the raw message bytes, base64 — the same thing a
 * browser wallet's `signMessage` produces, and what Axon verifies against the
 * buyer's wallet address.
 *
 * This key authorises real money with no prompt in front of it. `expect` is what
 * keeps that bounded; without it you are signing whatever you are handed. In a
 * browser, use `walletMandateSigner` from `/solana` instead and let the wallet
 * show the buyer what they are agreeing to.
 */
export function mandateSigner(signer: SecretKeyLike): SignMandate {
  const secret = secretKeyBytes(signer);
  if (secret.length !== 64) {
    throw new TypeError(`expected a 64-byte Solana secret key, got ${secret.length} bytes`);
  }
  return (message: string) => {
    // The seed is the first 32 bytes of a Solana secret key; PKCS#8 wants it
    // wrapped in this fixed DER header. Keeps the SDK free of a signing
    // dependency it would otherwise carry for one function.
    const der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(secret.slice(0, 32)),
    ]);
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    return sign(null, Buffer.from(message, "utf8"), key).toString("base64");
  };
}
