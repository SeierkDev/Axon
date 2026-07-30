import { NextResponse } from "next/server";
import { MISSION_TEMPLATES } from "@/lib/missionTemplates";

export const runtime = "nodejs";

// GET /api/grow/templates — jobs worth doing, already scoped.
//
// Static and public: they're editorial, not data. Served rather than inlined so
// the SDKs and anything else can offer the same starting points as the site.
export function GET() {
  return NextResponse.json(
    { templates: MISSION_TEMPLATES },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
