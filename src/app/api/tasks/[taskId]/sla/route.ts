import { NextRequest, NextResponse } from "next/server";
import { defineSla, getSlaForTask, type SlaErrorCode } from "@/lib/sla";
import { getTaskById } from "@/lib/tasks";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { apiError, type ApiErrorCode } from "@/lib/apiError";
import { defineSlaSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

const SLA_ERROR: Record<SlaErrorCode, { code: ApiErrorCode; status: number }> = {
  INVALID: { code: "VALIDATION_ERROR", status: 400 },
  NOT_FOUND: { code: "NOT_FOUND", status: 404 },
};

// GET /api/tasks/[taskId]/sla — the task's SLA and its current status (public).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const sla = getSlaForTask(taskId);
  if (!sla) return apiError("NOT_FOUND", `No SLA defined for task '${taskId}'`, 404);
  return NextResponse.json(sla);
}

// POST /api/tasks/[taskId]/sla — define (or replace) the SLA. Only the task's
// payer (its from_agent) sets the terms, same as escrow splits.
export async function POST(req: NextRequest, ctx: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, () => handlePost(req, ctx));
}

async function handlePost(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;

  const { taskId } = await params;
  const task = getTaskById(taskId);
  if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
  if (!canAccessIdentity(auth.user, task.fromAgent)) {
    return apiError("FORBIDDEN", "Only the task's payer can set its SLA", 403);
  }

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, defineSlaSchema);
  if (!parsed.ok) return parsed.response;

  const result = defineSla(taskId, parsed.data.deadlineSeconds, parsed.data.penaltyBps);
  if (!result.success) {
    const mapped = SLA_ERROR[result.code];
    return apiError(mapped.code, result.error, mapped.status);
  }
  return NextResponse.json(result.sla, { status: 201 });
}
