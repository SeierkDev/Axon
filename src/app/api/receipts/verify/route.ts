import { NextRequest, NextResponse } from "next/server";
import { verifyBundle, buildReceiptCommitment } from "@/lib/selectiveDisclosure";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

// A genuine bundle for a 21-field receipt is a few KB; this is generous headroom
// while capping the body an untrusted caller can push through the verifier.
const MAX_BODY_BYTES = 256_000;

// POST /api/receipts/verify
//   body: a disclosure bundle { taskId, root, algorithm, disclosures }
//   → checks every opened leaf folds to the bundle's root (self-consistency),
//     AND re-derives the receipt's REAL root from the task to confirm the bundle
//     is committing the genuine receipt (authenticity). Fully public — a caller
//     can also verify the folding offline from the published algorithm.
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`receipt-verify:${getClientIp(req)}`, 60, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  // Bound the body before parsing — the verifier's cost scales with the input.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return apiError("INVALID_JSON", "could not read body", 400);
  }
  if (raw.length > MAX_BODY_BYTES) return apiError("VALIDATION_ERROR", "bundle too large", 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return apiError("INVALID_JSON", "invalid JSON", 400);
  }

  // verifyBundle.valid = the openings are internally consistent (each leaf folds
  // to the bundle's own root). That alone doesn't prove the bundle describes a
  // REAL Axon receipt — a fabricated bundle folds to its own fabricated root.
  // Bounded + guarded: no adversarial body should ever 500 this endpoint.
  let result;
  try {
    result = verifyBundle(body);
  } catch {
    return apiError("VALIDATION_ERROR", "malformed disclosure bundle", 400);
  }
  const folds = result.valid;

  // Authenticity: the bundle must name a taskId whose real receipt commitment has
  // exactly this root. No taskId, no receipt, or a mismatched root → not authentic.
  // Re-derivation touches the DB, so it's guarded too — an error degrades to
  // "not authenticated", never a 500.
  let authentic = false;
  try {
    if (!result.taskId) {
      result.errors.push("bundle is missing taskId — cannot authenticate against a receipt");
    } else if (!result.root) {
      result.errors.push("bundle is missing root");
    } else {
      const real = buildReceiptCommitment(result.taskId);
      if (!real) result.errors.push(`no receipt found for task '${result.taskId}'`);
      else if (real.root !== result.root) result.errors.push("root does not match the receipt's commitment");
      else authentic = true;
    }
  } catch {
    result.errors.push("could not verify authenticity");
  }

  // The trust signal: the openings fold AND the root is the genuine receipt's.
  // Only surface verified facts when the bundle is genuinely trusted — a
  // downstream consumer that renders `verified` must never see attacker values.
  const valid = folds && authentic;
  return NextResponse.json(
    { valid, folds, authentic, taskId: result.taskId, root: result.root, verified: valid ? result.verified : [], errors: result.errors },
    { headers: { "Cache-Control": "no-store" } },
  );
}
