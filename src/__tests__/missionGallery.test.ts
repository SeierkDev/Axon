// The mission gallery: templates to start from, and results worth showing.
//
// The load-bearing test here is what publication exposes. A mission receipt is
// content-free by design; a published mission is the opposite — it shows the
// brief and the result on purpose. Everything ELSE about a run has to stay
// private, and that boundary is what these check.

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import {
  createGrowRun, recordGrowEvent, updateGrowRun, getGrowEvents, getGrowRun,
  setGrowRunPublished, getPublishedGrowRun, listPublishedGrowRuns,
} from "@/lib/grow";
import { toPublicMission, toPublicMissionCard } from "@/lib/missionPublic";
import { buildMissionManifest } from "@/lib/growReceipt";
import { runGrowMission, type GrowDeps } from "@/lib/growRunner";
import { MISSION_TEMPLATES, getMissionTemplate, fillMissionTemplate } from "@/lib/missionTemplates";
import { clip } from "@/app/m/[runId]/cardText";
import { cut, cutWithEllipsis } from "@/lib/text";

const OWNER = "OWNER_WALLET_AAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "OTHER_WALLET_BBBBBBBBBBBBBBBBBBBBBBBBBBB";

/** A finished mission with a sealed receipt, ready to publish. */
function finished(opts: { templateId?: string; owner?: string } = {}) {
  const run = createGrowRun({
    agentId: `a-${randomUUID().slice(0, 8)}`,
    ownerWallet: opts.owner ?? OWNER,
    mission: "PRIVATE BRIEF",
    budgetUsdc: 5,
    templateId: opts.templateId,
  });
  recordGrowEvent(run.runId, { kind: "payment", summary: "paid", taskId: "tk1", amountUsdc: 1 });
  recordGrowEvent(run.runId, {
    kind: "result", summary: "did the research", taskId: "tk1", toAgent: "atlas",
    data: { capability: "research", preview: "PREVIEW TEXT FROM THE SPECIALIST" },
  });
  recordGrowEvent(run.runId, { kind: "self", summary: "did it itself", data: { ok: true, capability: "writing", preview: "IN-HOUSE PREVIEW" } });
  updateGrowRun(run.runId, { status: "completed", deliverable: "THE RESULT" });

  const fresh = getGrowRun(run.runId)!;
  updateGrowRun(run.runId, {
    manifest: buildMissionManifest(fresh, getGrowEvents(run.runId), {
      deliverable: "THE RESULT", outputs: new Map([["tk1", "the full output"]]),
    }),
  });
  return getGrowRun(run.runId)!;
}

/**
 * A mission driven all the way through the real runner.
 *
 * The hand-built fixture below seeds its own events, which is useful for the
 * publication boundary but useless for checking what a run actually records —
 * seeding `capability` by hand is what hid it being missing in the first place.
 */
async function realRun() {
  const deps: GrowDeps = {
    self: "e",
    think: async (p: string) =>
      p.includes("Break the mission into")
        ? '[{"capability":"research","task":"find it"},{"capability":"rare","task":"nobody does this"}]'
        : p.includes("Judge whether") ? '{"ok":true}'
        : p.includes("deciding what is still worth doing") ? "[]" : "FINAL",
    search: async ({ capability }) =>
      capability === "research"
        ? [{ agentId: "atlas", name: "Atlas Research", priceUsdc: 1, proofScore: 900, capabilities: [] }]
        : [],
    hire: async () => ({ taskId: "tk1", status: "completed" as const, output: "the work", costUsdc: 1 }),
    attempt: async () => "in-house work",
    fetchOutput: async () => "the work",
  };
  const res = await runGrowMission(deps, { mission: "m", budgetUsdc: 5, perHireCapUsdc: 2, maxHires: 2 });
  return getGrowRun(res.run.runId)!;
}

describe("a step is labelled with its capability, not a sentence about it", () => {
  it("records the capability keyword through to the receipt and the page", async () => {
    const run = await realRun();
    const manifest = run.manifest as import("@/lib/growReceipt").MissionManifest;
    // The manifest's fallback is the event summary — a whole sentence where a
    // keyword belongs, and on the receipt that sentence is inside the hash.
    expect(manifest.entries.map((e) => e.capability)).toEqual(["research", "rare"]);

    const pub = toPublicMission(run, getGrowEvents(run.runId));
    expect(pub.steps.map((s) => s.capability)).toEqual(["research", "rare"]);
    for (const s of pub.steps) expect(s.capability).not.toContain(" ");
  });
});

describe("templates", () => {
  it("only asks for capabilities the marketplace actually serves", () => {
    // Measured before these were written: research / analysis / writing / coding
    // have real supply; summarization has one agent and fact-checking has none.
    // A template planning around a capability nobody offers just skips its own steps.
    const served = new Set(["research", "analysis", "writing", "coding"]);
    for (const t of MISSION_TEMPLATES) {
      expect(t.needs.length).toBeGreaterThan(0);
      for (const n of t.needs) expect(served.has(n)).toBe(true);
    }
  });

  it("keeps every budget within what specialists actually charge", () => {
    for (const t of MISSION_TEMPLATES) {
      expect(t.perHireCapUsdc).toBeGreaterThan(0);
      // Most listed specialists are at or under 1 USDC — a cap below that would
      // offer a template that can never hire anyone.
      expect(t.perHireCapUsdc).toBeGreaterThanOrEqual(1);
      expect(t.budgetUsdc).toBeGreaterThanOrEqual(t.perHireCapUsdc);
      expect(t.maxHires).toBeGreaterThan(0);
    }
  });

  it("fills the subject in, and refuses a template with an empty one", () => {
    const t = getMissionTemplate("compare")!;
    const filled = fillMissionTemplate(t, "  open-source agent frameworks  ");
    expect(filled).toContain("open-source agent frameworks");
    expect(filled).not.toContain("{{input}}");
    // An unfilled template would send the agent off to research the literal
    // string "{{input}}".
    expect(fillMissionTemplate(t, "   ")).toBeNull();
  });

  it("has unique ids and ignores one it doesn't know", () => {
    const ids = MISSION_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getMissionTemplate("no-such-template")).toBeNull();
    expect(getMissionTemplate(undefined)).toBeNull();
  });
});

describe("publishing is the owner's act, and reverses", () => {
  it("puts a finished mission up and takes it back down", () => {
    const run = finished();
    expect(getPublishedGrowRun(run.runId)).toBeNull();       // off by default

    const up = setGrowRunPublished(run.runId, OWNER, true)!;
    expect(up.published).toBe(true);
    expect(up.publishedAt).toBeTruthy();
    expect(getPublishedGrowRun(run.runId)).not.toBeNull();

    setGrowRunPublished(run.runId, OWNER, false);
    expect(getPublishedGrowRun(run.runId)).toBeNull();
  });

  it("won't let somebody else publish your mission", () => {
    const run = finished();
    expect(setGrowRunPublished(run.runId, OTHER, true)).toBeNull();
    expect(getPublishedGrowRun(run.runId)).toBeNull();
  });

  it("won't publish a mission that is still running", () => {
    const run = createGrowRun({ agentId: "a", ownerWallet: OWNER, mission: "m", budgetUsdc: 5 });
    // The page would show a half-built result that then changes under its readers.
    expect(setGrowRunPublished(run.runId, OWNER, true)).toBeNull();
  });

  it("lists newest first, and only what is published", () => {
    // Two from one owner, which is exactly the per-owner cap — a third here
    // would be dropped by design, not by a bug.
    const a = finished(), b = finished();
    setGrowRunPublished(a.runId, OWNER, true);
    setGrowRunPublished(b.runId, OWNER, true);
    const ids = listPublishedGrowRuns(50).map((r) => r.runId);
    expect(ids).toContain(a.runId);
    expect(ids).toContain(b.runId);

    setGrowRunPublished(a.runId, OWNER, false);
    expect(listPublishedGrowRuns(50).map((r) => r.runId)).not.toContain(a.runId);
  });

  it("won't let one owner take over the gallery", () => {
    // Measured before the cap: seven publishes from one owner filled every slot
    // of a six-card strip and pushed everyone else out. That's the likely case,
    // not the adversarial one — whoever tries Missions first will have several
    // runs before anybody else has one, and the strip promises other people's.
    const hog = "HOG_WALLET_CCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const hogRuns = Array.from({ length: 7 }, () => finished({ owner: hog }));
    for (const r of hogRuns) setGrowRunPublished(r.runId, hog, true);
    const guest = finished({ owner: OTHER });
    setGrowRunPublished(guest.runId, OTHER, true);

    const strip = listPublishedGrowRuns(6);
    const fromHog = strip.filter((r) => r.ownerWallet === hog);
    expect(fromHog).toHaveLength(2);
    // The newest two, not an arbitrary two. Publishing seven in a burst gives
    // them roughly two distinct `published_at` values between them — millisecond
    // resolution — so this only holds because ties fall back to insertion order.
    expect(fromHog.map((r) => r.runId)).toEqual(hogRuns.slice(-2).reverse().map((r) => r.runId));
    // And someone who published once still gets in.
    expect(strip.map((r) => r.runId)).toContain(guest.runId);
  });
});

describe("what a published mission shows — and what it must not", () => {
  it("shows the brief, the result, and every step with its receipt", () => {
    const run = finished({ templateId: "compare" });
    const pub = toPublicMission(run, getGrowEvents(run.runId));

    expect(pub.mission).toBe("PRIVATE BRIEF");        // published deliberately
    expect(pub.deliverable).toBe("THE RESULT");       // published deliberately
    expect(pub.steps).toHaveLength(2);
    expect(pub.steps[0]).toMatchObject({ source: "hire", agentId: "atlas", receiptUrl: "/r/tk1", costUsdc: 1 });
    expect(pub.steps[1]).toMatchObject({ source: "in-house", costUsdc: 0 });
    expect(pub.steps[1].receiptUrl).toBeUndefined();  // nobody witnessed it
    expect(pub.template).toEqual({ id: "compare", title: "Compare the options" });
    expect(pub.receipt?.verification.ok).toBe(true);
  });

  it("never exposes the owner, the plan, or the raw timeline blobs", () => {
    const run = finished();
    updateGrowRun(run.runId, { plan: [{ capability: "research", task: "SECRET PLAN STEP" }] });
    const raw = JSON.stringify(toPublicMission(getGrowRun(run.runId)!, getGrowEvents(run.runId)));

    expect(raw).not.toContain(OWNER);
    expect(raw).not.toContain("ownerWallet");
    expect(raw).not.toContain("SECRET PLAN STEP");
    // Event `data` carries previews and internals publication never asked for.
    expect(raw).not.toContain("PREVIEW TEXT FROM THE SPECIALIST");
    expect(raw).not.toContain("IN-HOUSE PREVIEW");
  });

  it("describes the mission from its receipt, so page and proof can't drift", () => {
    const run = finished();
    const pub = toPublicMission(run, getGrowEvents(run.runId));
    const manifest = run.manifest as import("@/lib/growReceipt").MissionManifest;
    expect(pub.totals).toEqual(manifest.totals);
    expect(pub.steps.map((s) => s.seq)).toEqual(manifest.entries.map((e) => e.seq));
    expect(pub.receipt?.hash).toBe(manifest.hash);
  });

  it("still works for a run sealed before manifests existed", () => {
    const run = finished();
    updateGrowRun(run.runId, { status: "completed" });
    // Force the fallback path: same shape, rebuilt from the timeline.
    const pub = toPublicMission({ ...run, manifest: undefined }, getGrowEvents(run.runId));
    expect(pub.steps).toHaveLength(2);
    expect(pub.totals).toMatchObject({ hires: 1, inHouse: 1, spentUsdc: 1 });
    expect(pub.receipt).toBeNull();
    expect(JSON.stringify(pub)).not.toContain("PREVIEW TEXT FROM THE SPECIALIST");
  });

  it("reports the same numbers on the card as on the page, receipt or no receipt", () => {
    // Sealing the receipt is best-effort, so a finished mission can have none.
    // The card and the page used to work their totals out separately, and a run
    // in that state showed "1 hire" on its page and "0 hires" on its own card.
    const run = createGrowRun({ agentId: "a", ownerWallet: OWNER, mission: "m", budgetUsdc: 5 });
    recordGrowEvent(run.runId, { kind: "payment", summary: "paid", taskId: "tk1", amountUsdc: 2 });
    recordGrowEvent(run.runId, { kind: "result", summary: "done", taskId: "tk1", toAgent: "atlas", data: { capability: "research" } });
    updateGrowRun(run.runId, { status: "completed", deliverable: "RESULT" });
    const unsealed = getGrowRun(run.runId)!;
    expect(unsealed.manifest).toBeUndefined();

    const events = getGrowEvents(run.runId);
    const page = toPublicMission(unsealed, events);
    const card = toPublicMissionCard(unsealed, events);
    expect(card.hires).toBe(page.totals.hires);
    expect(card.spentUsdc).toBe(page.totals.spentUsdc);
    expect(card.hires).toBe(1);
  });

  it("lists a card without the result on it", () => {
    const run = finished({ templateId: "compare" });
    const card = toPublicMissionCard(run, getGrowEvents(run.runId));
    expect(card.mission).toBe("PRIVATE BRIEF");
    // Listing the gallery must not bulk-serve everybody's deliverables.
    expect(JSON.stringify(card)).not.toContain("THE RESULT");
    expect(card.hires).toBe(1);
  });
});

describe("the share card, which is how a mission link travels", () => {
  it("keeps accents, curly quotes and non-Latin text, and drops only what tofus", () => {
    // Rendered against the real card: accents, curly quotes, em dashes and CJK
    // all draw correctly; pictographs and standalone symbols come out as a tofu
    // box. So the strip is those categories and nothing wider — a blanket ASCII
    // filter would have mangled every accented or non-Latin brief.
    const out = clip("Compare Björk’s café favourites 🚀 vs. 日本語 handling ✓ — naïve résumé ✅", 200);
    expect(out).toContain("Björk’s café favourites");
    expect(out).toContain("日本語");
    expect(out).toContain("—");
    for (const glyph of ["🚀", "✓", "✅"]) expect(out).not.toContain(glyph);
  });

  it("collapses the newlines a pasted brief carries, and clips with an ASCII ellipsis", () => {
    expect(clip("one\n\n  two\tthree ", 200)).toBe("one two three");
    const long = clip("x".repeat(400), 40);
    expect(long).toHaveLength(40);
    expect(long.endsWith("...")).toBe(true);
    // Not the Unicode ellipsis: the renderer's default font can't be trusted
    // with every glyph, and this one is drawn into an image nobody re-reads.
    expect(long).not.toContain("…");
  });

  it("draws a card for a published mission and a blank one for anything else", async () => {
    const { missionCard } = await import("@/app/m/[runId]/ogCard");
    const run = finished();
    const bytes = async (id: string) =>
      Buffer.from(await (await missionCard(id)).arrayBuffer());

    // Unpublished: the brief is the thing publication exists to gate, and this
    // endpoint is public and unauthenticated. It must render exactly like a run
    // that never existed — identical bytes, so the card can't be used to probe
    // which ids are real.
    const missing = await bytes(randomUUID());
    expect(await bytes(run.runId)).toEqual(missing);

    setGrowRunPublished(run.runId, OWNER, true);
    const live = await bytes(run.runId);
    expect(live).not.toEqual(missing);

    // ...and taking it down puts the brief back behind the boundary.
    setGrowRunPublished(run.runId, OWNER, false);
    expect(await bytes(run.runId)).toEqual(missing);
  }, 30000);
});

describe("cutting a brief never cuts a character in half", () => {
  const lone = (s: string) =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  it("keeps the subject whole when a template truncates it", () => {
    // The filled brief is stored and published. Slicing by code unit left a lone
    // surrogate here, which SQLite scrubs on write — so the mission kept a
    // permanent tofu box where the person had typed an emoji.
    const t = MISSION_TEMPLATES[0];
    for (const pad of [198, 199, 200]) {
      const brief = fillMissionTemplate(t, "a".repeat(pad) + "🚀 tail")!;
      expect(lone(brief)).toBe(false);
    }
  });

  it("keeps the title whole where the share preview reads it", () => {
    // Measured on the live page: an emoji straddling character 90 served an
    // og:title containing a mangled half-character.
    for (const pad of [88, 89, 90]) {
      expect(lone(cutWithEllipsis("C".repeat(pad) + "🚀 and more", 90))).toBe(false);
    }
  });

  it("keeps whole characters on the card, and still fits the width budget", () => {
    for (const pad of [37, 38, 39]) {
      const out = clip("C".repeat(pad) + "𠜎 and more text besides", 40);
      expect(lone(out)).toBe(false);
      // The ellipsis comes out of the allowance — the card has a fixed width.
      expect(Array.from(out).length).toBeLessThanOrEqual(40);
    }
  });

  it("does not split a multi-codepoint cluster into its pieces", () => {
    // A family emoji is several code points joined by zero-width joiners; a
    // code-point-wise cut would leave a dangling joiner or a stray person.
    const out = cut("abc👨‍👩‍👧def", 4);
    expect(out).toBe("abc👨‍👩‍👧");
    expect(lone(out)).toBe(false);
  });
});
