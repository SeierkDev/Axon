import { NextResponse } from "next/server";

// Solana Actions discovery: maps the shareable web URL /hire/<agentId> to its
// Action API /api/actions/hire/<agentId>, so a Blink-aware wallet or client can
// unfurl any hire link into a native pay-and-hire button.

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function GET() {
  return NextResponse.json(
    {
      rules: [
        { pathPattern: "/hire/*", apiPath: "/api/actions/hire/*" },
        { pathPattern: "/hire/**", apiPath: "/api/actions/hire/**" },
      ],
    },
    { headers: CORS },
  );
}
