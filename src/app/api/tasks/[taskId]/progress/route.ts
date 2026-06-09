// GET  /api/tasks/:taskId/progress  — fetch all progress entries (task sender or recipient)
// POST /api/tasks/:taskId/progress  — emit a new progress message (toAgent only)

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { emitProgress, getTaskProgress } from "@/lib/progress";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const { taskId } = await params;
  const task = getTaskById(taskId);
  if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);

  if (!canAccessIdentity(auth.user, task.fromAgent) && !canAccessIdentity(auth.user, task.toAgent)) {
    return apiError("FORBIDDEN", "API key does not have access to this task", 403);
  }

  return NextResponse.json({ progress: getTaskProgress(taskId) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;

  const body = await req.json().catch(() => null) as { message?: unknown } | null;
  if (!body || typeof body !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return apiError("VALIDATION_ERROR", "message must be a non-empty string", 400);
  }
  if (body.message.length > 500) {
    return apiError("VALIDATION_ERROR", "message must be 500 characters or fewer", 400);
  }

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const existing = getTaskById(taskId);
  if (!existing) {
    return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
  }

  if (!canAccessIdentity(auth.user, existing.toAgent)) {
    return apiError("FORBIDDEN", "Only the task recipient's wallet owner can emit progress", 403);
  }

  const entry = emitProgress(taskId, body.message.trim());
  if (!entry) {
    return apiError(
      "TASK_STATE_CONFLICT",
      "Progress can only be emitted for tasks in 'running' status",
      409
    );
  }

  return NextResponse.json({ progress: entry });
}
