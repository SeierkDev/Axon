// GET /api/receipts/:taskId
//
// Returns the full receipt chain for a task:
//   task → payment → webhook deliveries
// Useful for auditing exactly what happened after a paid task was submitted.

import { NextRequest, NextResponse } from "next/server";
import { getReceipt } from "@/lib/receipts";
import { addPaymentNote, type PaymentNoteKind } from "@/lib/paymentNotes";
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

// POST /api/receipts/:taskId — attach a dispute (or general) note to this payment.
// Refund notes are system-generated, so only parties to the task may file
// "dispute" or "note" entries, which then surface on the receipt.
export async function POST(req: NextRequest, { params }: Params) {
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

    const body = (await req.json().catch(() => null)) as { kind?: string; note?: string } | null;
    const note = body?.note;
    if (!note || typeof note !== "string" || !note.trim()) {
      return apiError("VALIDATION_ERROR", "note text is required", 400);
    }
    const allowed: PaymentNoteKind[] = ["dispute", "note"];
    if (!body?.kind || !allowed.includes(body.kind as PaymentNoteKind)) {
      return apiError("VALIDATION_ERROR", `kind must be one of: ${allowed.join(", ")}`, 400);
    }

    const created = addPaymentNote(taskId, body.kind as PaymentNoteKind, note, auth.user.walletAddress);
    return NextResponse.json({ note: created }, { status: 201 });
  });
}
