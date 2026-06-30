import { NextRequest, NextResponse } from "next/server";
import { getProtocolInfo, negotiateVersion } from "@/lib/protocol";
import { apiError } from "@/lib/apiError";
import { negotiateProtocolSchema, parseBody } from "@/lib/schemas";

// GET /api/protocol — the versions and capabilities this server speaks (public).
export async function GET() {
  return NextResponse.json(getProtocolInfo());
}

// POST /api/protocol — negotiate: the client offers the versions it speaks, the
// server returns the highest both share (or 409 if there's no overlap).
export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  const parsed = parseBody(raw, negotiateProtocolSchema);
  if (!parsed.ok) return parsed.response;

  const result = negotiateVersion(parsed.data.clientVersions);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason, code: "PROTOCOL_INCOMPATIBLE", supported: result.supported },
      { status: 409 }
    );
  }
  return NextResponse.json({ version: result.version, capabilities: result.capabilities });
}
