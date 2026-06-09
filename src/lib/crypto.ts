import { createHash, createCipheriv, createDecipheriv, randomBytes } from "crypto";

// Domain-separated from the scrypt salt in identity.ts to prevent key reuse.
const DOMAIN = "axon-field-encrypt:";

function deriveKey(): Buffer {
  const seed = process.env.SEED_SECRET ?? "";
  return createHash("sha256").update(`${DOMAIN}${seed}`).digest();
}

// AES-256-GCM envelope format: base64( 12-byte nonce | ciphertext | 16-byte auth tag )
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString("base64");
}

export function decrypt(envelope: string): string {
  const key = deriveKey();
  const buf = Buffer.from(envelope, "base64");
  if (buf.length < 28) throw new Error("Invalid ciphertext: too short");
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
