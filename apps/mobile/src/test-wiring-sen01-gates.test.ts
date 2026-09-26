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
    const canary = "sb_secret_syntheticE000000000000000000001";
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

describe.todo("SEN-01 positive + device boundaries (owner/CI-gated, NOT TESTED here)", () => {
  it.todo("synthetic-DSN build embeds Supabase URL/key + Sentry host + SENTRY_RELEASE");
  it.todo("vite build with scrubbed env fails at the spawnSync preflight (needs isolated envDir)");
  it.todo("Gradle verifyBundledClientConfig fails packaging on stale assets");
  it.todo("signed APK carries bundle asserts (needs real artifact + installed device)");
});
