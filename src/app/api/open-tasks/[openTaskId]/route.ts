import { NextRequest, NextResponse } from "next/server";
import { getOpenTaskById, getBidsForOpenTask, cancelOpenTask } from "@/lib/bidding";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { apiError } from "@/lib/apiError";

// GET /api/open-tasks/[openTaskId] — an open task and all its bids (public).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ openTaskId: string }> }
) {
  const { openTaskId } = await params;
  const openTask = getOpenTaskById(openTaskId);
  if (!openTask) return apiError("NOT_FOUND", `Open task '${openTaskId}' not found`, 404);
  return NextResponse.json({ openTask, bids: getBidsForOpenTask(openTaskId) });
}

// DELETE /api/open-tasks/[openTaskId] — cancel an open task (poster only).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ openTaskId: string }> }
) {
  const { openTaskId } = await params;
  const rl = checkRateLimit(`open-tasks:${getClientIp(req)}`, 30, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const openTask = getOpenTaskById(openTaskId);
  if (!openTask) return apiError("NOT_FOUND", `Open task '${openTaskId}' not found`, 404);

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!canAccessIdentity(auth.user, openTask.fromAgent)) {
    return apiError("FORBIDDEN", "Only the task poster can cancel it", 403);
  }

  const cancelled = cancelOpenTask(openTaskId);
  if (!cancelled) return apiError("CONFLICT", "Open task is no longer open", 409);
  return NextResponse.json(cancelled);
}
