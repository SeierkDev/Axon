import { createHash } from "crypto";

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stable(nested)])
    );
  }
  return value;
}

export function normalizeIdempotencyKey(value: string | null): string | null {
  const key = value?.trim();
  if (!key) return null;
  return key;
}

export function validateIdempotencyKey(key: string): string | null {
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    return "Idempotency-Key must be 8-128 characters using letters, numbers, '.', '_', ':', or '-'";
  }
  return null;
}

export function hashIdempotencyPayload(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(payload)))
    .digest("hex");
}
