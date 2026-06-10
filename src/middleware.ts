import { NextRequest, NextResponse } from "next/server";

// Origins allowed to make credentialed cross-origin API calls.
// In development, localhost variants are always permitted.
// In production, only the listed domains can call payment and auth routes.
const PRODUCTION_ORIGINS = new Set(
  (process.env.CORS_ORIGIN ?? "https://axon-agents.com")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
);

const DEV_ORIGIN_PATTERN = /^https?:\/\/localhost(:\d+)?$/;

function getAllowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (PRODUCTION_ORIGINS.has(origin)) return origin;
  if (process.env.NODE_ENV !== "production" && DEV_ORIGIN_PATTERN.test(origin)) return origin;
  return null;
}

const CORS_STATIC_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Payment, X-API-Key, X-Request-ID",
  "Access-Control-Expose-Headers":
    "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Idempotent-Replay, X-Payment-Replay, X-Axon-Task-Id, X-Axon-Duration-Ms, X-Request-ID",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

export function middleware(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const origin = req.headers.get("origin");
  const allowedOrigin = getAllowedOrigin(origin);

  // Handle OPTIONS preflight
  if (req.method === "OPTIONS") {
    const headers: Record<string, string> = { ...CORS_STATIC_HEADERS, "X-Request-ID": requestId };
    if (allowedOrigin) headers["Access-Control-Allow-Origin"] = allowedOrigin;
    return new NextResponse(null, { status: 204, headers });
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", requestId);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(CORS_STATIC_HEADERS)) {
    res.headers.set(key, value);
  }
  if (allowedOrigin) res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
  res.headers.set("X-Request-ID", requestId);
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
