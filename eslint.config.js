import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/android/**", "**/coverage/**", "tmp-*.mjs"] },
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
