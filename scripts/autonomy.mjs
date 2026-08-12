// Axon's maintenance pass over itself.
//
//   node scripts/autonomy.mjs            # check, write the log
//   node scripts/autonomy.mjs --dry      # check and print, touch nothing
//   node scripts/autonomy.mjs --fix      # check, then apply the safe fixes
//   node scripts/autonomy.mjs --only=links
//
// Each check answers one question about whether the project still tells the
// truth about itself, and every run is appended to autonomy/history.jsonl and
// committed. The log lives in git on purpose: a claim that the project maintains
// itself is only worth anything if you can diff it, so the receipt for a run is
// a commit rather than a number on a dashboard.
//
// Two tiers. Without --fix the pass only reports, and every run records
// `changed: false`. With --fix it also applies the narrow class of repairs that
// a compiler can prove: today that is dropping the `export` keyword from a
// function nothing outside its own file uses.
//
// The line between them matters. The moment a pass writes code, "it found
// nothing" and "it broke nothing" stop being the same statement — so fixes never
// land on main. --fix runs on a branch, opens a pull request, and the ordinary
// test suite decides. The thing making the change is not the thing certifying it.

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import { join, resolve, relative } from "path";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LOG_DIR = join(ROOT, "autonomy");
const DRY = process.argv.includes("--dry");
const FIX = process.argv.includes("--fix");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

// ── file walking ─────────────────────────────────────────────────────────────
const SKIP = new Set(["node_modules", ".next", ".git", ".claude", "dist", "coverage"]);
// Skipped by path, not by name. Excluding every directory called "autonomy"
// also hid src/app/autonomy from the route scan, so the link check reported the
// page it was written to serve as missing — which is how this pass found it.
const SKIP_PATHS = new Set([join(ROOT, "autonomy")]);
function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    if (SKIP_PATHS.has(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p);
const read = (p) => readFileSync(p, "utf8");

/**
 * Every npm package named by an install command in `text`.
 *
 * Fiddlier than it looks, and wrong twice before it was right. One command names
 * several packages, so taking only the first left a typo in any but the head
 * unchecked. Widening it then over-reached in two ways at once: `\s` spans
 * newlines, so the match ran past the command into the prose beneath it, and
 * nothing stopped at `#`, so shell comments became package names. Between them
 * they reported "Run", "Score" and "TypeScript" as missing packages — a check
 * that cries wolf like that gets muted, and a muted check is worse than none.
 */
export function npmPackagesIn(text) {
  const out = [];
  // `[^\S\r\n]` is whitespace that is not a newline: stay on this line.
  for (const m of text.matchAll(/npm (?:install|i)((?:[^\S\r\n]+[^\s`'"&|;]+)+)/g)) {
    for (const raw of m[1].trim().split(/[^\S\r\n]+/)) {
      // A shell comment or continuation ends the package list.
      if (raw.startsWith("#") || /^(&&|\|\||;)/.test(raw)) break;
      if (raw.startsWith("-")) continue;                        // a flag
      if (raw.startsWith(".") || raw.startsWith("/")) continue;  // a path
      if (/^[a-z+]+:/.test(raw) || raw.includes("+")) continue;  // a URL
      const name = raw.startsWith("@")
        ? raw.split("@").slice(0, 2).join("@").replace(/^@@/, "@") // @scope/name from @scope/name@1.2.3
        : raw.split("@")[0];
      if (!name || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) continue;
      out.push(name);
    }
  }
  return out;
}

/**
 * Every PyPI package named by an install command in `text`.
 *
 * The same shape as `npmPackagesIn`, and it had the same two faults for the same
 * reason — it was written first and never revisited when the npm side was fixed.
 * It took only the head of `pip install requests numpy pandas`, and its leading
 * `\s+` crossed newlines, so `pip install` at the end of a block captured the
 * first word of the next paragraph. It would also have asked PyPI whether "#"
 * exists, given `pip install   # Install dependencies`.
 */
export function pipPackagesIn(text) {
  const out = [];
  // Quotes are part of a token here, not a boundary: the documented extras form
  // is `pip install "axonsdk[signing] @ git+…"`, and excluding `"` from the
  // token meant that line matched nothing and went unchecked.
  for (const m of text.matchAll(/pip install((?:[^\S\r\n]+[^\s`&|;]+)+)/g)) {
    const toks = m[1].trim().split(/[^\S\r\n]+/);
    // PEP 508 direct reference: `name[extra] @ git+https://...` installs from the
    // URL, not from PyPI, so the registry has nothing to say about it. Checking
    // anyway reported Axon's own documented from-source line as a missing
    // package, which is the check being wrong rather than the docs.
    if (toks.some((tk, i) => tk === "@" && /^[a-z+]+:|\+/.test(toks[i + 1] ?? ""))) continue;
    for (const raw of toks) {
      if (raw.startsWith("#") || /^(&&|\|\||;)/.test(raw)) break;
      if (raw.startsWith("-")) continue;                        // -r, -e take a path
      if (raw.startsWith(".") || raw.startsWith("/")) continue;  // a path
      if (/^[a-z+]+:/.test(raw) || raw.includes("+")) continue;  // a VCS URL
      // "axonsdk[signing]" and the PEP 508 form both name the package first.
      const name = raw.replace(/^["']+/, "").replace(/["']+$/, "").split("[")[0];
      if (!name || !/^[A-Za-z][\w.-]*$/.test(name)) continue;
      out.push(name);
    }
  }
  return out;
}

// ── check: every install command in the docs actually resolves ───────────────
// The repo told people to `npm install @axon/sdk` for months. That package does
// not exist — the real name is @axonprotocol/sdk — and it sat on the front page
// of the repo until somebody happened to read it. A machine should have caught
// that the day it was written.
export async function checkInstallCommands() {
  const files = [...walk(join(ROOT, "src", "app"), [".tsx", ".ts"]), ...walk(ROOT, [".md"])];
  const found = new Map(); // "npm:name" | "pypi:name" -> Set(files)

  for (const f of files) {
    const body = read(f);
    // Every package on the line, not just the first. One install command
    // routinely names several — `npm install @axonprotocol/sdk @solana/web3.js
    // @solana/spl-token` is the documented line for paying on-chain — and
    // capturing only the head meant a typo in any package but the first was
    // never checked at all.
    for (const name of npmPackagesIn(body)) {
      found.set(`npm:${name}`, (found.get(`npm:${name}`) ?? new Set()).add(rel(f)));
    }
    for (const m of body.matchAll(/npx (?:--yes )?((?:@[\w.-]+\/)?[\w.-]+)/g)) {
      found.set(`npm:${m[1]}`, (found.get(`npm:${m[1]}`) ?? new Set()).add(rel(f)));
    }
    for (const name of pipPackagesIn(body)) {
      found.set(`pypi:${name}`, (found.get(`pypi:${name}`) ?? new Set()).add(rel(f)));
    }
  }

  // Packages this repo publishes are checked against the registry too — being
  // the author is not evidence that a release actually went out.
  //
  // "Missing" and "could not ask" are different answers and must not collapse.
  // npm returns E404 for a package that is not there and something else entirely
  // when the registry is unreachable; treating both as missing would file a false
  // error — and, through the workflow, open an issue claiming the docs are wrong
  // — every time a runner had a bad minute. A check that cries wolf on a network
  // blip is one people stop reading.
  const findings = [];
  let unverified = 0;
  // A registry that is down is down for every lookup, and each one costs its
  // whole timeout: measured against a dead registry this check took 240s instead
  // of 9, which in CI is a job that gets killed rather than a result. After two
  // consecutive failures, stop asking that registry and mark the rest unverified.
  const OUT_OF_REACH = 2;
  const consecutive = { npm: 0, pypi: 0 };
  for (const [key, where] of [...found].sort()) {
    const [registry, name] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (consecutive[registry] >= OUT_OF_REACH) {
      unverified++;
      continue;
    }
    let state; // "present" | "missing" | "unknown"
    if (registry === "npm") {
      try {
        execFileSync("npm", ["view", name, "version"], { encoding: "utf8", stdio: "pipe", timeout: 15000 });
        state = "present";
      } catch (err) {
        const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
        state = /E404|404 Not Found/.test(out) ? "missing" : "unknown";
      }
    } else {
      try {
        const res = await fetch(`https://pypi.org/pypi/${name}/json`, { signal: AbortSignal.timeout(15000) });
        state = res.ok ? "present" : res.status === 404 ? "missing" : "unknown";
      } catch {
        state = "unknown";
      }
    }

    if (state === "unknown") {
      consecutive[registry] += 1;
      unverified++;
      continue;
    }
    consecutive[registry] = 0;
    if (state === "missing") {
      findings.push({
        severity: "error",
        what: `${registry === "npm" ? "npm" : "PyPI"} package "${name}" does not resolve`,
        why: "the docs tell people to install something that isn't published under that name",
        where: [...where].sort(),
      });
    }
  }
  // Said out loud rather than swallowed: a pass that could not reach a registry
  // proves less than one that could, and the log should show the difference.
  if (unverified > 0) {
    findings.push({
      severity: "warn",
      what: `${unverified} package${unverified === 1 ? "" : "s"} could not be checked`,
      why: "the registry was unreachable, so this pass proves less than a clean one",
      where: [],
    });
  }
  return { checked: found.size, findings };
}

// ── check: internal links point at pages that exist ──────────────────────────
// Docs rot quietly. A link to a page that was renamed still looks like a link.
export function checkInternalLinks() {
  // Both page.tsx and route.ts serve a path — /mcp is a route handler, and a
  // link to it is not broken just because it renders no page.
  const routes = new Set(
    walk(join(ROOT, "src", "app"), ["page.tsx", "route.ts"]).map((p) =>
      rel(p).replace(/^src\/app/, "").replace(/\/(page\.tsx|route\.ts)$/, "") || "/",
    ),
  );
  // Dynamic segments match anything in that position.
  const dynamic = [...routes].filter((r) => r.includes("["));
  const matches = (href) => {
    if (routes.has(href)) return true;
    const parts = href.split("/");
    return dynamic.some((r) => {
      const rp = r.split("/");
      return rp.length === parts.length && rp.every((seg, i) => seg.startsWith("[") || seg === parts[i]);
    });
  };

  // Links live in components as well as pages, and the ones in components are
  // the most-clicked on the site: the nav and the footer sit in SiteNav, which a
  // scan of src/app alone never opens. Test files are excluded — an href in a
  // fixture is a string, not a link somebody can follow.
  const files = [
    ...walk(join(ROOT, "src", "app"), [".tsx"]),
    ...walk(join(ROOT, "src", "components"), [".tsx"]),
  ].filter((f) => !rel(f).includes("__tests__"));
  const findings = [];
  let checked = 0;
  for (const f of files) {
    for (const m of read(f).matchAll(/href="(\/[^"#?]*)"/g)) {
      const href = m[1].replace(/\/$/, "") || "/";
      // Route handlers and static assets aren't pages.
      if (href.startsWith("/api/") || /\.[a-z0-9]{2,4}$/i.test(href)) continue;
      checked++;
      if (!matches(href)) {
        findings.push({
          severity: "error",
          what: `link to ${href} has no page`,
          why: "a reader following it gets a 404",
          where: [rel(f)],
        });
      }
    }
  }
  // Same link from many files is one problem, not twenty.
  const merged = new Map();
  for (const f of findings) {
    const prev = merged.get(f.what);
    if (prev) prev.where = [...new Set([...prev.where, ...f.where])].sort();
    else merged.set(f.what, f);
  }
  return { checked, findings: [...merged.values()] };
}

// ── check: exports nothing imports ───────────────────────────────────────────
// Dead exports are the residue of features that moved. They cost nothing to run
// and everything to read, because the next person cannot tell them from the
// code that matters.
/**
 * Source with comments and quoted text removed, one line at a time.
 *
 * Doing it over the whole file seems tidier and is a trap: a single unbalanced
 * quote — an apostrophe in prose, a backtick in a template — makes one match span
 * the rest of the file and silently deletes real code. Measured on
 * commerce.test.ts, whole-file stripping took three genuine uses of toMinor down
 * to zero and would have reported a live function as dead. A line cannot swallow
 * its neighbours.
 */
export const codeOf = (src) =>
  src
    .split("\n")
    .map((line) =>
      line
        .replace(/\/\/.*$/, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/"[^"]*"/g, " ")
        .replace(/'[^']*'/g, " "),
    )
    .join("\n");

export function checkDeadExports() {
  const libFiles = walk(join(ROOT, "src", "lib"), [".ts"]).filter((f) => !f.endsWith(".test.ts"));
  const all = [...walk(join(ROOT, "src"), [".ts", ".tsx"]), ...walk(join(ROOT, "scripts"), [".mjs", ".ts"])];

  const stripped = new Map(all.map((f) => [f, codeOf(read(f))]));

  const findings = [];
  let checked = 0;
  for (const f of libFiles) {
    for (const m of read(f).matchAll(/^export (?:async )?function ([A-Za-z_]\w*)/gm)) {
      const name = m[1];
      // A leading underscore is this codebase's mark for a deliberate test hook.
      if (name.startsWith("_")) continue;
      checked++;
      const word = new RegExp(`\\b${name}\\b`);
      const usedElsewhere = all.some((other) => other !== f && word.test(stripped.get(other)));
      if (usedElsewhere) continue;

      // Used inside its own file is a different problem from used nowhere: the
      // first is an export that should not be one, the second is dead code.
      const own = stripped.get(f) ?? "";
      const timesHere = (own.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
      findings.push(
        timesHere > 1
          ? {
              severity: "warn",
              what: `${name}() is exported but only used inside its own file`,
              why: "the export widens the surface without a caller to justify it",
              where: [rel(f)],
              // Safe to apply: dropping `export` from a symbol nothing outside
              // the file references is a change the compiler can prove.
              fix: { kind: "de-export", file: rel(f), symbol: name },
            }
          : {
              severity: "warn",
              what: `${name}() is exported and never used`,
              why: "dead code reads exactly like live code",
              where: [rel(f)],
            },
      );
    }
  }
  return { checked, findings };
}

// ── applying the safe fixes ──────────────────────────────────────────────────
// Only what a compiler can check. Each edit is one keyword on one declaration,
// re-read from disk and matched exactly, so a stale finding cannot make this
// rewrite the wrong line.
export function applyFixes(results, { write = true } = {}) {
  const applied = [];
  for (const f of results.flatMap((r) => r.findings)) {
    if (!f.fix || f.fix.kind !== "de-export") continue;
    const path = join(ROOT, f.fix.file);
    const before = read(path);
    const decl = new RegExp(`^export (async )?function ${f.fix.symbol}\\b`, "m");
    if (!decl.test(before)) continue; // the file moved on; leave it to the next pass
    const after = before.replace(decl, (_m, isAsync) => `${isAsync ?? ""}function ${f.fix.symbol}`);
    if (after === before) continue;
    // `write: false` reports what it would do and leaves the file alone, so
    // --dry means what it says even when --fix is also passed. A flag that
    // promises to touch nothing and then edits source is worse than no flag.
    if (write) writeFileSync(path, after);
    applied.push({ what: `${write ? "dropped" : "would drop"} the export from ${f.fix.symbol}()`, where: f.fix.file });
  }
  return applied;
}

// ── runner ───────────────────────────────────────────────────────────────────
// Wrapped so the module can be imported without running a pass. The checks above
// edit source when asked, and until this guard existed they could not be tested
// at all — importing the file *was* running it. Something that rewrites code
// should be the best-covered part of this, not the only untested one.
export async function main() {
  const CHECKS = [
    { id: "install-commands", title: "Install commands resolve", run: checkInstallCommands },
    { id: "links", title: "Internal links point at real pages", run: checkInternalLinks },
    { id: "dead-exports", title: "Exports are used", run: checkDeadExports },
  ];

  const startedAt = new Date().toISOString();
  const results = [];
  for (const check of CHECKS) {
    if (ONLY && ONLY !== check.id) continue;
    process.stdout.write(`  ${check.id} … `);
    const t0 = Date.now();
    try {
      const { checked, findings } = await check.run();
      results.push({ id: check.id, title: check.title, ok: findings.filter((f) => f.severity === "error").length === 0, checked, findings, ms: Date.now() - t0 });
      console.log(`${checked} checked, ${findings.length} finding(s), ${Date.now() - t0}ms`);
      for (const f of findings) console.log(`      ${f.severity === "error" ? "ERROR" : "warn "} ${f.what}  [${f.where.join(", ")}]`);
    } catch (err) {
      results.push({ id: check.id, title: check.title, ok: false, checked: 0, findings: [{ severity: "error", what: `the check itself failed: ${err.message}`, why: "a check that cannot run proves nothing", where: [] }], ms: Date.now() - t0 });
      console.log(`FAILED — ${err.message}`);
    }
  }

  const changes = FIX ? applyFixes(results, { write: !DRY }) : [];
  if (FIX) {
    console.log(`\n${DRY ? "would apply" : "applied"} ${changes.length} fix(es):`);
    for (const c of changes) console.log(`      ${c.what}  [${c.where}]`);
  }

  const errors = results.flatMap((r) => r.findings).filter((f) => f.severity === "error").length;
  const warnings = results.flatMap((r) => r.findings).filter((f) => f.severity === "warn").length;
  const run = {
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return null; } })(),
    checks: results,
    errors,
    warnings,
    // Recorded explicitly rather than inferred, so a reader can always tell a pass
    // that looked from a pass that also edited.
    changed: changes.length > 0,
    changes,
  };

  console.log(`\n${errors} error(s), ${warnings} warning(s) across ${results.length} check(s).`);

  if (!DRY) {
    mkdirSync(LOG_DIR, { recursive: true });
    // `fix` is how the runner applies a repair; the log records what was applied,
    // so strip it rather than publishing an instruction set.
    const forLog = JSON.parse(JSON.stringify(run, (k, v) => (k === "fix" ? undefined : v)));
    writeFileSync(join(LOG_DIR, "latest.json"), `${JSON.stringify(forLog, null, 2)}\n`);

    // History carries the shape of each pass, not its full text. A complete entry
    // is ~2.7KB, the page only ever shows a previous pass's date and counts, and
    // this file is read whole on every render — so the findings would be paid for
    // on every page load and never displayed. The detail is not lost: latest.json
    // is committed each run, so `git log autonomy/latest.json` still has all of it.
    const summary = {
      ...forLog,
      checks: forLog.checks.map(({ findings: _findings, ...rest }) => ({ ...rest, findings: [] })),
      // Emptied, not counted. Turning this into a number would make history entries
      // disagree with the type every reader of the log is handed, and the page
      // shows a previous pass's date and totals — never its individual changes.
      changes: [],
    };
    appendFileSync(join(LOG_DIR, "history.jsonl"), `${JSON.stringify(summary)}\n`);

    // Keep the file bounded. Git holds every past version, so trimming the working
    // copy costs nothing an auditor can't recover with `git log`.
    const KEEP = 200;
    const lines = readFileSync(join(LOG_DIR, "history.jsonl"), "utf8").split("\n").filter(Boolean);
    if (lines.length > KEEP) {
      writeFileSync(join(LOG_DIR, "history.jsonl"), `${lines.slice(-KEEP).join("\n")}\n`);
    }
    console.log(`wrote autonomy/latest.json and appended to autonomy/history.jsonl`);
  }

  // Findings are the point of the run, not a reason to fail it — a red build every
  // time the docs drift would just get muted, and a muted check is worse than none.
  // The workflow opens an issue instead. Only a check that could not execute fails.
  const broken = results.some((r) => r.findings.some((f) => f.what.startsWith("the check itself failed")));
  process.exit(broken ? 1 : 0);

}

// Only when invoked directly, never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
