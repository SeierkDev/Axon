import { NextRequest, NextResponse } from "next/server";
import { requireAgentOwner } from "@/lib/apiAuth";
import { getThresholdStatus, setThreshold, deleteThreshold } from "@/lib/spendThreshold";
import { apiError } from "@/lib/apiError";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const status = getThresholdStatus(agentId);
  return NextResponse.json({
    threshold: status?.threshold ?? null,
    windowSpendUsdc: status?.windowSpendUsdc ?? 0,
    lastAlert: status?.lastAlert ?? null,
  });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null) as {
    thresholdUsdc?: number;
    windowHours?: number;
    enabled?: boolean;
  } | null;
  if (!body) return apiError("VALIDATION_ERROR", "Request body required", 400);

  const { thresholdUsdc, windowHours = 24, enabled = true } = body;

  if (thresholdUsdc == null || typeof thresholdUsdc !== "number" || thresholdUsdc <= 0) {
    return apiError("VALIDATION_ERROR", "thresholdUsdc must be a positive number", 400);
  }
  if (typeof windowHours !== "number" || windowHours < 1 || windowHours > 720) {
    return apiError("VALIDATION_ERROR", "windowHours must be between 1 and 720", 400);
  }

  const threshold = setThreshold(agentId, thresholdUsdc, windowHours, Boolean(enabled));
  return NextResponse.json({ threshold });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;

  deleteThreshold(agentId);
  return NextResponse.json({ ok: true });
}
