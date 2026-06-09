// POST /api/tasks/:taskId/requeue
// Re-queues a failed task for retry. Only callable by the task sender or recipient's wallet.

import { NextRequest, NextResponse } from "next/server";
import { getTaskById, requeueTask } from "@/lib/tasks";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const { taskId } = await params;
    const task = getTaskById(taskId);
    if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);

    const canAccess =
      canAccessIdentity(auth.user, task.fromAgent) ||
      canAccessIdentity(auth.user, task.toAgent);
    if (!canAccess) return apiError("FORBIDDEN", "API key does not have access to this task", 403);

    if (task.status !== "failed") {
      return apiError("VALIDATION_ERROR", `Task is '${task.status}' — only failed tasks can be requeued`, 400);
    }

    const requeued = requeueTask(taskId);
    if (!requeued) return apiError("INTERNAL_ERROR", "Task could not be requeued", 500);

    return NextResponse.json(requeued);
  });
}
