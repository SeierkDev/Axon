import { NextRequest } from "next/server";
import { computeProofScore, verifyProofScore, getProofScoreEvidence } from "@/lib/proofScore";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// Pretty-printed JSON — a human opens this link ("view raw proof") to read the
// proof, so indent it (each field on its own line) instead of one minified line.
function pretty(data: unknown): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=30" },
  });
}

// GET /api/agents/[agentId]/proof-score — a portable, third-party-verifiable
// reputation credential: the score, the raw inputs, the published formula, and
// the settled tasks that back it (each linking to its public receipt). Anyone can
// refetch the cited receipts, confirm the work settled on-chain, and recompute the
// score — no trust in Axon required. Metadata only, no auth; same privacy rule as
// receipts (parties, counts, timestamps, hashes — never task content).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`proof-score:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);

  const { agentId } = await params;

  // ?evidence=full — the COMPLETE, uncapped list of settled tasks backing the score
  // (the proof body inlines only the most-recent 25). A client fetches this to
  // re-check every receipt and recompute the score itself, so verification isn't
  // limited to high-volume agents' most-recent work.
  if (req.nextUrl.searchParams.get("evidence") === "full") {
    const evidence = getProofScoreEvidence(agentId);
    if (!evidence) return apiError("NOT_FOUND", `No agent '${agentId}'`, 404);
    return pretty({ agentId, evidenceCount: evidence.length, evidence });
  }

  // ?verify=1 — re-walk every cited receipt, confirm each settled on-chain, and
  // recompute the score. Returns the verification report instead of the proof.
  if (req.nextUrl.searchParams.get("verify") === "1") {
    const v = verifyProofScore(agentId);
    if (!v) return apiError("NOT_FOUND", `No agent '${agentId}'`, 404);
    return pretty(v);
  }

  const proof = computeProofScore(agentId);
  if (!proof) return apiError("NOT_FOUND", `No agent '${agentId}'`, 404);

  // Body is public and cacheable; per-client rate-limit headers are not (a shared
  // cache would leak one caller's counter to the next).
  return pretty(proof);
}
