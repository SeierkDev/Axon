import { createPrivateKey, sign } from 'crypto';

// src/node.ts
function secretKeyBytes(signer) {
  if (signer instanceof Uint8Array) return signer;
  if (Array.isArray(signer)) return Uint8Array.from(signer);
  if (signer && typeof signer === "object" && "secretKey" in signer) return signer.secretKey;
  throw new TypeError("mandateSigner needs a Keypair or a 64-byte secret key");
}
function mandateSigner(signer) {
  const secret = secretKeyBytes(signer);
  if (secret.length !== 64) {
    throw new TypeError(`expected a 64-byte Solana secret key, got ${secret.length} bytes`);
  }
  return (message) => {
    const der = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(secret.slice(0, 32))
    ]);
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    return sign(null, Buffer.from(message, "utf8"), key).toString("base64");
  };
}

export { mandateSigner };
//# sourceMappingURL=node.mjs.map
//# sourceMappingURL=node.mjs.map