import type { NextRequest } from "next/server";

// The public https origin of the deployment serving this request — used for every
// URL a Solana Action / Blink client will fetch (icon, chained hrefs). Lives in a lib
// (not a route file, which may only export handlers): NEXT_PUBLIC_SITE_URL overrides;
// otherwise the forwarded host, always https, so private and prod each point at
// themselves rather than one hardcoded environment.
export function publicOrigin(req: NextRequest): string {
  const override = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (override) return override.replace(/\/$/, "");
  const host = req.headers.get("x-forwarded-host") ?? req.nextUrl.host;
  return `https://${host}`;
}
