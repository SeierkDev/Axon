import { NextRequest, NextResponse } from "next/server";

// Allowed origins for cross-origin API access.
// Set CORS_ORIGIN in .env to restrict to specific domains in production.
// "*" is fine for a public developer API.
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN ?? "*";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Payment, X-API-Key, X-Request-ID",
  "Access-Control-Expose-Headers":
    "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Idempotent-Replay, X-Payment-Replay, X-Axon-Task-Id, X-Axon-Duration-Ms, X-Request-ID",
  "Access-Control-Max-Age": "86400",
};

export function middleware(req: NextRequest) {
  // Echo the client's X-Request-ID or generate a new one for every API request.
  // The ID is forwarded to the route handler via request headers and echoed back
  // on the response so callers can correlate log lines to a specific request.
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

  // Handle OPTIONS preflight
  if (req.method === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: { ...CORS_HEADERS, "X-Request-ID": requestId },
    });
  }

  // Forward the request ID downstream so route handlers can read it from req.headers
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", requestId);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.headers.set(key, value);
  }
  res.headers.set("X-Request-ID", requestId);
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
