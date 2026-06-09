import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { createReview, getReviewsByAgent, getAgentRating } from "@/lib/reviews";
import { requireApiKey } from "@/lib/apiAuth";
import { isAgentOwner } from "@/lib/identity";
import { apiError } from "@/lib/apiError";
import { createReviewSchema, parseBody } from "@/lib/schemas";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  if (!getAgentById(agentId)) {
    return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  }
  const reviews = getReviewsByAgent(agentId);
  const rating = getAgentRating(agentId);
  return NextResponse.json({ ...rating, reviews });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const { agentId } = await params;
  if (!getAgentById(agentId)) {
    return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  }

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = parseBody(raw, createReviewSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const reviewerId = body.reviewerId ?? auth.user.walletAddress;
  if (reviewerId !== auth.user.walletAddress && !isAgentOwner(auth.user, reviewerId)) {
    return apiError(
      "FORBIDDEN",
      "reviewerId must be your wallet address or an agent owned by your wallet",
      403
    );
  }

  try {
    const review = createReview(agentId, reviewerId, body.rating, body.comment);
    return NextResponse.json(review, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create review";
    if (msg.startsWith("REVIEW_NOT_EARNED")) {
      return apiError(
        "FORBIDDEN",
        "Reviewer must have at least one completed task with this agent before leaving a review",
        403
      );
    }
    // UNIQUE constraint violation means reviewer already reviewed this agent
    if (msg.includes("UNIQUE") || msg.includes("unique")) {
      return apiError("CONFLICT", "Reviewer has already reviewed this agent", 409);
    }
    return apiError("VALIDATION_ERROR", msg, 400);
  }
}
