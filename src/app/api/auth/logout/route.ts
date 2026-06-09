import { NextRequest, NextResponse } from "next/server";
import { revokeApiKey } from "@/lib/identity";
import { apiError } from "@/lib/apiError";

export async function DELETE(req: NextRequest) {
  const revoked = revokeApiKey(req);
  if (!revoked) {
    return apiError("AUTH_REQUIRED", "Missing or invalid API key", 401);
  }

  return NextResponse.json({ revoked: true });
}
