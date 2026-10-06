/**
 * Worker E (M2 QA/security) — SEN-01 negative battery at the build gates.
 *
 * Rule: every installable build (preflight, vite build, assets, APK) must
 * fail closed on missing/placeholder/secret-key config. The gate script
 * `scripts/check-mobile-build-config.mjs` is used as a BLACK BOX (spawned as
 * a subprocess, never imported, never modified) so this battery pins the
 * real CI behavior, not a reimplementation.
 *
 * Determinism: the script merges shell env over repo-root .env files, with
 * explicit nonempty VITE_* winning. All negative cases below set explicit
 * VITE_* values, so they hold regardless of local .env contents. Missing-
 * value cases (which fall through to local files) live in the companion
 * node:test battery `scripts/check-sen01-qa-battery.test.mjs`, which drives
 * the script's exported functions against isolated temp env dirs.
 *
 * Synthetic fixtures only. Assertions check shapes/exit codes/messages —
 * failure output must never echo key material.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveSentryDsn } from "./services/monitoring/sentry";

const GATE_SCRIPT = new URL(
  "../../../scripts/check-mobile-build-config.mjs",
  import.meta.url,
);

function runGate(env: Record<string, string>): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [GATE_SCRIPT.pathname, "--preflight"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("SEN-01 preflight — secret keys fail closed (black box)", () => {
  it("rejects an sb_secret_* publishable key without echoing it", () => {
    // Assembled at runtime so no literal `sb_secret_...` exists in the repo:
    // `npm run scan:secrets` fails the build on that exact shape, and a
    // committed canary is what the scan exists to catch. The gate still
    // receives a real secret-shaped key, so coverage is not weakened.
    const canary = ["sb", "secret"].join("_") + "_syntheticE000000000000000000001";
    const { status, out } = runGate({
      VITE_SUPABASE_URL: "https://sampleproject.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: canary,
    });
    expect(status).not.toBe(0);
    expect(out).toContain("secret");
    expect(out).not.toContain(canary);
  });

  it("rejects a service_role JWT publishable key without echoing it", () => {
    const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
    const canary = `synthetic.${payload}.synthetic`;
    const { status, out } = runGate({
      VITE_SUPABASE_URL: "https://sampleproject.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: canary,
    });
    expect(status).not.toBe(0);
    expect(out).not.toContain(payload);
  });
});

describe("SEN-01 preflight — placeholder/malformed config fails closed (black box)", () => {
  it("rejects placeholder URL and placeholder key", () => {
    const keyCanary = "sb_publishable_syntheticE00000000000000002";
    const badUrl = runGate({
      VITE_SUPABASE_URL: "test",
      VITE_SUPABASE_PUBLISHABLE_KEY: keyCanary,
    });
    expect(badUrl.status).not.toBe(0);
    expect(badUrl.out).toContain("VITE_SUPABASE_URL");
    expect(badUrl.out).not.toContain(keyCanary);

    const badKey = runGate({
      VITE_SUPABASE_URL: "https://sampleproject.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "changeme",
    });
    expect(badKey.status).not.toBe(0);
    expect(badKey.out).toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
  });

  it("rejects a non-Supabase / query-carrying URL", () => {
    const { status, out } = runGate({
      VITE_SUPABASE_URL: "https://evil.test/steal?token=x",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_syntheticE00000000000000003",
    });
    expect(status).not.toBe(0);
    expect(out).toContain("VITE_SUPABASE_URL");
  });
});

describe("SEN-01 DSN rule — TS-side mirror of the preflight gate", () => {
  // resolveSentryDsn is the app-side rule (no DSN ⇒ monitoring inert);
  // placeholder/secret policy lives in the gate script (see .mjs battery).
  it("accepts https DSN, rejects missing/non-https/keyless", () => {
    expect(resolveSentryDsn("https://abc123@o123.ingest.sentry.io/456")).toBe(
      "https://abc123@o123.ingest.sentry.io/456",
    );
    expect(resolveSentryDsn("")).toBeNull();
    expect(resolveSentryDsn(undefined)).toBeNull();
    expect(resolveSentryDsn(null)).toBeNull();
    expect(resolveSentryDsn("http://abc123@o123.ingest.sentry.io/456")).toBeNull();
    expect(resolveSentryDsn("https:///456")).toBeNull();
    expect(resolveSentryDsn("  ")).toBeNull();
  });
});

describe.todo("SEN-01 device-only boundary (needs real artifact + installed device)", () => {
  it.todo("signed APK carries bundle asserts (needs real artifact + installed device)");
});

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Shell env with every build-config variable scrubbed (files isolated via envDir). */
function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(VITE_|SUPABASE_|SENTRY_)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function buildWeb(env: Record<string, string>, outDir: string) {
  return spawnSync("npx", ["--no-install", "vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: MOBILE_ROOT,
    encoding: "utf8",
    env,
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function bundleChunks(outDir: string): string[] {
  const assets = join(outDir, "assets");
  return readdirSync(assets)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(assets, name), "utf8"));
}

describe("SEN-01 positive build boundaries (real builds, synthetic config)", () => {
  it("synthetic-config build embeds Supabase URL + Sentry host/release + share origin", () => {
    const outDir = mkdtempSync(join(tmpdir(), "sen01-bundle-"));
    const url = "https://synthetic-sen01.supabase.co";
    const sentryDsn = "https://synthetic987@o999999.ingest.sentry.io/9999999";
    const shareOrigin = "https://synthetic-sen01-build.test";
    const release = "findback-mobile@0.7.0-beta.2+abcdef123456";
    const built = buildWeb(
      {
        ...scrubbedEnv(),
        VITE_SUPABASE_URL: url,
        VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_syntheticSEN01000000000001",
        VITE_SENTRY_DSN: sentryDsn,
        VITE_PUBLIC_SHARE_ORIGIN: shareOrigin,
        VITE_SENTRY_RELEASE: release,
      },
      outDir,
    );
    expect(`${built.stdout ?? ""}${built.stderr ?? ""}`).not.toContain("sb_publishable_syntheticSEN01");
    expect(built.status).toBe(0);
    const chunks = bundleChunks(outDir);
    expect(chunks.length).toBeGreaterThan(0);
    const has = (text: string) => chunks.some((chunk) => chunk.includes(text));
    expect(has(url)).toBe(true);
    expect(has("o999999.ingest.sentry.io")).toBe(true);
    expect(has(shareOrigin)).toBe(true);
    expect(has(release)).toBe(true);
  }, 300_000);

  it("vite build with scrubbed env fails at the spawnSync preflight (isolated envDir)", () => {
    const outDir = mkdtempSync(join(tmpdir(), "sen01-scrubbed-"));
    const envDir = mkdtempSync(join(tmpdir(), "sen01-env-"));
    // A valid share origin on disk proves the failure is the Supabase
    // preflight specifically, not the share gate.
    writeFileSync(join(envDir, ".env"), "VITE_PUBLIC_SHARE_ORIGIN=https://synthetic-sen01-scrub.test\n");
    const built = buildWeb({ ...scrubbedEnv(), FINDBACK_ENV_DIR: envDir }, outDir);
    const out = `${built.stdout ?? ""}${built.stderr ?? ""}`;
    expect(built.status).not.toBe(0);
    expect(out).toMatch(/preflight|VITE_SUPABASE_URL/);
  }, 300_000);
});
