import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Supabase Auth/Data/Realtime/Storage/Functions are called directly from the
// app with the publishable key only. The secret key must never reach the mobile
// bundle. No API base URL is needed.
export function resolveSupabaseBuildEnv(
  mode: string,
  envDir = resolve(import.meta.dirname, "../.."),
) {
  const env = loadEnv(mode, envDir, "");
  return {
    publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || env.SUPABASE_PUBLISHABLE_KEY || "",
    url: env.VITE_SUPABASE_URL?.trim() || env.SUPABASE_URL || "",
  };
}

/**
 * S3 — sourcemap mode (sourcemap settings ONLY; S1/S2 own the rest of this file's contract).
 *
 * Local builds emit NO source maps: there is nothing to leak, package, or upload.
 * Only a release build that explicitly opts in with SENTRY_UPLOAD_SOURCEMAPS=true
 * emits maps, as `hidden` (files on disk, but no sourceMappingURL comment in the
 * bundle), so they exist solely to be uploaded to Sentry and then stripped before
 * Capacitor sync. Pure and unit-tested (see src/vite.sourcemaps.test.ts).
 */
export function resolveSourcemapMode(env: {
  SENTRY_UPLOAD_SOURCEMAPS?: string | undefined;
}): "hidden" | false {
  return env.SENTRY_UPLOAD_SOURCEMAPS === "true" ? "hidden" : false;
}

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    // Direct `vite build` must not bypass the same fail-closed gate used by
    // npm scripts, CI, and Gradle. Tests and `vite dev` remain DSN-free.
    const preflight = spawnSync(process.execPath,
      [resolve(import.meta.dirname, "../../scripts/check-mobile-build-config.mjs"), "--preflight"],
      { stdio: "inherit", env: process.env });
    if (preflight.status !== 0) throw new Error("Supabase build configuration preflight failed");
  }
  const { publishableKey, url } = resolveSupabaseBuildEnv(mode);
  const shareOrigin = loadEnv(mode, resolve(import.meta.dirname, "../.."), "").VITE_PUBLIC_SHARE_ORIGIN?.trim() || "";
  if (command === "build") {
    // Derive the VITE_* names in the build environment from the canonical
    // local SUPABASE_* values; import.meta.env and define then agree.
    process.env.VITE_SUPABASE_URL = url;
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  }
  const sourcemap = resolveSourcemapMode(process.env);
  // Explicit local behavior (S3): say which mode we are in so a missing upload
  // token can never be mistaken for an upload — maps simply do not exist.
  console.info(
    `[findback] sourcemaps ${sourcemap ? "ENABLED (hidden, for Sentry upload then strip)" : "DISABLED (local build: no .map files emitted)"}`,
  );
  return {
    plugins: [react(), tailwindcss()],
    // Vitest only (ignored by `vite build`). Full-suite worker load can push
    // the async photo/publish flows used by the CreateReport suites past
    // vitest's 5s default test timeout (the suite's own explicit gates already
    // allow 5s for the same reason), which flaked CI and the release gate.
    // Raise the ceiling and give testing-library queries matching headroom
    // rather than weakening any assertion.
    test: {
      testTimeout: 20_000,
      hookTimeout: 20_000,
      setupFiles: ["./src/test-setup.ts"],
      // Vendored upstream sources (llama.cpp, needle engines) ship their own
      // web/UI tests for reference; they are not part of this workspace's
      // suite and their frameworks are not installed here.
      exclude: ["**/node_modules/**", "**/dist/**", "android/app/src/main/cpp/third_party/**"],
    },
    server: {
      port: 5173,
      host: true,
    },
    build: {
      // S3: sourcemaps exist ONLY to be uploaded to Sentry, then stripped.
      // Local builds (no opt-in) emit no maps at all: nothing to leak or
      // package. The release job sets SENTRY_UPLOAD_SOURCEMAPS=true, uploads
      // with SENTRY_AUTH_TOKEN (a CI secret — never a VITE_* variable), and
      // deletes every *.map before Capacitor sync (verified by a workflow step).
      // `hidden` omits the sourceMappingURL comment so that even a failed strip
      // can never leave the shipped bundle pointing at map files.
      sourcemap,
    },
    define: {
      "import.meta.env.VITE_PUBLIC_SHARE_ORIGIN": JSON.stringify(shareOrigin),
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(publishableKey),
    },
  };
});
