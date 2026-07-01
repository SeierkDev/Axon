import { createHash } from "crypto";
import { values as agenc } from "@tetsuo-ai/marketplace-sdk";

// AgenC integration — job-spec canonicalization.
//
// Axon pins each task's job spec by hash using AgenC's own canonical form
// (@tetsuo-ai/marketplace-sdk `canonicalJobSpecJson`, the `json-stable-v1`
// scheme). The resulting hash is byte-identical to AgenC's `canonicalJobSpecHash`,
// so a job spec pinned on Axon is verifiable against AgenC's protocol — this is a
// real interop point with their marketplace, not a re-implementation.
//
// See: https://github.com/tetsuo-ai/agenc-protocol

export const AGENC_JOB_SPEC_CANONICALIZATION = "json-stable-v1";

export interface AgencJobSpec {
  from: string;
  to: string;
  task: string;
  context: Record<string, unknown> | null;
  payment: string | null;
}

// AgenC's canonical JSON for a job spec (their SDK). Deterministic: object keys
// recursively sorted, undefined dropped, no whitespace.
export function agencCanonicalJobSpec(spec: AgencJobSpec): string {
  return agenc.canonicalJobSpecJson(spec);
}

// The AgenC canonical job-spec hash as 64-char lowercase hex. Synchronous:
// SHA-256 over AgenC's canonical JSON bytes, which their SDK documents as the
// exact digest source — so this equals `canonicalJobSpecHash(spec).hex`.
export function agencJobSpecHash(spec: AgencJobSpec): string {
  return createHash("sha256").update(agencCanonicalJobSpec(spec), "utf8").digest("hex");
}

// The same hash computed by AgenC's own async digest function. Kept so tests can
// assert byte-for-byte parity between our sync path and AgenC's implementation.
export async function agencJobSpecHashAsync(spec: AgencJobSpec): Promise<string> {
  const { hex } = await agenc.canonicalJobSpecHash(spec);
  return hex;
}
