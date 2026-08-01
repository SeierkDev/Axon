// Build, verify, and (with --publish) release the three client packages.
//
//   node scripts/release-packages.mjs              # build + verify, changes nothing
//   node scripts/release-packages.mjs --publish    # actually publish
//
// Verification is the point. Publishing a version is permanent — npm and PyPI
// both refuse to reuse a version number even after an unpublish — so everything
// that can be checked before the irreversible step is checked here: the packages
// build, they pack the files they claim, the declared licence matches the LICENSE
// that ships beside it, and the artefacts install and run from a clean directory.

import { execFileSync } from "child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { join, resolve } from "path";

// Not `import.meta.dirname` — that is Node 20.11+, and the packages this script
// publishes promise `node >=18`. On 18 it is silently undefined and resolve()
// throws on a null path, which would be a confusing failure in the one script a
// maintainer runs least often.
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PUBLISH = process.argv.includes("--publish");

const NPM_PACKAGES = ["packages/sdk", "packages/cli"];
const PY_PACKAGE = "packages/sdk-python";

const sh = (cmd, args, cwd = ROOT, quiet = true) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const head = (m) => console.log(`\n${m}`);

// ── licence consistency ──────────────────────────────────────────────────────
// The SDKs declared MIT while shipping the AGPL text next to it. A package whose
// metadata and LICENSE file disagree says nothing enforceable about how it may be
// used, and it cannot be walked back once people depend on it.
function checkLicence(dir, declared) {
  const file = join(ROOT, dir, "LICENSE");
  if (!existsSync(file)) return bad(`${dir}: declares ${declared} but ships no LICENSE file`);
  const first = readFileSync(file, "utf8").split("\n")[0].trim();
  const shipped = first.startsWith("MIT") ? "MIT" : first.includes("AFFERO") ? "AGPL-3.0-only" : first;
  if (shipped !== declared) return bad(`${dir}: declares ${declared} but ships "${first}"`);
  ok(`${dir}: ${declared}, and the LICENSE file agrees`);
}

// ── npm packages ─────────────────────────────────────────────────────────────
head("npm packages");
const tarballs = {};
for (const dir of NPM_PACKAGES) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8"));
  checkLicence(dir, pkg.license);

  // Install from the lockfile before building. Each package has its own tree,
  // and without one the build silently resolves up to the root's — the CLI built
  // against the root's bs58 v4 instead of its declared v6 and produced a
  // different bundle, which is not a thing to discover after publishing.
  sh("npm", ["ci"], join(ROOT, dir));
  sh("npm", ["run", "build"], join(ROOT, dir));
  const tgz = sh("npm", ["pack", "--silent"], join(ROOT, dir)).trim().split("\n").pop();
  tarballs[pkg.name] = { dir, tgz, version: pkg.version };

  const listed = sh("tar", ["tzf", tgz], join(ROOT, dir)).split("\n").filter(Boolean);
  // These three are what someone sees on the package page before they install
  // anything, and they are easy to drop by editing `files` — so assert them.
  const wanted = ["package/README.md", "package/LICENSE", "package/CHANGELOG.md"];
  const missing = wanted.filter((f) => !listed.includes(f));
  if (missing.length) bad(`${pkg.name}: tarball is missing ${missing.join(", ")}`);
  else ok(`${pkg.name}@${pkg.version}: packs ${listed.length} files, with README, LICENSE and CHANGELOG`);
}

// Install both from their tarballs into one throwaway project and use them. A
// package that builds is not the same as a package that works once installed —
// wrong "files", a bad "bin" path, or a missing export only shows up here.
head("clean-room install");
const tmp = mkdtempSync(join(tmpdir(), "axon-release-"));
try {
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", private: true }));
  for (const { dir, tgz } of Object.values(tarballs)) {
    sh("npm", ["install", "--silent", "--no-audit", "--no-fund", join(ROOT, dir, tgz)], tmp);
  }
  const sdk = sh("node", ["-e", "const s=require('@axonprotocol/sdk');process.stdout.write(typeof s.AxonClient)"], tmp);
  if (sdk === "function") ok("@axonprotocol/sdk: AxonClient loads from the installed package");
  else bad(`@axonprotocol/sdk: AxonClient is ${sdk}`);
  try {
    sh("node", ["-e", "require('@axonprotocol/sdk/node')"], tmp);
    ok("@axonprotocol/sdk/node: subpath export resolves");
  } catch { bad("@axonprotocol/sdk/node: subpath export does not resolve"); }

  // /solana needs the Solana libraries, which are optional peers — npm does not
  // install them, as this check originally discovered the hard way against the
  // already-published 0.5.0. Both directions are the contract: it must fail
  // without them (or we're silently shipping 11 MB to everyone) and work with
  // them (or the documented install line is a lie).
  try {
    sh("node", ["-e", "require('@axonprotocol/sdk/solana')"], tmp);
    bad("@axonprotocol/sdk/solana: resolved WITHOUT the optional Solana peers — the peer contract is wrong");
  } catch {
    ok("@axonprotocol/sdk/solana: correctly unavailable until the optional peers are installed");
  }
  sh("npm", ["install", "--silent", "--no-audit", "--no-fund", "@solana/web3.js", "@solana/spl-token"], tmp);
  try {
    sh("node", ["-e", "require('@axonprotocol/sdk/solana')"], tmp);
    ok("@axonprotocol/sdk/solana: resolves once the documented peers are installed");
  } catch { bad("@axonprotocol/sdk/solana: still broken WITH the peers installed"); }
  const help = sh(join(tmp, "node_modules/.bin/axon"), ["help"], tmp);
  if (help.includes("Usage: axon")) ok("@axonprotocol/cli: the axon binary runs");
  else bad("@axonprotocol/cli: the axon binary did not print help");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ── python package ───────────────────────────────────────────────────────────
head("python package");
const pyproject = readFileSync(join(ROOT, PY_PACKAGE, "pyproject.toml"), "utf8");
const pyVersion = /^version = "(.+)"$/m.exec(pyproject)?.[1] ?? "?";
checkLicence(PY_PACKAGE, /license = \{ text = "(.+)" \}/.exec(pyproject)?.[1] ?? "?");
rmSync(join(ROOT, PY_PACKAGE, "dist"), { recursive: true, force: true });
sh("python3", ["-m", "build"], join(ROOT, PY_PACKAGE));

// Whether twine is installed and whether the distribution is sound are two
// different questions, and one try/catch answered both with "fine". A corrupt
// wheel reported ok and --publish would have gone ahead on it.
let haveTwine = true;
try {
  sh("python3", ["-m", "twine", "--version"], join(ROOT, PY_PACKAGE));
} catch {
  haveTwine = false;
}
if (!haveTwine) {
  ok(`axonsdk@${pyVersion}: sdist and wheel build`);
  console.log("        twine is not installed, so the distribution metadata was NOT checked.");
  console.log("        `pip install twine` to check it — publishing needs twine anyway.");
} else {
  try {
    sh("python3", ["-m", "twine", "check", "dist/*"], join(ROOT, PY_PACKAGE));
    ok(`axonsdk@${pyVersion}: sdist and wheel build, twine check passes`);
  } catch (err) {
    bad(`axonsdk@${pyVersion}: twine check failed — ${String(err.stdout || err.message).trim().split("\n").pop()}`);
  }
}

// ── result ───────────────────────────────────────────────────────────────────
if (failures) {
  console.log(`\n${failures} check(s) failed — nothing published.`);
  process.exit(1);
}

if (!PUBLISH) {
  console.log(`
All checks passed. Nothing was published.

To publish for real (needs an npm login and a PyPI token):

  node scripts/release-packages.mjs --publish

or run the three steps by hand:

  cd packages/sdk         && npm publish --access public
  cd packages/cli         && npm publish --access public
  cd packages/sdk-python  && python3 -m twine upload dist/*
`);
  process.exit(0);
}

// ── publish ──────────────────────────────────────────────────────────────────
// Three separate registries, so a release can half-succeed. Two things make that
// survivable: find out what is already published before touching anything, and
// skip those instead of aborting. Without the skip, a run that failed on the
// second package could never be finished — the retry would die on the first with
// "cannot publish over the previously published version" and never reach the rest.
head("pre-flight");

function npmHasVersion(name, version) {
  try {
    if (sh("npm", ["view", `${name}@${version}`, "version"]).trim() === version) return true;
  } catch {
    /* fall through to the tag check */
  }
  // A newly created scoped package can be published and still 404 from `npm
  // view` for a while — the packument reaches the public read replica after the
  // dist-tags do. Measured on @axonprotocol/cli's first publish: `npm view`
  // 404'd for minutes while `npm dist-tag ls` already reported latest: 0.6.0.
  // Without this the pre-flight calls a published version unpublished and the
  // run dies re-publishing it, before it ever reaches PyPI.
  try {
    return sh("npm", ["dist-tag", "ls", name]).split("\n").some((l) => l.split(": ")[1]?.trim() === version);
  } catch {
    return false; // genuinely not published
  }
}

async function pypiHasVersion(name, version) {
  try {
    const res = await fetch(`https://pypi.org/pypi/${name}/json`);
    if (!res.ok) return false;
    return Object.keys((await res.json()).releases ?? {}).includes(version);
  } catch {
    return false;
  }
}

const todo = [];
for (const [name, meta] of Object.entries(tarballs)) {
  if (npmHasVersion(name, meta.version)) {
    console.log(`  skip  ${name}@${meta.version} is already on npm`);
  } else {
    todo.push([name, meta]);
    ok(`${name}@${meta.version} is not on npm yet`);
  }
}
const pyTodo = !(await pypiHasVersion("axonsdk", pyVersion));
if (pyTodo) ok(`axonsdk@${pyVersion} is not on PyPI yet`);
else console.log(`  skip  axonsdk@${pyVersion} is already on PyPI`);

if (!todo.length && !pyTodo) {
  console.log("\nEverything at these versions is already published. Bump the versions to release again.");
  process.exit(0);
}

// A dry run of every npm publish first, so credential and permission problems
// surface before the first irreversible one rather than between them.
for (const [name, { dir }] of todo) {
  try {
    sh("npm", ["publish", "--access", "public", "--dry-run"], join(ROOT, dir));
    ok(`${name}: dry-run publish accepted`);
  } catch (err) {
    bad(`${name}: dry-run publish rejected — ${String(err.stderr || err.message).trim().split("\n")[0]}`);
  }
}
if (failures) {
  console.log(`\n${failures} pre-flight check(s) failed — nothing published.`);
  process.exit(1);
}

head("publishing");
for (const [name, { dir, version }] of todo) {
  try {
    sh("npm", ["publish", "--access", "public"], join(ROOT, dir), false);
    console.log(`  published ${name}@${version}`);
  } catch (err) {
    // npm publish runs with inherited stdio so its interactive 2FA prompt works,
    // which means nothing to grep here. Ask the registry instead: if the version
    // is there, the failure was "cannot publish over" and the right move is to
    // carry on to the remaining packages rather than die before PyPI.
    if (!npmHasVersion(name, version)) throw err;
    console.log(`  skip  ${name}@${version} is already published`);
  }
}
if (pyTodo) {
  sh("python3", ["-m", "twine", "upload", "dist/*"], join(ROOT, PY_PACKAGE), false);
  console.log(`  published axonsdk@${pyVersion}`);
}
console.log("\nDone. Re-running is safe — anything already published is skipped.");
