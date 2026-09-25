import { NextRequest, NextResponse } from "next/server";
import { verifyPassport, issuerPublicKey, type CapabilityPassport } from "@/lib/passport";
import { publicOrigin } from "@/lib/publicUrl";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// A passport is a few KB. This is room to spare while capping what an untrusted caller can push
// through the hasher.
const MAX_BODY_BYTES = 128_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * POST /api/passports/verify
 *
 * Hand it a passport, get back what is true about it: whether the document is unaltered, whether
 * the signature is ours, and whether it still matches the agent's record today.
 *
 * Offered as a convenience, not as the authority. The whole point of the format is that a reader
 * can do this themselves from the published algorithm — sha256 over the canonical document, then
 * an ed25519 check against the key below. Anyone who would rather not trust our answer about our
 * own signature should run it locally, and the docs say how.
 */
export async function POST(req: NextRequest) {
  const rl = checkRateLimit(`passport-verify:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return apiError("INVALID_JSON", "Could not read the request body", 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return apiError("VALIDATION_ERROR", `Passport is larger than ${MAX_BODY_BYTES} bytes`, 413);
  }

  let passport: CapabilityPassport;
  try {
    passport = JSON.parse(raw) as CapabilityPassport;
  } catch {
    return apiError("INVALID_JSON", "Request body must be a passport document in JSON", 400);
  }
  if (!passport || typeof passport !== "object" || Array.isArray(passport)) {
    return apiError("VALIDATION_ERROR", "Request body must be a passport object", 400);
  }
  if (typeof passport.contentHash !== "string" || !passport.contentHash) {
    return apiError("VALIDATION_ERROR", "Not a passport: no contentHash", 400);
  }

  const result = verifyPassport(passport, publicOrigin(req));
  // Always 200. The question "is this passport valid" was answered; a forged document is a
  // successful check with a negative answer, not a failed request.
  return NextResponse.json(result, { headers: CORS });
}

/**
 * GET /api/passports/verify
 *
 * The issuer's public key and the algorithm, so a passport can be checked without calling this
 * endpoint at all.
 */
export async function GET() {
  const publicKey = issuerPublicKey();
  return NextResponse.json(
    {
      issuer: "axon",
      version: "axon-passport-v1",
      algorithm: "ed25519",
      publicKey,
      signed: publicKey !== null,
      howToVerify: [
        "1. Remove `contentHash` and `signature` from the document.",
        "2. Serialise what is left as JSON with every object's keys sorted, recursively.",
        "3. sha256 that string. It must equal the document's `contentHash`.",
        "4. ed25519-verify `signature.value` (base64) against the contentHash string, using this publicKey.",
        "5. For the claims themselves, refetch the URLs in `sources` and compare.",
      ],
    },
    { headers: { "Cache-Control": "public, max-age=3600", ...CORS } },
  );
}
