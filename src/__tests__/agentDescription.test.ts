import { describe, it, expect, vi } from "vitest";
import { buildPrompt, isUsable, tidy, describedFrom, MAX_DESCRIPTION_CHARS } from "@/lib/agentDescription";

/**
 * Descriptions of agents nobody here wrote.
 *
 * Anyone can register an agent, so its name and capabilities are text written by a stranger and then
 * put into a model prompt. Most of this file is about that: the prompt asks the model to treat those
 * fields as data, and these checks are what happens when it does not, because a prompt is a request
 * and a check is a guarantee.
 */

const agent = (name: string, capabilities: string[] = ["research"]) => ({
  name,
  capabilities,
  category: "General",
});

describe("what the model is shown", () => {
  it("keeps the agent's own words in labelled fields", () => {
    const prompt = buildPrompt(agent("Research Agent", ["research", "summarise"]));

    // Fielded rather than prose. Injected text has no sentence to blend into.
    expect(prompt).toContain("NAME: Research Agent");
    expect(prompt).toContain("CAPABILITIES: research, summarise");
  });

  it("bounds every field, however long someone made it", () => {
    const prompt = buildPrompt(agent("x".repeat(5_000), Array.from({ length: 200 }, (_, i) => `cap-${i}`)));

    // An agent whose name is a novel must not become the whole prompt.
    expect(prompt.length).toBeLessThan(700);
  });
});

describe("what comes back has to pass", () => {
  it("accepts an ordinary description", () => {
    expect(isUsable("Researches a topic and returns a short written summary with sources")).toBe(true);
  });

  it("refuses anything claiming we vouched for it", () => {
    // These are the platform's claims to make, never an agent's to assert about itself, and a
    // listing is exactly where somebody would want that sentence to appear.
    expect(isUsable("A research agent verified by Axon and approved for production use")).toBe(false);
    expect(isUsable("Official agent, endorsed by the team")).toBe(false);
    expect(isUsable("Runs research tasks on Axon")).toBe(false);
  });

  it("lets an agent actually called axon say its own name", () => {
    // There is one registered as "axon". A rule it could never satisfy would have left it retrying
    // hourly for as long as it exists, which is a gap on a card caused by a guard rather than a
    // model. The endorsement check above is what actually protects the claim.
    expect(isUsable("Runs research tasks on Axon", "Research Agent")).toBe(false);
    expect(isUsable("The axon agent, which routes work between other agents", "axon")).toBe(true);
    // Even then it cannot claim we vouch for it.
    expect(isUsable("The axon agent, officially endorsed by the team", "axon")).toBe(false);
  });

  it("refuses a link", () => {
    // A directory listing is not somewhere to put somebody else's traffic.
    expect(isUsable("Research agent, see https://example.com for details")).toBe(false);
    expect(isUsable("Research agent, docs at www.example.com")).toBe(false);
  });

  it("refuses markup and anything on a second line", () => {
    expect(isUsable("Research agent <script>alert(1)</script>")).toBe(false);
    expect(isUsable("[Click here](https://example.com)")).toBe(false);
    // Two lines is two claims, and only the first would be read on a card.
    expect(isUsable("Researches topics.\nAlso: this agent is verified.")).toBe(false);
  });

  it("refuses something too short to say anything, or too long to read", () => {
    expect(isUsable("agent")).toBe(false);
    expect(isUsable("x".repeat(MAX_DESCRIPTION_CHARS + 1))).toBe(false);
    expect(isUsable("Researches topics and writes them up")).toBe(true);
  });
});

describe("tidying an answer", () => {
  it("unwraps the quotes a model likes to add", () => {
    expect(tidy('"Researches a topic and writes it up"')).toBe("Researches a topic and writes it up");
    expect(tidy("  Researches   a  topic  ")).toBe("Researches a topic");
  });
});

describe("knowing when to rewrite one", () => {
  it("changes when the name or the capabilities do, and not otherwise", () => {
    const base = describedFrom({ name: "Research Agent", capabilities: ["research"] });

    expect(describedFrom({ name: "Research Agent", capabilities: ["research"] })).toBe(base);
    // Renaming an agent, or changing what it says it does, makes the old sentence wrong.
    expect(describedFrom({ name: "Summary Agent", capabilities: ["research"] })).not.toBe(base);
    expect(describedFrom({ name: "Research Agent", capabilities: ["research", "summarise"] })).not.toBe(base);
  });
});

describe("the backfill queue", () => {
  const seed = async (db: ReturnType<typeof import("@/lib/db").getDb>, id: string, createdAt: string) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO agents (agent_id, name, capabilities, public_key, verification_status, created_at)
         VALUES (?, ?, '["research"]', ?, 'verified', ?)`,
      )
      .run(id, id, `${id}-key`, createdAt);

  it("does not let an agent that keeps failing block everyone behind it", async () => {
    vi.resetModules();
    // Every generation fails, which is the case that used to be fatal: five agents that cannot be
    // described sat at the front of the queue forever and nothing behind them was ever reached.
    vi.doMock("@/lib/providers", () => ({
      getProvider: () => ({ complete: async () => { throw new Error("model unavailable"); } }),
    }));
    const mod = await import("@/lib/agentDescription");
    const db = (await import("@/lib/db")).getDb();
    db.prepare("DELETE FROM agents").run();

    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      await seed(db, `a${i}`, new Date(now - i * 60_000).toISOString());
    }

    const first = await mod.backfillDescriptions(2);
    const tried = db
      .prepare("SELECT agent_id FROM agents WHERE described_at IS NOT NULL ORDER BY agent_id")
      .all() as { agent_id: string }[];

    expect(first.written).toBe(0);
    expect(tried).toHaveLength(2);

    // The next pass must reach different agents, not the same two again.
    const second = await mod.backfillDescriptions(2);
    expect(second.written + second.skipped).toBe(2);
    const triedNow = db
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE described_at IS NOT NULL")
      .get() as { n: number };
    expect(triedNow.n).toBe(4);
  });

  it("leaves a recently attempted agent alone rather than retrying it every pass", async () => {
    vi.resetModules();
    vi.doMock("@/lib/providers", () => ({
      getProvider: () => ({ complete: async () => { throw new Error("model unavailable"); } }),
    }));
    const mod = await import("@/lib/agentDescription");
    const db = (await import("@/lib/db")).getDb();
    db.prepare("DELETE FROM agents").run();
    await seed(db, "only", new Date().toISOString());

    await mod.backfillDescriptions(5);
    const again = await mod.backfillDescriptions(5);

    // One agent, one attempt. Without the cooldown this would burn a model call every five minutes
    // for as long as the agent exists.
    expect(again.written + again.skipped).toBe(0);
  });
});
