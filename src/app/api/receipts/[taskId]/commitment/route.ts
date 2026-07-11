import { NextRequest, NextResponse } from "next/server";
import { buildReceiptCommitment, discloseFields, DisclosureError } from "@/lib/selectiveDisclosure";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// GET /api/receipts/[taskId]/commitment
//   → the receipt's Merkle commitment: the root + the catalogue of disclosable
//     fields and predicates (never their values). Public, cacheable.
// GET /api/receipts/[taskId]/commitment?disclose=field1,field2
//   → a self-verifying DISCLOSURE bundle opening exactly those leaves. Everything
//     else on the receipt stays an opaque hash. (Receipts are public today, so
//     building a disclosure is open; when receipts carry private fields this
//     becomes owner-gated.)
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const rl = checkRateLimit(`receipt-commitment:${getClientIp(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { taskId } = await params;
  const disclose = req.nextUrl.searchParams.get("disclose");

  if (disclose) {
    const fields = disclose.split(",").map((f) => f.trim()).filter(Boolean);
    try {
      const bundle = discloseFields(taskId, fields);
      return NextResponse.json(bundle, { headers: { "Cache-Control": "public, max-age=30" } });
    } catch (e) {
      if (e instanceof DisclosureError) {
        return apiError(e.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", e.message, e.status);
      }
      return apiError("INTERNAL_ERROR", e instanceof Error ? e.message : "disclose failed", 500);
    }
  }

  const commitment = buildReceiptCommitment(taskId);
  if (!commitment) return apiError("NOT_FOUND", `No receipt for task '${taskId}'`, 404);
  return NextResponse.json(commitment, { headers: { "Cache-Control": "public, max-age=30" } });
}
