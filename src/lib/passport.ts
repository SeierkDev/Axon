import { createHash, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { getAgentById } from "./agents";
import { getAttestationsForAgent } from "./attestations";
import { computeProofScore } from "./proofScore";

// The capability passport — an agent's record in a form that survives leaving Axon.
//
// Everything a buyer uses to choose an agent lives in our database today: what it can do, who
// vouched for it, what its work has been worth. That is fine while the agent only works here, and
// useless the moment it wants to work anywhere else. A network it shows up on has no way to read
// any of it, so the agent starts from nothing and its track record stays hostage to the place it
// was earned.
//
// A passport is that record written down so somebody else can check it. Three properties matter,
// and the design is all three:
//
//   Portable   — one self-contained document, no API access to Axon required to read it.
//   Tamper-evident — `contentHash` covers every claim. Change a capability, change the hash.
//   Checkable  — signed by the issuer, and every claim points at the public source it came from,
//                so a reader can confirm it against the receipts rather than believe it.
//
// The last one is what keeps this honest. A signature proves Axon issued the document; it does not
// prove the contents are true. A reader who doesn't want to take our word refetches the cited
// Proof Score and receipts and recomputes. Both paths are supported on purpose: the cheap check
// for a client sorting a list, the expensive one for a network deciding whether to trust us.

const PASSPORT_VERSION = "axon-passport-v1";
const ISSUER = "axon";

export interface PassportClaimSources {
  /** The Proof Score this passport quotes, recomputable from public receipts. */
  proofScore: string;
  /** Capability attestations, each naming the wallet that signed it. */
  attestations: string;
  /** The agent's public record on Axon. */
  agent: string;
}

export interface CapabilityPassport {
  version: string;
  issuer: string;
  /** The agent, as it is known on the issuing network. */
  subject: {
    agentId: string;
    name: string;
    /** The key the agent published for itself. The passport does not vouch for it. */
    publicKey: string;
    network: string;
  };
  capabilities: string[];
  /** Third parties who signed for a capability, by wallet. */
  attestations: { capability: string; verifier: string; attestedAt: string }[];
  /** The quoted score plus the hash of the proof bundle it came from, so a reader can tell
   *  whether the score it refetches is the same one this passport quoted. */
  reputation: {
    proofScore: number;
    tier: string;
    method: string;
    /** Settled tasks standing behind the score. */
    evidenceCount: number;
    settledEth: number;
    proofContentHash: string;
  } | null;
  /** What it charges, when it charges. A free-lane agent quotes nothing. */
  terms: { price: string | null; acceptsAxon: boolean };
  /** Where every claim above can be checked, without asking us to confirm it. */
  sources: PassportClaimSources;
  issuedAt: string;
  /** sha256 over the canonical document, excluding this field and `signature`. */
  contentHash: string;
  /** Present when the issuer holds a signing key. ed25519 over `contentHash`. */
  signature?: { algorithm: string; publicKey: string; value: string };
}

// Deterministic, sorted-key JSON. The same document must hash to the same value on every machine
// that builds it, or the hash is decoration.
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** The bytes a contentHash commits to: the whole document minus the fields derived from it. */
export function passportBody(p: CapabilityPassport): string {
  const body = { ...p } as Partial<CapabilityPassport>;
  delete body.contentHash;
  delete body.signature;
  return canonical(body);
}

/**
 * The issuer's signing key, when one is configured.
 *
 * Absent in development and on any deployment that hasn't been given one, and a passport is still
 * useful without it: the hash and the cited sources carry the weight. Signing adds the one thing
 * they can't, which is proof of who issued the document.
 */
function signingKey(): ReturnType<typeof createPrivateKey> | null {
  const raw = process.env.PASSPORT_SIGNING_KEY?.trim();
  if (!raw) return null;
  try {
    // A PKCS#8 PEM, newlines optionally escaped so it survives an env var.
    return createPrivateKey({ key: raw.replace(/\\n/g, "\n"), format: "pem" });
  } catch {
    return null;
  }
}

/** The public half, for anyone verifying a signature we produced. */
export function issuerPublicKey(): string | null {
  const key = signingKey();
  if (!key) return null;
  return createPublicKey(key).export({ type: "spki", format: "pem" }).toString().trim();
}

function signHash(contentHash: string): CapabilityPassport["signature"] {
  const key = signingKey();
  if (!key) return undefined;
  const pub = createPublicKey(key).export({ type: "spki", format: "pem" }).toString().trim();
  // ed25519 signs the message directly; the hash IS the message, so a verifier never needs the
  // full document to check the signature, only the hash it already recomputed.
  const value = nodeSign(null, Buffer.from(contentHash, "utf8"), key).toString("base64");
  return { algorithm: "ed25519", publicKey: pub, value };
}

/**
 * Build the passport for an agent, or null when no such agent exists.
 *
 * Read-only: it reports what the network already knows rather than deciding anything new. An agent
 * with no settled work gets a passport too, with `reputation: null` — a new agent having nothing to
 * show is a fact about the agent, not a reason to withhold the document.
 */
export function buildPassport(agentId: string, origin: string): CapabilityPassport | null {
  const agent = getAgentById(agentId);
  if (!agent) return null;

  const attestations = getAttestationsForAgent(agentId)
    .map((a) => ({ capability: a.capability, verifier: a.verifier, attestedAt: a.createdAt }))
    // Sorted, so two passports for an unchanged agent are byte-identical and hash the same.
    .sort((a, b) => (a.capability + a.verifier).localeCompare(b.capability + b.verifier));

  let reputation: CapabilityPassport["reputation"] = null;
  try {
    const proof = computeProofScore(agentId);
    if (proof) {
      reputation = {
        proofScore: proof.score,
        tier: proof.tier,
        method: proof.method.version,
        evidenceCount: proof.evidenceCount,
        settledEth: proof.inputs.settledEth,
        proofContentHash: proof.contentHash,
      };
    }
  } catch {
    // A score that cannot be computed leaves the field null rather than failing the passport.
  }

  const base: Omit<CapabilityPassport, "contentHash" | "signature"> = {
    version: PASSPORT_VERSION,
    issuer: ISSUER,
    subject: {
      agentId: agent.agentId,
      name: agent.name,
      publicKey: agent.publicKey,
      network: "eip155:4663",
    },
    capabilities: [...agent.capabilities].sort(),
    attestations,
    reputation,
    terms: { price: agent.price ?? null, acceptsAxon: agent.acceptsAxon === true },
    sources: {
      proofScore: `${origin}/api/agents/${encodeURIComponent(agentId)}/proof-score`,
      attestations: `${origin}/api/agents/${encodeURIComponent(agentId)}/attestations`,
      agent: `${origin}/api/agents/${encodeURIComponent(agentId)}`,
    },
    // Deliberately not a timestamp of "now" to the millisecond: a passport fetched twice in a
    // second would otherwise carry two different hashes and look like it had changed. The date is
    // the resolution that matters for a credential.
    issuedAt: new Date().toISOString().slice(0, 10),
  };

  const contentHash = sha256hex(canonical(base));
  const signature = signHash(contentHash);
  return signature ? { ...base, contentHash, signature } : { ...base, contentHash };
}

export interface PassportVerification {
  valid: boolean;
  checks: {
    /** The document hashes to the contentHash it carries. */
    contentHash: { ok: boolean; expected: string; found: string };
    /** The signature is the issuer's, over that hash. Skipped when unsigned. */
    signature: { ok: boolean; checked: boolean; reason?: string };
    /** The claims still match what the issuing network reports right now. */
    freshness: { checked: boolean; ok: boolean; drift: string[] };
  };
  /** Plain-language summary, for a caller that just wants a yes or no and a reason. */
  summary: string;
}

/**
 * Check a passport somebody handed you.
 *
 * Three questions, answered separately because they fail for different reasons and a caller may
 * care about only one. Is the document internally consistent (hash)? Did we issue it (signature)?
 * Does it still describe the agent (freshness)? A passport can be genuine and stale, which is not
 * fraud — it is a document that was true when it was issued, and saying so is more useful than a
 * bare "invalid".
 */
export function verifyPassport(passport: CapabilityPassport, origin: string): PassportVerification {
  const expected = sha256hex(passportBody(passport));
  const found = passport.contentHash ?? "";
  const hashOk = expected === found;

  let sig = { ok: false, checked: false } as PassportVerification["checks"]["signature"];
  if (passport.signature) {
    sig = { ok: false, checked: true };
    try {
      const pub = createPublicKey({ key: passport.signature.publicKey, format: "pem" });
      const ok = nodeVerify(
        null,
        Buffer.from(found, "utf8"),
        pub,
        Buffer.from(passport.signature.value, "base64"),
      );
      // Whose key is it? Verifying against the key carried inside the document proves only that
      // whoever wrote the document also signed it, which a forger can do for free with a key they
      // generated. The signature is worth something only when the key is the issuer's, so when we
      // hold that key we compare, and refuse a document signed by anything else.
      const ours = issuerPublicKey();
      const normalise = (k: string) => k.replace(/\s+/g, "");
      const issuerMatches = ours === null || normalise(ours) === normalise(passport.signature.publicKey);

      if (!ok) sig = { ok: false, checked: true, reason: "signature does not verify against the stated public key" };
      else if (!issuerMatches) sig = { ok: false, checked: true, reason: "signed by a key that is not the issuer's" };
      // A signature over a hash the document does not actually have proves nothing about the
      // document, so it only counts once the hash itself checks out.
      else if (!hashOk) sig = { ok: false, checked: true, reason: "signature is over a hash the document does not match" };
      else sig = { ok: true, checked: true };
    } catch {
      sig = { ok: false, checked: true, reason: "public key could not be read" };
    }
  }

  // Freshness needs the agent to still be here. A passport for an agent that has left the network
  // is not checkable against it, which is reported rather than treated as a forgery.
  const drift: string[] = [];
  let freshnessChecked = false;
  const current = passport.subject?.agentId ? buildPassport(passport.subject.agentId, origin) : null;
  if (current) {
    freshnessChecked = true;
    if (current.contentHash !== found) {
      const a = passport;
      const b = current;
      if (canonical(a.capabilities) !== canonical(b.capabilities)) drift.push("capabilities");
      if (canonical(a.attestations) !== canonical(b.attestations)) drift.push("attestations");
      if ((a.reputation?.proofScore ?? null) !== (b.reputation?.proofScore ?? null)) drift.push("proofScore");
      if (canonical(a.terms) !== canonical(b.terms)) drift.push("terms");
      if (a.subject.name !== b.subject.name) drift.push("name");
      if (a.subject.publicKey !== b.subject.publicKey) drift.push("publicKey");
      // Nothing moved that a reader would act on, so the difference is the issue date alone.
      if (drift.length === 0) drift.push("issuedAt");
    }
  }

  const stale = freshnessChecked && drift.length > 0 && !(drift.length === 1 && drift[0] === "issuedAt");
  const valid = hashOk && (!passport.signature || sig.ok);

  let summary: string;
  if (!hashOk) summary = "This document has been altered since it was issued.";
  else if (passport.signature && !sig.ok) summary = sig.reason ?? "The signature did not verify.";
  else if (!freshnessChecked) summary = "Genuine. The agent is not on this network, so its current record could not be compared.";
  else if (stale) summary = `Genuine, and out of date: ${drift.join(", ")} changed since it was issued.`;
  else summary = "Genuine, and it still matches the agent's record.";

  return {
    valid,
    checks: {
      contentHash: { ok: hashOk, expected, found },
      signature: sig,
      freshness: { checked: freshnessChecked, ok: !stale, drift },
    },
    summary,
  };
}
