// The secrets scrubber.
//
// Everything Axon writes to a trace or a receipt is meant to be public and
// verifiable. Secrets are the one thing that must never land there: if an agent's
// progress line, error, or metadata ever carried an API key, a bearer token, or a
// credential, redacting it here — BEFORE it's hashed and stored — keeps the proof
// intact and verifiable while the secret never leaves the machine.
//
// Precision over recall, deliberately. We match secrets by their KNOWN SHAPES
// (provider key prefixes, JWTs, `Bearer …`, `name=value` credential pairs) and
// never by generic length/entropy — because a Solana private key and a PUBLIC tx
// signature are both ~88 base58 chars, and a leaked hex key and a legitimate
// sha256 hash are indistinguishable by shape. A length rule would redact the very
// signatures and hashes the receipts exist to expose. So we don't use one.

// Each rule replaces a matched secret with a typed marker. Order matters: broader
// wrappers (Bearer) run before the token shapes they may contain.
const RULES: { re: RegExp; replace: (...args: string[]) => string }[] = [
  // JSON Web Tokens — three base64url segments.
  { re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, replace: () => "[REDACTED:jwt]" },
  // HTTP auth schemes — `Bearer <token>` / `Basic <base64>`. Keep the scheme,
  // redact the credential (also covers the Authorization header value).
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, replace: (_m, scheme: string) => `${scheme} [REDACTED]` },
  // Credentials embedded in a URL / connection string — `scheme://user:PASSWORD@host`
  // (postgres, mongodb+srv, redis, https basic-auth, …). Keep everything but the
  // password. The `@` and `:3,`-char minimum avoid matching `host:port/` URLs.
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^:/?#\s@]*:)([^@\s/]{3,})@/gi,
    replace: (_m, prefix: string) => `${prefix}[REDACTED]@`,
  },
  // Provider API keys, matched by their published prefixes (OpenAI, Anthropic,
  // xAI, GitHub, Slack, Google, AWS, Stripe). Precise prefixes avoid false hits.
  {
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,}|pk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghr_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g,
    replace: () => "[REDACTED:key]",
  },
  // `name = value` / `name: value` for sensitive names — redact only the value,
  // keep the key + operator so the shape stays readable. The optional identifier
  // prefix `[A-Za-z0-9_]*` catches env-var shapes (SOLANA_PRIVATE_KEY, XAI_API_KEY)
  // where the sensitive word sits at the tail of a longer name.
  {
    re: /(["']?)([A-Za-z0-9_]*(?:api[_-]?key|secret[_-]?key|private[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret|token))\1(\s*[:=]\s*)(["']?)([^\s"',;}\)]{6,})\4/gi,
    replace: (_m, keyQuote: string, name: string, sep: string, valQuote: string) =>
      `${keyQuote}${name}${keyQuote}${sep}${valQuote}[REDACTED]${valQuote}`,
  },
];

// Redact secret-shaped substrings from a single string. Returns it unchanged when
// there's nothing to scrub (the common case), so it's cheap on the hot path.
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of RULES) {
    out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

// Recursively scrub every string inside an object/array (used for trace-event
// metadata). Keys are left as-is; only values are scrubbed. Non-string leaves
// pass through untouched, so hashes, ids, and numbers are never altered.
export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrubSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out as T;
  }
  return value;
}
