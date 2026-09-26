import type { MetadataRoute } from "next";
import { headers } from "next/headers";

// Crawlers were a large share of all traffic and every one of them asked for /robots.txt and got a
// 404. Answer them, and point them at the sitemap.
//
// Only the canonical host is open to crawling. The same build serves other hosts (the private
// deployment, local runs) and none of those should end up in a search index.
const CANONICAL_HOST = "axon-agents.com";

// Private or per-user surfaces: nothing a search result should land on.
const PRIVATE = ["/admin/", "/api/admin/", "/api/cron/", "/dashboard"];

export default async function robots(): Promise<MetadataRoute.Robots> {
  const h = await headers();
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(":")[0].toLowerCase();
  if (host !== CANONICAL_HOST && host !== `www.${CANONICAL_HOST}`) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      // A backlink crawler walking the JSON API one agent at a time was the single largest client.
      // The pages it wants are the HTML ones; the API is for agents, not for link indexes.
      { userAgent: "SERankingBacklinksBot", allow: "/", disallow: [...PRIVATE, "/api/"] },
    ],
    sitemap: `https://${CANONICAL_HOST}/sitemap.xml`,
  };
}
