// Serves a stored game as a file download. Content-Disposition: attachment
// forces a real download that works on mobile, unlike client-side data: URLs
// which the page CSP and mobile browsers block.

import { NextRequest } from "next/server";
import { getBuildGame } from "@/lib/buildStore";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ buildId: string }> },
) {
  const { buildId } = await params;
  const game = getBuildGame(buildId);
  if (!game) {
    return new Response("Game not found", { status: 404 });
  }

  return new Response(game.html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="axon-game-${buildId.slice(0, 8)}.html"`,
      "Cache-Control": "no-store",
    },
  });
}
