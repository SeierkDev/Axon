// The checks themselves, and the fixer.
//
// These had no tests until now: the script ran its pass at module load, so
// importing it was running it. That left the one component that rewrites source
// as the only untested part of the system, and it had already been wrong twice
// during development — once counting a symbol inside a string as a use, once
// stripping so aggressively it erased live code.
//
// So the cases below are the two failures that actually happened, plus the
// transform the fixer performs.

import { describe, it, expect } from "vitest";
import { rmSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { codeOf, applyFixes, npmPackagesIn, pipPackagesIn, checkInternalLinks } from "../../scripts/autonomy.mjs";

describe("codeOf: what counts as code when looking for uses", () => {
  it("drops comments and quoted text", () => {
    const out = codeOf(`const a = "listGrowRuns"; // listGrowRuns\nconst b = listGrowRuns();`);
    expect(out).not.toMatch(/"listGrowRuns"/);
    expect(out.split("\n")[1]).toContain("listGrowRuns()");
  });

  it("does not let one unbalanced quote swallow the lines after it", () => {
    // The bug this exists to prevent, reproduced rather than described. A stray
    // apostrophe in a comment and an ordinary quoted string several lines later
    // are one regex match apart: whole-file stripping joins them and deletes
    // everything between. Measured on commerce.test.ts that erased real uses of
    // toMinor() and would have reported a live function as dead code.
    //
    // Checked against the implementation that shipped: whole-file leaves 1 of
    // the 3 uses standing, line-local leaves all 3. A test that both versions
    // pass would be worth nothing here.
    const src = [
      "// it doesn't matter what this says",
      "const x = toMinor(1);",
      "const y = toMinor(2);",
      "const label = 'ok';",
      "const z = toMinor(3);",
    ].join("\n");
    expect(codeOf(src).match(/\btoMinor\b/g) ?? []).toHaveLength(3);
  });

  it("keeps line count stable, so nothing shifts under a line-based reader", () => {
    const src = "a\n// b\n`c`\nd";
    expect(codeOf(src).split("\n")).toHaveLength(4);
  });
});

describe("applyFixes: the only thing here that edits source", () => {
  const finding = (file: string, symbol: string) => [
    { findings: [{ severity: "warn", what: "", why: "", where: [file], fix: { kind: "de-export", file, symbol } }] },
  ];

  // applyFixes resolves fix.file against the repo root, so write into a path it
  // will find and pass the same relative path back.
  function inRepo(relPath: string, body: string) {
    const abs = join(process.cwd(), relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
    return { abs, rel: relPath };
  }

  it("drops the export keyword and nothing else", () => {
    const f = inRepo("src/lib/__fixprobe_a.ts", "export function keepMe(a: number) {\n  return a;\n}\n");
    try {
      const applied = applyFixes(finding(f.rel, "keepMe"));
      expect(applied).toHaveLength(1);
      expect(readFileSync(f.abs, "utf8")).toBe("function keepMe(a: number) {\n  return a;\n}\n");
    } finally {
      rmSync(f.abs, { force: true });
    }
  });

  it("keeps async where it is — the riskiest edit it makes", () => {
    const f = inRepo("src/lib/__fixprobe_b.ts", "export async function later(): Promise<void> {}\n");
    try {
      applyFixes(finding(f.rel, "later"));
      expect(readFileSync(f.abs, "utf8")).toBe("async function later(): Promise<void> {}\n");
    } finally {
      rmSync(f.abs, { force: true });
    }
  });

  it("will not touch a symbol whose name merely starts the same", () => {
    const f = inRepo("src/lib/__fixprobe_c.ts", "export function getThresholdExtra() {}\n");
    try {
      expect(applyFixes(finding(f.rel, "getThreshold"))).toHaveLength(0);
      expect(readFileSync(f.abs, "utf8")).toContain("export function getThresholdExtra");
    } finally {
      rmSync(f.abs, { force: true });
    }
  });

  it("leaves the file alone when the finding has gone stale", () => {
    // Between the check and the fix, the declaration may have moved or been
    // edited. Rewriting on a guess is how an automated fixer corrupts a file.
    const f = inRepo("src/lib/__fixprobe_d.ts", "function alreadyLocal() {}\n");
    try {
      expect(applyFixes(finding(f.rel, "alreadyLocal"))).toHaveLength(0);
      expect(readFileSync(f.abs, "utf8")).toBe("function alreadyLocal() {}\n");
    } finally {
      rmSync(f.abs, { force: true });
    }
  });

  it("ignores findings that carry no fix, so reporting stays reporting", () => {
    expect(applyFixes([{ findings: [{ severity: "error", what: "x", why: "y", where: [] }] }])).toEqual([]);
  });
});

describe("--dry means what it says, even alongside --fix", () => {
  it("reports what it would change without touching the file", () => {
    // The two flags used to disagree: --dry documented "touch nothing" while
    // applyFixes wrote regardless, so `--dry --fix` edited source and said it
    // had not. A flag that promises not to write and then writes is worse than
    // no flag, because it is the one people reach for when unsure.
    const rel = "src/lib/__dryprobe_test.ts";
    const abs = join(process.cwd(), rel);
    const before = "export function probeMe() {}\n";
    writeFileSync(abs, before);
    try {
      const would = applyFixes(
        [{ findings: [{ severity: "warn", what: "", why: "", where: [rel], fix: { kind: "de-export", file: rel, symbol: "probeMe" } }] }],
        { write: false },
      );
      expect(would).toHaveLength(1);
      expect(would[0].what).toContain("would drop");
      expect(readFileSync(abs, "utf8")).toBe(before);
    } finally {
      rmSync(abs, { force: true });
    }
  });
});

describe("npmPackagesIn: reading an install command without reading the prose", () => {
  it("takes every package on the line, not just the first", () => {
    // The original only captured the head, so a typo in @solana/web3.js — the
    // second name on Axon's own documented install line — was never checked.
    expect(npmPackagesIn("npm install @axonprotocol/sdk @solana/web3.js @solana/spl-token"))
      .toEqual(["@axonprotocol/sdk", "@solana/web3.js", "@solana/spl-token"]);
  });

  it("stops at the end of the line rather than eating what follows", () => {
    // `\s` spans newlines. Widening the match without noticing that made it
    // swallow the paragraph underneath and report ordinary words as packages.
    const doc = "npm install @axonprotocol/cli\n\nRun the CLI to check your Proof Score in TypeScript.";
    expect(npmPackagesIn(doc)).toEqual(["@axonprotocol/cli"]);
  });

  it("stops at a shell comment", () => {
    expect(npmPackagesIn("npm install -g @axonprotocol/cli   # the CLI")).toEqual(["@axonprotocol/cli"]);
    expect(npmPackagesIn("npm install          # Install dependencies")).toEqual([]);
  });

  it("keeps flags, versions and scopes straight", () => {
    expect(npmPackagesIn("npm i -g @axonprotocol/cli")).toEqual(["@axonprotocol/cli"]);
    expect(npmPackagesIn("npm install @axonprotocol/sdk@0.6.0")).toEqual(["@axonprotocol/sdk"]);
    expect(npmPackagesIn("npm install -D typescript vitest")).toEqual(["typescript", "vitest"]);
  });

  it("ignores what is not a package name", () => {
    expect(npmPackagesIn("npm install ./local-thing")).toEqual([]);
    expect(npmPackagesIn("npm install /abs/path.tgz")).toEqual([]);
    expect(npmPackagesIn("npm install foo && npm run build")).toEqual(["foo"]);
  });
});

describe("pipPackagesIn: the same reading, for PyPI", () => {
  it("takes every package, not just the first", () => {
    // This side was written first and never revisited when the npm side was
    // fixed, so it carried the identical fault for several rounds.
    expect(pipPackagesIn("pip install requests numpy pandas")).toEqual(["requests", "numpy", "pandas"]);
  });

  it("reads the quoted extras form Axon actually documents", () => {
    // `pip install "axonsdk[signing] @ git+…"` is the real line in the Python
    // SDK's README. An earlier fix excluded quotes from a token, which made that
    // line match nothing at all — the check silently stopped covering it.
    expect(pipPackagesIn('pip install "axonsdk[signing]"')).toEqual(["axonsdk"]);
    expect(pipPackagesIn('pip install "axonsdk[signing] @ git+https://github.com/x/y.git#subdirectory=z"'))
      .toEqual(["axonsdk"]);
  });

  it("does not read across a newline or past a comment", () => {
    expect(pipPackagesIn("pip install\nrequests")).toEqual([]);
    expect(pipPackagesIn("pip install          # Install dependencies")).toEqual([]);
  });

  it("ignores flags, paths and VCS URLs", () => {
    expect(pipPackagesIn("pip install -r python/requirements.txt")).toEqual([]);
    expect(pipPackagesIn("pip install -e ../../packages/sdk-python")).toEqual([]);
    expect(pipPackagesIn("pip install git+https://github.com/x/y.git")).toEqual([]);
  });
});

describe("the link check covers where links actually live", () => {
  it("reads components, not only pages", () => {
    // The scan started at src/app, which never opens SiteNav — so the nav and
    // footer, the most-clicked links on the site, were structurally excluded.
    // Verified by breaking one: a typo'd href in SiteNav went unreported before
    // this widening and is reported after it.
    const rel = "src/components/__linkprobe.tsx";
    const abs = join(process.cwd(), rel);
    writeFileSync(abs, 'export const P = () => <a href="/definitely-not-a-page">x</a>;\n');
    try {
      const { findings, checked } = checkInternalLinks();
      expect(checked).toBeGreaterThan(0);
      const hit = findings.find((f: { what: string }) => f.what.includes("/definitely-not-a-page"));
      expect(hit).toBeDefined();
      expect(hit!.where).toContain(rel);
    } finally {
      rmSync(abs, { force: true });
    }
  });

  it("passes over test fixtures, where an href is a string and not a link", () => {
    const rel = "src/__tests__/__linkprobe_fixture.tsx";
    const abs = join(process.cwd(), rel);
    writeFileSync(abs, 'export const F = () => <a href="/also-not-a-page">x</a>;\n');
    try {
      const { findings } = checkInternalLinks();
      expect(findings.find((f: { what: string }) => f.what.includes("/also-not-a-page"))).toBeUndefined();
    } finally {
      rmSync(abs, { force: true });
    }
  });
});
