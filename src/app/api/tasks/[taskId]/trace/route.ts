import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { getDb } from "@/lib/db";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const { taskId } = await params;

  const task = getTaskById(taskId);
  if (!task) {
    return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
  }
  if (!canAccessIdentity(auth.user, task.fromAgent) && !canAccessIdentity(auth.user, task.toAgent)) {
    return apiError("FORBIDDEN", "API key does not have access to this task", 403);
  }

  const traceId = task.traceId ?? null;

  const related = traceId
    ? (getDb()
        .prepare("SELECT * FROM tasks WHERE trace_id = ? AND task_id != ? ORDER BY created_at ASC")
        .all(traceId, taskId) as { task_id: string; to_agent: string; from_agent: string; status: string; created_at: string }[])
        .map((r) => ({
          taskId: r.task_id,
          toAgent: r.to_agent,
          fromAgent: r.from_agent,
          status: r.status,
          createdAt: r.created_at,
        }))
    : [];

  return NextResponse.json({ traceId, taskId, relatedTasks: related });
}
