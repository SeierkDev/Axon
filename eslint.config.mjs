import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Allow _-prefixed variables and catch bindings to signal intentional non-use.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated coverage output — not application code
    "coverage/**",
    // Standalone packages have their own tsconfig/build/lint — not app code
    // (mirrors the "packages" exclude in the app's tsconfig).
    "packages/**",
    // Vendored Solidity dependencies, pulled in as git submodules. They ship their own JS test
    // suites, which are not ours to lint and which drown out real findings: locally, with the
    // submodules checked out, they accounted for over a thousand errors. CI never saw them because
    // it does not check out submodules, so the noise was invisible there and blinding here.
    "contracts/lib/**",
  ]),
]);

export default eslintConfig;
