import { NextRequest, NextResponse } from "next/server";
import { getTasksByAgent } from "@/lib/tasks";
import { requireAgentOwner } from "@/lib/apiAuth";
import type { TaskStatus } from "@/lib/tasks";
import { apiError } from "@/lib/apiError";

// GET /api/agents/[agentId]/tasks — task history (sent and received)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const roleParam = req.nextUrl.searchParams.get("role") ?? "both";
  const validRoles = ["sender", "recipient", "both"] as const;
  if (!validRoles.includes(roleParam as typeof validRoles[number])) {
    return apiError("VALIDATION_ERROR", "role must be sender, recipient, or both", 400);
  }
  const role = roleParam as "sender" | "recipient" | "both";

  const statusParam = req.nextUrl.searchParams.get("status");
  const validStatuses: TaskStatus[] = ["queued", "running", "completed", "failed"];
  if (statusParam && !validStatuses.includes(statusParam as TaskStatus)) {
    return apiError("VALIDATION_ERROR", "status must be queued, running, completed, or failed", 400);
  }
  const status = statusParam as TaskStatus | null;

  const limitParam = parseInt(req.nextUrl.searchParams.get("limit") ?? "50");
  const limit = isNaN(limitParam) ? 50 : Math.min(Math.max(limitParam, 1), 200);

  const tasks = getTasksByAgent({
    agentId,
    role,
    status: status ?? undefined,
    limit,
  });

  return NextResponse.json({ tasks, total: tasks.length });
}
