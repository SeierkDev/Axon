// The address this server is actually reachable at, as opposed to the one it is listening on.
//
// Behind a proxy, `req.nextUrl.origin` is the socket the container bound: on Railway that is
// https://0.0.0.0:8080, which is not a place anybody can reach. It went out in the x402 payment
// requirements as the `resource` a caller is paying for, so the quote named an address that does
// not resolve, and the signed detail describing what was bought was wrong.
//
// The proxy says where the request really came in, in x-forwarded-*. Those headers are set by the
// proxy in front of us and are the only thing that knows the public name.

import type { NextRequest } from "next/server";

/** A host that is a local socket rather than somewhere a caller could reach. */
const isLoopback = (host: string): boolean =>
  /^(0\.0\.0\.0|127\.0\.0\.1|\[::1?\]|::1?|localhost)(:\d+)?$/i.test(host.trim());

/**
 * The public origin for this request: scheme and host, no trailing slash.
 *
 * Prefers an explicitly configured URL, then what the proxy reports, and only then the socket the
 * process bound. Takes the first entry when a header has been chained through several hops.
 */
export function publicOrigin(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || process.env.AXON_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const first = (value: string | null): string => (value ?? "").split(",")[0]!.trim();
  const host = first(req.headers.get("x-forwarded-host")) || first(req.headers.get("host"));
  if (host && !isLoopback(host)) {
    const proto = first(req.headers.get("x-forwarded-proto")) || "https";
    return `${proto}://${host}`;
  }

  return req.nextUrl.origin;
}

/** A full URL for a path on this server, for handing to a caller. */
export const publicUrl = (req: NextRequest, path: string): string =>
  `${publicOrigin(req)}${path.startsWith("/") ? path : `/${path}`}`;
