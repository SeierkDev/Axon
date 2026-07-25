import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { getAgentById } from "@/lib/agents";
import { selectAgent } from "@/lib/routing";
import { createHiredTask } from "@/lib/planner";
import { recordSubcontract, getSubcontractsForParent } from "@/lib/subcontracts";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { subcontractSchema, parseBody } from "@/lib/schemas";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";

// GET /api/tasks/[taskId]/subcontract — the sub-agents this task hired (provenance).
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const parent = getTaskById(taskId);
  if (!parent) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  // The payer or the working agent may inspect the chain.
  if (!canAccessIdentity(auth.user, parent.fromAgent) && !canAccessIdentity(auth.user, parent.toAgent)) {
    return apiError("FORBIDDEN", "Only the task's payer or worker can view its subcontracts", 403);
  }
  return NextResponse.json({ taskId, subcontracts: getSubcontractsForParent(taskId) });
}

// POST /api/tasks/[taskId]/subcontract — the agent working this task hires a
// sub-agent for part of it. The sub is chosen explicitly (`to`) or routed by
// `capability`, and paid from the working agent's balance within its budget. The
// child hire is linked back to the parent for provenance.
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, () => handlePost(req, params));
}

async function handlePost(req: NextRequest, params: Promise<{ taskId: string }>) {
  const { taskId } = await params;
  const ip = getClientIp(req);
  const rl = checkRateLimit(`subcontract:${ip}`, 30, 60_000);
  if (!rl.allowed) return tooManyRequests(rl);

  const parent = getTaskById(taskId);
  if (!parent) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);

  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  // Only the agent assigned the parent task can subcontract it.
  if (!canAccessIdentity(auth.user, parent.toAgent)) {
    return apiError("FORBIDDEN", "Only the agent assigned this task can subcontract part of it", 403);
  }
  if (parent.status === "completed" || parent.status === "failed") {
    return apiError("TASK_STATE_CONFLICT", `Task is already ${parent.status} — nothing left to subcontract`, 409);
  }

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, subcontractSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // Resolve the sub-agent: explicit `to`, or route by capability. Never the
  // working agent itself, and never the parent's payer (no billing loops).
  // Note: this guards the immediate hop; a transitive cycle (A→B→C→A) across
  // separate, individually budget-funded subcontracts is still possible — full
  // ancestor-chain exclusion (anti-wash-trading) is a follow-up.
  let subId = body.to;
  if (!subId) {
    const r = selectAgent({
      capability: body.capability,
      fromAgent: parent.toAgent,
      exclude: [parent.fromAgent, parent.toAgent],
      maxPrice: body.maxPrice,
    });
    if (!r) {
      const want = body.capability ?? "the subcontract";
      return apiError("NO_AGENT_AVAILABLE", `No available agent matches ${want}`, 404);
    }
    subId = r.agent.agentId;
  } else {
    if (subId === parent.toAgent) return apiError("VALIDATION_ERROR", "an agent cannot subcontract to itself", 400);
    if (subId === parent.fromAgent) return apiError("VALIDATION_ERROR", "cannot subcontract back to the task's payer", 400);
    if (!getAgentById(subId)) return apiError("NOT_FOUND", `Agent '${subId}' not found`, 404);
  }

  // Hire the sub-agent from the working agent, paid from its balance (bounded by
  // its budget — createHiredTask → createBalancePayment → checkBudget).
  let hire;
  try {
    // Provenance (subcontractOf) is recorded in task_subcontracts, not injected into
    // the sub-agent's prompt — only the caller's own context is passed through.
    hire = createHiredTask(parent.toAgent, subId, body.task, body.context);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Subcontract hire failed";
    // Budget rejections and insufficient balance are payment failures (402).
    const status = /budget|balance|insufficient/i.test(msg) ? 402 : 400;
    return apiError(status === 402 ? "PAYMENT_FAILED" : "VALIDATION_ERROR", msg, status);
  }

  const subcontract = recordSubcontract({
    parentTaskId: taskId,
    childTaskId: hire.taskId,
    fromAgent: parent.toAgent,
    toAgent: subId,
    price: hire.price,
  });

  return NextResponse.json({ subcontract, task: getTaskById(hire.taskId) }, { status: 201 });
}
