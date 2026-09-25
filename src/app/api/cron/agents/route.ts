import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAllAgents, createAgent } from "@/lib/agents";
import { logger } from "@/lib/logger";
import type { Agent } from "@/sdk/types";
import { noteCronRun } from "@/lib/cronRuns";

export const runtime = "nodejs";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

const ADJECTIVES = [
  "Lumen", "Quill", "Nova", "Synth", "Apex", "Vertex", "Cobalt", "Ember", "Flux", "Halo",
  "Iris", "Onyx", "Pulse", "Sage", "Tide", "Vela", "Zenith", "Atlas", "Cipher", "Drift",
  "Helix", "Juno", "Kepler", "Lyra", "Meridian", "Orbit", "Polaris", "Quartz", "Relay", "Solstice",
  "Tessel", "Umbra", "Verge", "Wren", "Axiom", "Beacon", "Cascade", "Delphi", "Echo", "Fathom",
  "Glyph", "Harbor", "Ion", "Joule", "Krypton", "Lattice", "Mosaic", "Nimbus", "Oort", "Prism",
];

const DOMAINS: { word: string; category: string; caps: string[] }[] = [
  { word: "Research", category: "Research", caps: ["research", "analysis", "summarization", "search"] },
  { word: "Translation", category: "Content", caps: ["translation", "writing", "localization"] },
  { word: "Image", category: "Content", caps: ["image-generation", "vision", "design"] },
  { word: "Vision", category: "Research", caps: ["vision", "image-analysis", "ocr"] },
  { word: "Trading", category: "Finance", caps: ["trading", "analysis", "crypto"] },
  { word: "Content", category: "Content", caps: ["writing", "content", "copywriting"] },
  { word: "Data", category: "Research", caps: ["data-analysis", "analysis", "reporting"] },
  { word: "Code", category: "Development", caps: ["coding", "development", "debugging"] },
  { word: "Security", category: "Development", caps: ["security", "audit", "code-review"] },
  { word: "Analytics", category: "Research", caps: ["analytics", "data-analysis", "forecasting"] },
  { word: "Audio", category: "Content", caps: ["audio", "transcription", "speech"] },
  { word: "Market", category: "Finance", caps: ["market-analysis", "trading", "research"] },
  { word: "DeFi", category: "Finance", caps: ["defi", "blockchain", "analysis"] },
  { word: "Support", category: "Content", caps: ["support", "writing", "chat"] },
  { word: "SEO", category: "Content", caps: ["seo", "writing", "marketing"] },
  { word: "Legal", category: "Research", caps: ["legal", "analysis", "research"] },
  { word: "Scheduling", category: "Content", caps: ["scheduling", "planning", "coordination"] },
  { word: "Strategy", category: "Research", caps: ["strategy", "analysis", "planning"] },
  { word: "Social", category: "Content", caps: ["social", "writing", "marketing"] },
  { word: "Summarization", category: "Research", caps: ["summarization", "analysis", "writing"] },
];

const MODELS = ["claude-haiku-4-5-20251001"];
// The band the listed agents are actually priced in. These were carried across at their old
// denomination, which put every generated agent three orders of magnitude above the ones it
// was sitting next to in the marketplace.
const PRICES = ["0.0001 ETH", "0.00015 ETH", "0.0002 ETH", "0.00025 ETH", "0.0003 ETH", "0.0005 ETH"];

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}
function sample<T>(a: T[], n: number): T[] {
  return [...a].sort(() => Math.random() - 0.5).slice(0, n);
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// People do not all name things the same way. Some pick a product name, some register a handle,
// some just say what the thing does, and a naming pool that only knows one of those is a pool
// that can only produce one kind of listing.
const SUFFIXES = ["Labs", "Works", "Studio", "Systems", "Collective", "AI"];

/** Whether a shape produced a handle, so a disambiguator joins it the way a handle would. */
type Candidate = { name: string; handle: boolean };

function nameShapes(adjective: string, word: string): Candidate[] {
  const a = adjective.toLowerCase();
  const w = word.toLowerCase();
  return [
    { name: `${adjective} ${word} Agent`, handle: false },
    { name: `${adjective} ${word}`, handle: false },
    { name: `${adjective} ${pick(SUFFIXES)}`, handle: false },
    { name: `${adjective}${word}`, handle: false },
    { name: `${a}-${w}`, handle: true },
    { name: `${a}${w}`, handle: true },
  ];
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  noteCronRun("agents");

  const all = getAllAgents();
  const existingNames = new Set(all.map((a) => a.name.toLowerCase()));
  const existingIds = new Set(all.map((a) => a.agentId));
  const wallet =
    process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ??
    process.env.NEXT_PUBLIC_WALLET_ADDRESS ??
    undefined;

  const count = 1 + Math.floor(Math.random() * 3);
  const created: string[] = [];

  for (let i = 0; i < count; i++) {
    const domain = pick(DOMAINS);
    let name = "";
    let id = "";
    for (let tries = 0; tries < 40; tries++) {
      const shape = pick(nameShapes(pick(ADJECTIVES), domain.word));
      let candidate = shape.name;
      // Only once the pool is genuinely exhausted, and joined the way the shape would join it:
      // a number after a space reads as a name, after a hyphen it reads as a handle.
      if (tries >= 20) candidate += `${shape.handle ? "-" : " "}${2 + Math.floor(Math.random() * 998)}`;
      if (existingNames.has(candidate.toLowerCase())) continue;
      const candidateId = `${slug(candidate)}-${randomUUID().slice(0, 4)}`;
      if (existingIds.has(candidateId)) continue;
      name = candidate;
      id = candidateId;
      break;
    }
    if (!id) continue;

    // Half list a price, half work the free lane. Which one an agent lands in is its own
    // coin flip, so the directory carries a mix rather than a wall of identical listings.
    const priced = Math.random() < 0.5;

    const agent: Agent = {
      agentId: id,
      name,
      capabilities: sample(domain.caps, 2 + Math.floor(Math.random() * 2)),
      publicKey: randomBytes(32).toString("hex"),
      reputation: 0,
      category: domain.category,
      // A wallet is the address work gets paid to. An agent that charges nothing has nothing
      // to be paid, so it lists none.
      ...(priced ? { price: pick(PRICES), walletAddress: wallet } : {}),
      provider: "anthropic",
      providerModel: pick(MODELS),
      verificationStatus: "unverified",
      createdAt: new Date().toISOString(),
    };

    try {
      createAgent(agent);
      existingNames.add(name.toLowerCase());
      existingIds.add(id);
      created.push(id);
    } catch (err) {
      logger.warn("cron.agents_create_failed", "Failed to create agent", { id, err });
    }
  }

  logger.info("cron.agents_complete", "Created agents", { created: created.length, agentIds: created });
  return NextResponse.json({ ok: true, created: created.length, agentIds: created });
}
