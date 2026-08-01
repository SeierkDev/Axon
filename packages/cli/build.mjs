import { build } from "esbuild";
import { chmodSync } from "fs";

// One bundled file, no runtime dependencies.
//
// This is a CLI people reach for with `npx`, so install time is the first thing
// they experience. Bundling tweetnacl and bs58 in (both tiny) means npx fetches
// one small package and nothing else. It also means the published artefact never
// drifts from the lockfile that built it.
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/axon.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "inline",   // keep bundled deps' MIT notices in the artefact
  logLevel: "info",
});

chmodSync("dist/axon.js", 0o755);
