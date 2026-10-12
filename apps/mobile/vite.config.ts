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
  // FINDBACK_ENV_DIR isolates the env-file root for hermetic tests (CI-local
  // .env files must never satisfy a test that asserts scrubbed-env failure).
  // Production/CI never set it, so the repo root stays the single live root.
  envDir = process.env.FINDBACK_ENV_DIR || resolve(import.meta.dirname, "../.."),
) {
  const env = loadEnv(mode, envDir, "");
  return {
    publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || env.SUPABASE_PUBLISHABLE_KEY || "",
    url: env.VITE_SUPABASE_URL?.trim() || env.SUPABASE_URL || "",
  };
}

// FBX-027 maps-config region (keyless MAP pivot): the single build-time source
// for map provider config is the repo-root env, owned by
// scripts/check-map-config.mjs. This resolver mirrors the owner's names and
// defaults so the web bundle receives the SAME effective values the native
// side compiles into BuildConfig (MAP_STYLE_URL / MAP_SEARCH_CONTACT) —
// absent custom values resolve to the owner-decided defaults on both sides,
// never a silent divergence. The Nominatim search-endpoint override is passed
// through from the same root env; it is consumed today by
// src/services/location/nominatimSearch.ts, while the style/contact defines
// are the build-time contract the map lane adopts at runtime.
export const DEFAULT_MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
export const DEFAULT_MAP_CONTACT = "https://findbackapp.social";

export function resolveMapBuildEnv(
  mode: string,
  // Same FINDBACK_ENV_DIR hermeticity rule as resolveSupabaseBuildEnv above.
  envDir = process.env.FINDBACK_ENV_DIR || resolve(import.meta.dirname, "../.."),
) {
  const env = loadEnv(mode, envDir, "");
  const style = env.FINDBACK_MAP_STYLE_URL?.trim() || "";
  const contact = env.FINDBACK_MAP_CONTACT?.trim() || "";
  return {
    styleUrl: style || DEFAULT_MAP_STYLE_URL,
    contact: contact || DEFAULT_MAP_CONTACT,
    styleSource: (style ? "custom" : "default") as "custom" | "default",
    contactSource: (contact ? "custom" : "default") as "custom" | "default",
    nominatimSearchUrl: env.VITE_NOMINATIM_SEARCH_URL?.trim() || "",
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
  const shareOrigin = loadEnv(mode, process.env.FINDBACK_ENV_DIR || resolve(import.meta.dirname, "../.."), "").VITE_PUBLIC_SHARE_ORIGIN?.trim() || "";
  const mapEnv = resolveMapBuildEnv(mode);
  if (command === "build") {
    // FBX-027 maps truth: the node owner validates the effective map config
    // (malformed custom values fail closed). Running it here means a direct
    // `vite build` can never bake a web map truth that disagrees with the
    // native BuildConfig truth — the same check the signeddev Gradle path
    // runs through verifySigneddevConfig. Logs carry presence only.
    const mapCheck = spawnSync(process.execPath,
      [resolve(import.meta.dirname, "../../scripts/check-map-config.mjs")],
      { stdio: "inherit", env: process.env });
    if (mapCheck.status !== 0) throw new Error("Map build configuration check failed");
  }
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
      "import.meta.env.VITE_MAP_STYLE_URL": JSON.stringify(mapEnv.styleUrl),
      "import.meta.env.VITE_MAP_SEARCH_CONTACT": JSON.stringify(mapEnv.contact),
      "import.meta.env.VITE_NOMINATIM_SEARCH_URL": JSON.stringify(mapEnv.nominatimSearchUrl),
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(publishableKey),
    },
  };
});
