#!/usr/bin/env node
/** Configured host proof only: no packaging, signing, upload, or device access. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveSupabaseConfig } from "./check-mobile-build-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The coordinator owns this shared lock, including its owner metadata and
// release. This worktree-scoped helper must not create/delete control files
// outside the worktree or treat a local lock as cross-worktree exclusion.
const canonicalLock = "/mnt/c/Users/sheik/My Drive/FindBack-internal/00_CONTROL/locks/heavy.lock";
if (process.env.FINDBACK_HEAVY_LOCK_HELD !== "1" || !existsSync(canonicalLock) || !statSync(canonicalLock).isDirectory()) {
  throw new Error("Coordinator-held canonical heavy lock required (FINDBACK_HEAVY_LOCK_HELD=1). No build started.");
}
const mode = process.argv[2];
if (!["--web", "--native"].includes(mode)) throw new Error("Expected --web or --native");
const config = effectiveSupabaseConfig();
const env = { ...process.env, VITE_SUPABASE_URL: config.url, VITE_SUPABASE_PUBLISHABLE_KEY: config.key,
  JAVA_HOME: "/usr/lib/jvm/java-21-openjdk-amd64", ANDROID_HOME: "/home/sheikh/android-sdk", ANDROID_SDK_ROOT: "/home/sheikh/android-sdk", FINDBACK_SENTRY_UPLOAD: "false" };
if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_PUBLISHABLE_KEY.startsWith("sb_secret_")) throw new Error("Missing public build configuration");
const lock = resolve(root, "apps/mobile/android/.ai-host-heavy.lock");
mkdirSync(lock); // Also refuse two helper invocations under one supervisor lock.
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`Host verification failed: ${executable} (${result.status ?? "spawn"})`);
}
try {
  run("node", ["scripts/check-model-notices.mjs"]);
  if (mode === "--web") {
    run("npm", ["run", "build", "-w", "apps/mobile"]);
    run("node", ["scripts/check-release-config.mjs"]);
    run("node", ["scripts/check-mobile-build-config.mjs", "--assets", "apps/mobile/dist/assets"]);
  } else if (mode === "--native") {
    for (const input of ["third_party/needle/arm64-v8a/libneedle.a", "third_party/needle/arm64-v8a/needle.h", "third_party/llama.cpp/CMakeLists.txt"]) {
      if (!existsSync(resolve(root, "apps/mobile/android/app/src/main/cpp", input))) throw new Error("Required pinned native build input missing; refusing a skipped-runtime success.");
    }
    run("./gradlew", [":app:compileDebugKotlin", ":app:externalNativeBuildDebug", ":app:testDebugUnitTest", "--no-daemon", "--max-workers=2", "-Pandroid.injected.build.abi=arm64-v8a", "-x", "fetchNeedleEngine", "-x", "fetchLlamaCpp", "-x", "fetchUseModel"], resolve(root, "apps/mobile/android"));
    run("./gradlew", [":app:dependencyInsight", "--dependency", "litertlm-android", "--configuration", "debugRuntimeClasspath", "--no-daemon", "--max-workers=2"], resolve(root, "apps/mobile/android"));
    run("./gradlew", [":app:dependencyInsight", "--dependency", "kotlinx-coroutines-android", "--configuration", "debugRuntimeClasspath", "--no-daemon", "--max-workers=2"], resolve(root, "apps/mobile/android"));
  }
} finally { rmdirSync(lock); }
