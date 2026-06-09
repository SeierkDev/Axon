// GET /api/receipts/:taskId
//
// Returns the full receipt chain for a task:
//   task → payment → webhook deliveries
// Useful for auditing exactly what happened after a paid task was submitted.

import { NextRequest, NextResponse } from "next/server";
import { getReceipt } from "@/lib/receipts";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";

type Params = { params: Promise<{ taskId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;

    const { taskId } = await params;
    const receipt = getReceipt(taskId);

    if (!receipt.task) {
      return apiError("NOT_FOUND", "Task not found", 404);
    }
    if (
      !canAccessIdentity(auth.user, receipt.task.fromAgent) &&
      !canAccessIdentity(auth.user, receipt.task.toAgent)
    ) {
      return apiError("FORBIDDEN", "API key does not have access to this receipt", 403);
    }

    return NextResponse.json({ receipt });
  });
}
