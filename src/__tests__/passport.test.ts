// The capability passport: a record that survives leaving the network.
//
// The thing under test is not "does it return JSON". It is whether the document is still worth
// anything once it is out of our hands: does tampering show, does a signature mean what it claims,
// and does a reader get told the difference between a forgery and a document that is simply old.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { buildPassport, verifyPassport, passportBody, issuerPublicKey } from "@/lib/passport";

const ORIGIN = "https://axon-agents.com";

const seed = (id: string, price: string | null = null, caps = ["research", "analysis"]) => {
  const db = getDb();
  db.prepare("DELETE FROM agents WHERE agent_id = ?").run(id);
  db.prepare(
    `INSERT INTO agents (agent_id, name, capabilities, public_key, verification_status, created_at, price, description)
     VALUES (?, ?, ?, ?, 'verified', ?, ?, ?)`,
  ).run(id, `Passport ${id}`, JSON.stringify(caps), `key-${id}`, new Date().toISOString(), price, "does things");
  for (const c of caps) {
    db.prepare("INSERT OR IGNORE INTO agent_capabilities (capability, agent_id) VALUES (?, ?)").run(c, id);
  }
};

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
};

describe("the document itself", () => {
  beforeEach(() => seed("pp-basic", "0.0002 ETH"));

  it("carries the agent's record without needing an account to read it", () => {
    const p = buildPassport("pp-basic", ORIGIN)!;

    expect(p.subject.agentId).toBe("pp-basic");
    expect(p.capabilities).toEqual(["analysis", "research"]);
    expect(p.terms.price).toBe("0.0002 ETH");
    // Every claim names where it came from, so a reader can check rather than believe.
    expect(p.sources.proofScore).toContain("/proof-score");
    expect(p.sources.attestations).toContain("/attestations");
  });

  it("hashes the same on every build, so an unchanged agent has an unchanged passport", () => {
    // If the hash moved on its own, a reader could never tell a real edit from noise, and the
    // tamper-evidence would be worthless.
    expect(buildPassport("pp-basic", ORIGIN)!.contentHash).toBe(buildPassport("pp-basic", ORIGIN)!.contentHash);
  });

  it("commits to the claims, not to the hash of itself", () => {
    const p = buildPassport("pp-basic", ORIGIN)!;
    const recomputed = createHash("sha256").update(passportBody(p), "utf8").digest("hex");

    expect(recomputed).toBe(p.contentHash);
  });

  it("can be recomputed by anyone who knows the algorithm and nothing else", () => {
    // The whole portability claim rests on this: no Axon code required.
    const p = buildPassport("pp-basic", ORIGIN)!;
    const body = { ...p } as Record<string, unknown>;
    delete body.contentHash;
    delete body.signature;

    expect(createHash("sha256").update(canonical(body), "utf8").digest("hex")).toBe(p.contentHash);
  });

  it("sorts capabilities and attestations, so ordering never changes the hash", () => {
    seed("pp-order", null, ["zeta", "alpha", "mid"]);
    expect(buildPassport("pp-order", ORIGIN)!.capabilities).toEqual(["alpha", "mid", "zeta"]);
  });

  it("gives a free-lane agent a passport too, quoting no price", () => {
    seed("pp-free", null);
    const p = buildPassport("pp-free", ORIGIN)!;

    // A new or free agent having little to show is a fact about the agent. Withholding the
    // document would make the format useless for exactly the agents that need to prove themselves.
    expect(p.terms.price).toBeNull();
    expect(p.contentHash).toBeTruthy();
  });

  it("returns nothing for an agent that does not exist", () => {
    expect(buildPassport("pp-nobody", ORIGIN)).toBeNull();
  });
});

describe("checking one somebody handed you", () => {
  beforeEach(() => seed("pp-verify", "0.0001 ETH"));

  it("accepts an untouched document", () => {
    const v = verifyPassport(buildPassport("pp-verify", ORIGIN)!, ORIGIN);

    expect(v.valid).toBe(true);
    expect(v.checks.contentHash.ok).toBe(true);
  });

  it("catches a capability that was added after issue", () => {
    const p = buildPassport("pp-verify", ORIGIN)!;
    p.capabilities.push("nuclear-engineering");

    const v = verifyPassport(p, ORIGIN);
    // The attack this exists to stop: take a real passport, add a skill, present it elsewhere.
    expect(v.valid).toBe(false);
    expect(v.summary).toContain("altered");
  });

  it("catches a score that was raised after issue", () => {
    const p = buildPassport("pp-verify", ORIGIN)!;
    p.reputation = { proofScore: 999, tier: "Elite", method: "proof-score-v2", evidenceCount: 9999, settledEth: 500, proofContentHash: "x" };

    expect(verifyPassport(p, ORIGIN).valid).toBe(false);
  });

  it("catches a price edited on the way", () => {
    const p = buildPassport("pp-verify", ORIGIN)!;
    p.terms.price = "0.5 ETH";

    expect(verifyPassport(p, ORIGIN).valid).toBe(false);
  });

  it("catches a swapped subject", () => {
    const p = buildPassport("pp-verify", ORIGIN)!;
    p.subject.agentId = "someone-else";

    expect(verifyPassport(p, ORIGIN).valid).toBe(false);
  });

  it("reports an unknown agent as genuine but uncheckable, rather than invalid", () => {
    const p = buildPassport("pp-verify", ORIGIN)!;
    getDb().prepare("DELETE FROM agents WHERE agent_id = ?").run("pp-verify");

    const v = verifyPassport(p, ORIGIN);
    // A network reading a passport for an agent it has never seen is the normal case for a
    // portable credential. Calling that invalid would defeat the purpose.
    expect(v.valid).toBe(true);
    expect(v.checks.freshness.checked).toBe(false);
    expect(v.summary).toContain("not on this network");
  });

  it("separates out of date from forged", () => {
    const p = buildPassport("pp-verify", ORIGIN)!;
    getDb().prepare("UPDATE agents SET price = ? WHERE agent_id = ?").run("0.004 ETH", "pp-verify");

    const v = verifyPassport(p, ORIGIN);
    // Still genuine: we issued it and nobody edited it. It just describes an older state, and
    // saying so is more useful to a reader than a bare rejection.
    expect(v.valid).toBe(true);
    expect(v.checks.freshness.ok).toBe(false);
    expect(v.checks.freshness.drift).toContain("terms");
    expect(v.summary).toContain("out of date");
  });
});

describe("the signature", () => {
  const original = process.env.PASSPORT_SIGNING_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.PASSPORT_SIGNING_KEY;
    else process.env.PASSPORT_SIGNING_KEY = original;
  });

  const withKey = () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.PASSPORT_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  };

  beforeEach(() => seed("pp-signed", "0.0003 ETH"));

  it("is absent when no key is configured, and the passport still works", () => {
    delete process.env.PASSPORT_SIGNING_KEY;
    const p = buildPassport("pp-signed", ORIGIN)!;

    // The hash and the cited sources carry it. Signing adds provenance, it is not load-bearing
    // for the document being useful.
    expect(p.signature).toBeUndefined();
    expect(verifyPassport(p, ORIGIN).valid).toBe(true);
    expect(issuerPublicKey()).toBeNull();
  });

  it("verifies against the key it publishes", () => {
    withKey();
    const p = buildPassport("pp-signed", ORIGIN)!;

    expect(p.signature?.algorithm).toBe("ed25519");
    const v = verifyPassport(p, ORIGIN);
    expect(v.checks.signature.checked).toBe(true);
    expect(v.checks.signature.ok).toBe(true);
    expect(v.valid).toBe(true);
  });

  it("refuses a document somebody signed with a key of their own", () => {
    // The forgery worth worrying about: mint a keypair, write whatever passport you like, sign it.
    // It is internally consistent and self-verifies, so checking the signature against the key
    // inside the document proves nothing at all.
    withKey();
    const forged = buildPassport("pp-signed", ORIGIN)!;

    // Now the real issuer key is a different one.
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.PASSPORT_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    expect(forged.signature!.publicKey).not.toBe(issuerPublicKey());
    const v = verifyPassport(forged, ORIGIN);
    expect(v.valid).toBe(false);
    expect(v.checks.signature.reason).toContain("not the issuer");
  });

  it("does not let a valid signature rescue an edited document", () => {
    withKey();
    const p = buildPassport("pp-signed", ORIGIN)!;
    p.capabilities.push("forged-skill");

    // The signature still checks out against the hash it was made over — that hash is simply no
    // longer this document's. Counting it as valid would let anyone edit a signed passport freely.
    const v = verifyPassport(p, ORIGIN);
    expect(v.valid).toBe(false);
    expect(v.checks.contentHash.ok).toBe(false);
    expect(v.checks.signature.ok).toBe(false);
  });

  it("signs the hash, so a checker needs the hash and nothing else", () => {
    withKey();
    const p = buildPassport("pp-signed", ORIGIN)!;

    expect(p.signature!.value).toBeTruthy();
    expect(p.signature!.publicKey).toContain("BEGIN PUBLIC KEY");
  });
});
