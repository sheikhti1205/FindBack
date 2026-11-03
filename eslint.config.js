import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Agent workspaces and their Vite render caches are not project source:
    // they are untracked artefacts that otherwise make `npm run lint` fail with
    // thousands of no-undef errors from bundled dependencies.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/android/**",
      "**/coverage/**",
      ".opencode/**",
      ".playwright-mcp/**",
      "tmp-*.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Console noise is banned in mobile app source; report via utils/log.
    // CLI/build/scan/reporting scripts intentionally write to stdout — leave them alone.
    files: ["apps/mobile/src/**/*.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Deno Edge Functions run on Deno, not Node: the Web API globals the
    // module uses are provided by the runtime, so no-undef must not flag them.
    files: ["supabase/functions/**/*.js"],
    languageOptions: {
      globals: {
        Request: "readonly",
        Response: "readonly",
        crypto: "readonly",
        Deno: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    // Azure Functions v3 entrypoints are intentionally dependency-free CommonJS.
    files: ["apps/share-preview/**/*.cjs"],
    languageOptions: { globals: { module: "readonly", require: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "tools/**/*.mjs", "supabase/tests/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextDecoder: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
);
