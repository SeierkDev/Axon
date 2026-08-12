// The autonomy log: Axon's record of checking itself.
//
// The page built on this is a credibility surface, so the reader here is a
// degraded log, not a healthy one. A malformed line, a missing file, or a
// truncated write must cost the entry — never the page — because a self-check
// page that 500s is worse than no page at all.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The lib reads relative to process.cwd(), so each test points cwd at a
// throwaway repo root.
let dir: string;
const cwd = process.cwd();

function writeLog(latest?: unknown, history?: unknown[]) {
  mkdirSync(join(dir, "autonomy"), { recursive: true });
  if (latest !== undefined) {
    writeFileSync(join(dir, "autonomy", "latest.json"), JSON.stringify(latest));
  }
  if (history !== undefined) {
    writeFileSync(
      join(dir, "autonomy", "history.jsonl"),
      history.map((h) => (typeof h === "string" ? h : JSON.stringify(h))).join("\n") + "\n",
    );
  }
}

const run = (over: Record<string, unknown> = {}) => ({
  startedAt: "2026-08-09T10:00:00.000Z",
  finishedAt: "2026-08-09T10:00:12.000Z",
  commit: "abc1234",
  checks: [
    {
      id: "links", title: "Internal links point at real pages", ok: true, checked: 168, ms: 60,
      findings: [],
    },
    {
      id: "install-commands", title: "Install commands resolve", ok: false, checked: 10, ms: 7000,
      findings: [
        { severity: "error", what: 'npm package "axonsdk" does not resolve', why: "the docs tell people to install something that isn't published", where: ["src/app/docs/guides/autonomous-agents/page.tsx"] },
        { severity: "warn", what: "listGrowRuns() is exported but never used", why: "dead code reads exactly like live code", where: ["src/lib/grow.ts"] },
      ],
    },
  ],
  errors: 1,
  warnings: 1,
  changed: false,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axon-autonomy-"));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

// The module resolves its log directory per call, so one import serves every
// test even as cwd moves.
async function lib() {
  return await import("@/lib/autonomy");
}

describe("the autonomy log, read back", () => {
  it("returns the latest pass with its findings intact", async () => {
    writeLog(run());
    const { getLatestRun, openFindings } = await lib();
    const latest = getLatestRun();
    expect(latest?.commit).toBe("abc1234");
    expect(latest?.errors).toBe(1);
    expect(openFindings(latest)).toHaveLength(2);
  });

  it("puts errors before warnings, so the worst thing is read first", async () => {
    writeLog(run());
    const { getLatestRun, openFindings } = await lib();
    expect(openFindings(getLatestRun()).map((f) => f.severity)).toEqual(["error", "warn"]);
  });

  it("says nothing has run yet rather than throwing, before the first pass", async () => {
    const { getLatestRun, getRunHistory, openFindings } = await lib();
    expect(getLatestRun()).toBeNull();
    expect(getRunHistory()).toEqual([]);
    // The page renders this state; it must not need a null guard at every use.
    expect(openFindings(null)).toEqual([]);
  });

  it("survives a corrupt latest.json instead of taking the page down", async () => {
    mkdirSync(join(dir, "autonomy"), { recursive: true });
    writeFileSync(join(dir, "autonomy", "latest.json"), "{ this is not json");
    const { getLatestRun } = await lib();
    expect(getLatestRun()).toBeNull();
  });

  it("skips a half-written history line and keeps the rest", async () => {
    // An append-only log truncated mid-write should cost that one entry.
    writeLog(run(), [run({ commit: "aaa" }), '{"startedAt":"trunc', run({ commit: "ccc" })]);
    const { getRunHistory } = await lib();
    const hist = getRunHistory();
    expect(hist).toHaveLength(2);
    expect(hist.map((r) => r.commit)).toEqual(["ccc", "aaa"]);
  });

  it("returns history newest first and honours the limit", async () => {
    writeLog(run(), ["a", "b", "c", "d", "e"].map((c) => run({ commit: c })));
    const { getRunHistory } = await lib();
    expect(getRunHistory(3).map((r) => r.commit)).toEqual(["e", "d", "c"]);
  });

  it("records whether a pass changed anything, so reporting can't be mistaken for editing", async () => {
    // The distinction is the whole safety story of the first tier.
    writeLog(run());
    const { getLatestRun } = await lib();
    expect(getLatestRun()?.changed).toBe(false);
  });
});

describe("a pass that edits is distinguishable from one that only looked", () => {
  it("records the repairs it applied, separately from the problems it found", async () => {
    // Collapsing the two would lose the only distinction that makes an
    // automated change reviewable: an opinion and an edit are not the same
    // event, and a reader needs to see which happened.
    writeLog(
      run({
        changed: true,
        changes: [
          { what: "dropped the export from checkThreshold()", where: "src/lib/spendThreshold.ts" },
          { what: "dropped the export from postToTelegram()", where: "src/lib/telegram.ts" },
        ],
      }),
    );
    const { getLatestRun, openFindings } = await lib();
    const latest = getLatestRun();
    expect(latest?.changed).toBe(true);
    expect(latest?.changes).toHaveLength(2);
    // Findings are still findings — fixing two of them does not rewrite history.
    expect(openFindings(latest)).toHaveLength(2);
  });

  it("treats a pass with no changes as a checking pass", async () => {
    writeLog(run({ changed: false, changes: [] }));
    const { getLatestRun } = await lib();
    expect(getLatestRun()?.changed).toBe(false);
    expect(getLatestRun()?.changes).toEqual([]);
  });

  it("reads an older entry written before changes were recorded", async () => {
    // history.jsonl is append-only and predates the field; the page must render
    // those rows rather than assume every entry has the newer shape.
    const legacy = run() as Record<string, unknown>;
    delete legacy.changes;
    writeLog(legacy, [legacy]);
    const { getLatestRun, getRunHistory } = await lib();
    expect(getLatestRun()?.changes).toBeUndefined();
    expect(getRunHistory()).toHaveLength(1);
  });
});

// ── Tier 3: the pass over the network ────────────────────────────────────────
// The load-bearing property is consent. This pass sees every agent and is
// allowed to change exactly one thing about the ones that asked for it.

describe("the network pass acts only where an owner opted in", () => {
  it("leaves an agent alone unless auto_price is set, however badly it is priced", async () => {
    process.chdir(cwd); // the DB-backed lib needs the real project root
    const { getDb } = await import("@/lib/db");
    const { createAgent } = await import("@/lib/agents");
    const { runNetworkPass } = await import("@/lib/autonomyNetwork");
    const { createTask, startTask, completeTask } = await import("@/lib/tasks");
    const { randomUUID } = await import("crypto");

    const id = `optout-${randomUUID().slice(0, 8)}`;
    const buyer = `buyer-${randomUUID().slice(0, 8)}`;
    for (const a of [id, buyer]) {
      createAgent({
        agentId: a, name: a, capabilities: ["research"], publicKey: `pk-${a}`,
        provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(),
        price: "0.10 USDC",
      });
    }
    // Enough history that the optimiser would certainly want to act.
    for (let i = 0; i < 3; i++) {
      const t = createTask({ fromAgent: buyer, toAgent: id, task: `job ${i}` });
      startTask(t.taskId);
      completeTask(t.taskId, "done");
    }

    const before = getDb().prepare("SELECT price FROM agents WHERE agent_id = ?").get(id) as { price: string };
    const run = runNetworkPass({ apply: true });
    const after = getDb().prepare("SELECT price FROM agents WHERE agent_id = ?").get(id) as { price: string };

    expect(after.price).toBe(before.price);
    expect(run.changes.map((c) => c.agentId)).not.toContain(id);
    // Seeing it is fine. Touching it is not.
    expect(run.agentsSeen).toBeGreaterThan(0);
  });

  it("a dry pass writes nothing at all", async () => {
    process.chdir(cwd);
    const { getDb } = await import("@/lib/db");
    const { runNetworkPass } = await import("@/lib/autonomyNetwork");
    const count = () =>
      (getDb().prepare("SELECT COUNT(*) n FROM autonomy_network_runs").get() as { n: number }).n;

    const before = count();
    const run = runNetworkPass({ apply: false });
    expect(count()).toBe(before);
    // It still computed everything — a preview you cannot read is not a preview.
    expect(run.agentsSeen).toBeGreaterThan(0);
    expect(Array.isArray(run.observations)).toBe(true);
  });

  it("records a pass that acted, so the network side is inspectable too", async () => {
    process.chdir(cwd);
    const { runNetworkPass, getLatestNetworkRun } = await import("@/lib/autonomyNetwork");
    const run = runNetworkPass({ apply: true });
    const latest = getLatestNetworkRun();
    expect(latest?.runId).toBe(run.runId);
    expect(latest?.agentsSeen).toBe(run.agentsSeen);
  });
});

describe("history entries stay small without lying about their shape", () => {
  it("reads a summary entry — findings stripped, arrays still arrays", async () => {
    // The writer stores a summary in history.jsonl: a full entry is ~2.7KB, the
    // page only ever shows a previous pass's date and totals, and the file is
    // read whole on every render. What the reader must never see is a summary
    // that disagrees with the type it hands back — an entry whose `changes` had
    // become a number would break the first caller that mapped over it.
    const summary = {
      ...run(),
      checks: run().checks.map((c) => ({ ...c, findings: [] })),
      changes: [],
    };
    writeLog(run(), [summary, summary]);
    const { getRunHistory } = await lib();
    const hist = getRunHistory();
    expect(hist).toHaveLength(2);
    for (const h of hist) {
      expect(Array.isArray(h.checks)).toBe(true);
      expect(Array.isArray(h.changes)).toBe(true);
      // Counts survive the trim — they are the only thing the page renders.
      expect(h.errors).toBe(1);
      expect(h.warnings).toBe(1);
      expect(h.checks).toHaveLength(2);
    }
  });

  it("still surfaces the latest pass in full, since that is where detail lives", async () => {
    const summary = { ...run(), checks: run().checks.map((c) => ({ ...c, findings: [] })), changes: [] };
    writeLog(run(), [summary]);
    const { getLatestRun, openFindings } = await lib();
    // latest.json keeps everything; history is the thin index beside it.
    expect(openFindings(getLatestRun())).toHaveLength(2);
  });
});

describe("the network pass does not invent demand out of bad input", () => {
  it("ignores capabilities that are not shaped like names", async () => {
    // open_tasks.capabilities is client-supplied and reaches a public page. When
    // it is not valid JSON the reader falls back to a comma split, so a body of
    // `{{broken` arrived as a capability and /autonomy reported that nobody
    // offers "{{broken" — a demand signal manufactured from a parse failure.
    process.chdir(cwd);
    const { getDb } = await import("@/lib/db");
    const { runNetworkPass } = await import("@/lib/autonomyNetwork");
    const { randomUUID } = await import("crypto");

    const db = getDb();
    const insert = (caps: string) =>
      db.prepare(
        "INSERT INTO open_tasks (open_task_id, from_agent, task, capabilities, status, created_at) VALUES (?,?,?,?,?,?)",
      ).run(randomUUID(), "junk-probe-test", "probe", caps, "open", new Date().toISOString());

    const junk = ['{{broken', '{"not":"an array"}', 'null', '[]', '[123, null, "  "]', '<script>x</script>'];
    junk.forEach(insert);
    insert(JSON.stringify(["quantum-forecasting-probe"]));
    try {
      const gaps = runNetworkPass({ apply: false }).observations.filter((o) => o.kind === "capability-gap");
      // The real one survives...
      expect(gaps.some((g) => g.what.includes("quantum-forecasting-probe"))).toBe(true);
      // ...and none of the junk becomes a capability.
      for (const bad of ["{{broken", "not", "script", "123", "null"]) {
        expect(gaps.some((g) => g.what.includes(`"${bad}"`))).toBe(false);
      }
    } finally {
      db.prepare("DELETE FROM open_tasks WHERE from_agent = 'junk-probe-test'").run();
    }
  });
});
