// GET /api/quorum/:quorumId
//
// Returns the quorum task status and individual agent results.
// Requires the caller to own the fromAgent (wallet address or registered agent).

import { NextRequest, NextResponse } from "next/server";
import { getQuorumTask, getQuorumResults } from "@/lib/quorum";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";

type Params = { params: Promise<{ quorumId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { quorumId } = await params;

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const quorum = getQuorumTask(quorumId);
  if (!quorum) {
    return apiError("NOT_FOUND", `Quorum '${quorumId}' not found`, 404);
  }

  if (!canAccessIdentity(auth.user, quorum.fromAgent)) {
    return apiError("FORBIDDEN", "API key does not have access to this quorum task", 403);
  }

  const results = getQuorumResults(quorumId);
  return NextResponse.json({ quorum, results });
}
