import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
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
  return NextResponse.json(task);
}
