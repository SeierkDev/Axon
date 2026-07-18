import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { claimTokenValid } from "@/lib/mcpServer";
import { apiError } from "@/lib/apiError";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;

  // A claimToken (issued to an anonymous hire) is the read permission for THIS
  // task's output — checked first so a browser hire can poll without an API key.
  // Sent as a header, never the URL query, so it never lands in access logs or
  // browser history. (The legacy query form is still accepted for compatibility.)
  const claimToken = req.headers.get("x-claim-token") ?? req.nextUrl.searchParams.get("claimToken");
  if (claimToken) {
    const task = getTaskById(taskId);
    if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
    if (!claimTokenValid(taskId, claimToken)) {
      return apiError("FORBIDDEN", "Invalid claim token for this task", 403);
    }
    return NextResponse.json(task);
  }

  // Otherwise fall back to API-key auth (owner of the from/to agent).
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const task = getTaskById(taskId);
  if (!task) {
    return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
  }
  if (!canAccessIdentity(auth.user, task.fromAgent) && !canAccessIdentity(auth.user, task.toAgent)) {
    return apiError("FORBIDDEN", "API key does not have access to this task", 403);
  }
  return NextResponse.json(task);
}
