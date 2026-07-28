import { b1 as SignMandate } from './types-D3z0h01k.js';

/** Accepts a Solana `Keypair`, or its 64-byte secret key. */
type SecretKeyLike = {
    secretKey: Uint8Array;
} | Uint8Array | number[];
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
declare function mandateSigner(signer: SecretKeyLike): SignMandate;

export { type SecretKeyLike, mandateSigner };
