import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/solana.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: "es2020",
  outDir: "dist",
});
