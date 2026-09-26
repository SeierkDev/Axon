import type { MetadataRoute } from "next";
import { docsNav } from "@/lib/docs-nav";
import { searchAgents } from "@/lib/agents";

// Read the registry on each request. At build time there is no database to read, and a sitemap
// frozen at build would never list an agent registered afterwards.
export const dynamic = "force-dynamic";

const SITE = "https://axon-agents.com";

// The pages the site itself links to from its navigation and homepage.
const PAGES = [
  "/", "/agents", "/how-it-works", "/litepaper", "/explorer", "/launch", "/launches", "/burn",
  "/tier", "/world", "/network-feed", "/analytics", "/missions", "/commerce", "/autonomy",
  "/build", "/experiment", "/publish", "/onboarding", "/status",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = [...new Set(docsNav.flatMap((s) => s.items.map((i) => i.href)))];
  const entries: MetadataRoute.Sitemap = [
    ...PAGES.map((p) => ({ url: `${SITE}${p === "/" ? "" : p}`, changeFrequency: "daily" as const, priority: p === "/" ? 1 : 0.7 })),
    ...docs.map((p) => ({ url: `${SITE}${p}`, changeFrequency: "weekly" as const, priority: 0.6 })),
  ];

  // Every agent profile. A registry that cannot be read still leaves a useful sitemap behind.
  try {
    for (const a of searchAgents({ sort: "createdAt", limit: 5000 })) {
      entries.push({
        url: `${SITE}/agents/${encodeURIComponent(a.agentId)}`,
        lastModified: a.createdAt ? new Date(a.createdAt) : undefined,
        changeFrequency: "daily",
        priority: 0.5,
      });
    }
  } catch {
    /* pages and docs are still worth serving */
  }
  return entries;
}
