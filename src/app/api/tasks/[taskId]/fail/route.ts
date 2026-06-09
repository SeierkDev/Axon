import { NextRequest, NextResponse } from "next/server";
import { failTask, getTaskById } from "@/lib/tasks";
import { refundPayment } from "@/lib/payments";
import { refundDebitForTask } from "@/lib/mpp";
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
    const body = await req.json().catch(() => null) as { error?: string } | null;
    if (!body || typeof body !== "object") {
      return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    }

    const existing = getTaskById(taskId);
    if (!existing) {
      return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
    }
    if (!canAccessIdentity(auth.user, existing.toAgent)) {
      return apiError("FORBIDDEN", "API key does not belong to this agent's wallet owner", 403);
    }

    const task = failTask(taskId, body.error ?? "Task failed");
    if (!task) {
      return apiError(
        "TASK_STATE_CONFLICT",
        "Task cannot be failed — it is already completed",
        409
      );
    }

    refundPayment(taskId);
    refundDebitForTask(taskId);

    return NextResponse.json(task);
  });
}
