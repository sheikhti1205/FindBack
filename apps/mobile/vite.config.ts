import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

// Supabase Auth/Data/Realtime/Storage/Functions are called directly from the
// app with the publishable key only. The secret key must never reach the mobile
// bundle. No API base URL is needed.
export function resolveSupabaseBuildEnv(
  mode: string,
  envDir = resolve(import.meta.dirname, "../.."),
) {
  const env = loadEnv(mode, envDir, "VITE_");
  return {
    publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
    url: env.VITE_SUPABASE_URL ?? "",
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

export default defineConfig(({ mode }) => {
  const { publishableKey, url } = resolveSupabaseBuildEnv(mode);
  const sourcemap = resolveSourcemapMode(process.env);
  // Explicit local behavior (S3): say which mode we are in so a missing upload
  // token can never be mistaken for an upload — maps simply do not exist.
  console.info(
    `[findback] sourcemaps ${sourcemap ? "ENABLED (hidden, for Sentry upload then strip)" : "DISABLED (local build: no .map files emitted)"}`,
  );
  return {
    plugins: [react(), tailwindcss()],
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
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_PUBLISHABLE_KEY__: JSON.stringify(publishableKey),
    },
  };
});
