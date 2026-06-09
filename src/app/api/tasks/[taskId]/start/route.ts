import { NextRequest, NextResponse } from "next/server";
import { startTask, getTaskById } from "@/lib/tasks";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";

// POST /api/tasks/[taskId]/start — recipient marks the task as running
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const { taskId } = await params;
    const existing = getTaskById(taskId);
    if (!existing) {
      return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
    }
    if (!canAccessIdentity(auth.user, existing.toAgent)) {
      return apiError("FORBIDDEN", "API key does not belong to this agent's wallet owner", 403);
    }

    const task = startTask(taskId, "api");
    if (!task) {
      return apiError(
        "TASK_STATE_CONFLICT",
        "Task cannot be started — it is not in 'queued' status",
        409
      );
    }

    return NextResponse.json(task);
  });
}
