import { NextRequest, NextResponse } from "next/server";
import { completeTask, getTaskById } from "@/lib/tasks";
import { settleCompletedTask } from "@/lib/sla";
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
    const body = await req.json().catch(() => null) as { output?: string } | null;
    if (!body || typeof body !== "object") {
      return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    }

    if (!body.output) {
      return apiError("VALIDATION_ERROR", "output is required", 400);
    }
    const existing = getTaskById(taskId);
    if (!existing) {
      return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
    }
    if (!canAccessIdentity(auth.user, existing.toAgent)) {
      return apiError("FORBIDDEN", "API key does not belong to this agent's wallet owner", 403);
    }

    const task = completeTask(taskId, body.output);
    if (!task) {
      return apiError(
        "TASK_STATE_CONFLICT",
        "Task cannot be completed — it is not in 'running' status",
        409
      );
    }

    settleCompletedTask(taskId);

    return NextResponse.json(task);
  });
}
