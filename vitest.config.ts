import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/db.ts", "src/lib/logger.ts", "src/lib/migrations.ts"],
      // Thresholds lock in the current baseline. Raise as coverage improves.
      thresholds: { statements: 84, branches: 76 },
    },
    // Each test file gets its own isolated module context — important for DB
    isolate: true,
  },
});
