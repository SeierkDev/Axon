// The secrets scrubber. These lock BOTH sides of the contract:
//  - real secrets (provider keys, JWTs, Bearer, name=value creds) are redacted,
//  - the public data a receipt is built from (sha256 hashes, Solana pubkeys, tx
//    signatures, uuids, model ids) is left byte-for-byte intact.
// The false-positive guards matter as much as the redactions — a scrubber that
// ate signatures or hashes would break the very proofs it protects.

import { describe, it, expect } from "vitest";
import { scrubSecrets, scrubDeep } from "@/lib/scrubSecrets";

describe("scrubSecrets — redacts real secrets", () => {
  const secrets: [string, string][] = [
    ["OpenAI project key", "sk-proj-abcdefghijklmnop1234567890QRSTUV"],
    ["OpenAI service-account key", "sk-svcacct-AbCdEf1234567890ghijklmnop"],
    ["OpenAI admin key", "sk-admin-AbCdEf1234567890ghijklmnop"],
    ["Stripe webhook secret", "whsec_abcdefghij1234567890ABCDEFGH"],
    ["OpenAI key", "sk-abcdefghijklmnopqrstuvwxyz0123"],
    ["Anthropic key", "sk-ant-api03-AbCdEf1234567890abcdefghijKL"],
    ["xAI key", "xai-abcdefghij1234567890ABCDEFGH"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub fine-grained PAT", "github_pat_11ABCDEFG0aBcDeFgHiJk_lMnOpQrStUvWxYz1234567890AbCdE"],
    ["npm token", "npm_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["AWS access key", "AKIAIOSFODNN7EXAMPLE"],
    ["Google key", "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36"],
  ];
  it.each(secrets)("redacts a %s", (_label, secret) => {
    const out = scrubSecrets(`auth failed with ${secret} — retry`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED");
  });

  it("redacts a Bearer token but keeps the scheme", () => {
    const out = scrubSecrets("Authorization: Bearer abcDEF123456ghijKLMNop");
    expect(out).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts the value of a name=value credential, keeping the key", () => {
    expect(scrubSecrets("password=SuperSecretHunter2")).toBe("password=[REDACTED]");
    expect(scrubSecrets('api_key: "topsecretvalue123"')).toBe('api_key: "[REDACTED]"');
    expect(scrubSecrets("client_secret = abcdef123456")).toBe("client_secret = [REDACTED]");
  });

  it("redacts env-var-style secrets where the sensitive word is a suffix", () => {
    // the underscore prefix used to defeat the \b boundary — the common real case
    expect(scrubSecrets("SOLANA_PRIVATE_KEY=4Vbno9xYz1234567890abcdefghij")).toBe("SOLANA_PRIVATE_KEY=[REDACTED]");
    expect(scrubSecrets("XAI_API_KEY=xai-abcdef1234567890ABCDEFGH")).toBe("XAI_API_KEY=[REDACTED]");
    expect(scrubSecrets("DB_PASSWORD: hunter2secret")).toBe("DB_PASSWORD: [REDACTED]");
  });

  it("does NOT over-redact non-secret keys (public_key, idempotency_key, tokenizer)", () => {
    const pub = "public_key=So11111111111111111111111111111111111111112";
    expect(scrubSecrets(pub)).toBe(pub);
    expect(scrubSecrets("idempotency_key=order-12345")).toBe("idempotency_key=order-12345");
    expect(scrubSecrets("tokenizer=utf8")).toBe("tokenizer=utf8");
  });

  it("redacts a secret in a JSON object (quoted key + quoted value, both quote styles)", () => {
    expect(scrubSecrets('{"password":"hunter2secretvalue"}')).toBe('{"password":"[REDACTED]"}');
    expect(scrubSecrets('{"api_key":"sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"}')).toBe('{"api_key":"[REDACTED]"}');
    expect(scrubSecrets("{'secret':'mysecretvalue123'}")).toBe("{'secret':'[REDACTED]'}");
    // a non-secret field in the same shape is untouched
    expect(scrubSecrets('{"price":"0.002"}')).toBe('{"price":"0.002"}');
  });

  it("redacts the password in a URL / connection string, keeps the rest", () => {
    expect(scrubSecrets("postgres://admin:S3cretPass@db.host:5432/mydb")).toBe("postgres://admin:[REDACTED]@db.host:5432/mydb");
    expect(scrubSecrets("redis://:redisPassw0rd@127.0.0.1:6379")).toBe("redis://:[REDACTED]@127.0.0.1:6379");
    expect(scrubSecrets("https://user:hunter2secret@internal.example.com/x")).toBe("https://user:[REDACTED]@internal.example.com/x");
  });

  it("does NOT touch host:port URLs or ssh remotes (no embedded password)", () => {
    expect(scrubSecrets("http://db.internal:5432/health")).toBe("http://db.internal:5432/health");
    expect(scrubSecrets("git@github.com:SeierkDev/Axon.git")).toBe("git@github.com:SeierkDev/Axon.git");
  });
});

describe("scrubSecrets — never touches public, receipt-critical data", () => {
  const keep = [
    ["sha256 hash", "a".repeat(64)],
    ["another sha256", "3b1f8c2d4e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2"],
    ["Solana pubkey", "So11111111111111111111111111111111111111112"],
    ["USDC mint", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ["tx signature (~88 base58)", "5wHu1qwD4kLm2nPq3rStUvWxYz1A2B3C4D5E6F7G8H9J1K2L3M4N5P6Q7R8S9T1U2V3W4X5Y6Z7a8b9c1d2e3f"],
    ["uuid task id", "9e552cd7-1a2b-4c3d-8e9f-0a1b2c3d4e5f"],
    ["model id", "claude-opus-4-8"],
    ["plain text", "the task completed successfully in 1240ms"],
  ];
  it.each(keep)("leaves a %s untouched", (_label, value) => {
    expect(scrubSecrets(value)).toBe(value);
  });
});

describe("scrubDeep — recurses, redacts only string values", () => {
  it("scrubs strings anywhere in a nested object, keeps structure + non-strings", () => {
    const out = scrubDeep({
      errorClass: "AuthError",
      error: "provider rejected key sk-ant-api03-AbCdEf1234567890abcdefghijKL",
      sha: "a".repeat(64),
      inputTokens: 512,
      nested: { note: "used xai-abcdefghij1234567890ABCDEFGH" },
      list: ["clean", "token=leakedsecretvalue"],
    });
    expect(out.errorClass).toBe("AuthError"); // not a secret name, kept
    expect(out.error).toContain("[REDACTED");
    expect(out.error).not.toContain("sk-ant");
    expect(out.sha).toBe("a".repeat(64)); // hash preserved
    expect(out.inputTokens).toBe(512); // number preserved
    expect((out.nested as { note: string }).note).not.toContain("xai-");
    expect((out.list as string[])[0]).toBe("clean");
    expect((out.list as string[])[1]).toBe("token=[REDACTED]");
  });

  it("passes null/undefined/empty through unchanged", () => {
    expect(scrubSecrets("")).toBe("");
    expect(scrubDeep(null)).toBe(null);
    expect(scrubDeep(42)).toBe(42);
  });
});
