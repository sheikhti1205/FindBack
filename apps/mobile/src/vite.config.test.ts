import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGoogleMapsBuildKey, resolveSupabaseBuildEnv } from "../vite.config";

let envDir = "";

// `loadEnv(mode, dir, "")` merges process.env, so a caller that exports
// VITE_* (the release gate does, at job level) would otherwise leak
// into these file-precedence assertions. Isolate the keys per test so the
// suite is hermetic regardless of ambient environment.
const ENV_KEYS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "VITE_GOOGLE_MAPS_API_KEY",
  "GOOGLE_MAPS_API_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (envDir) await rm(envDir, { force: true, recursive: true });
  envDir = "";
});

describe("resolveSupabaseBuildEnv", () => {
  it("derives the public build values from the canonical root Supabase env", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-env-"));
    await writeFile(join(envDir, ".env.production"),
      "SUPABASE_URL=https://canonical.supabase.co\nSUPABASE_PUBLISHABLE_KEY=sb_publishable_canonical\nVITE_SUPABASE_URL=\nVITE_SUPABASE_PUBLISHABLE_KEY=\n");
    expect(resolveSupabaseBuildEnv("production", envDir)).toEqual({
      url: "https://canonical.supabase.co", publishableKey: "sb_publishable_canonical",
    });
  });
  it("loads public Supabase values from the production env file", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-env-"));
    await writeFile(
      join(envDir, ".env.production"),
      "VITE_SUPABASE_URL=https://example.supabase.co\nVITE_SUPABASE_PUBLISHABLE_KEY=public-test-key\n",
    );

    expect(resolveSupabaseBuildEnv("production", envDir)).toEqual({
      publishableKey: "public-test-key",
      url: "https://example.supabase.co",
    });
  });

  it("honors exported process.env values when no env file provides them", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-env-"));
    const prevUrl = process.env.VITE_SUPABASE_URL;
    const prevKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    process.env.VITE_SUPABASE_URL = "https://env-shell.supabase.co";
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "shell-test-key";
    try {
      expect(resolveSupabaseBuildEnv("production", envDir)).toEqual({
        publishableKey: "shell-test-key",
        url: "https://env-shell.supabase.co",
      });
    } finally {
      if (prevUrl === undefined) delete process.env.VITE_SUPABASE_URL;
      else process.env.VITE_SUPABASE_URL = prevUrl;
      if (prevKey === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = prevKey;
    }
  });
});

describe("resolveGoogleMapsBuildKey", () => {
  it("derives the client key from the canonical GOOGLE_MAPS_API_KEY", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-env-"));
    await writeFile(join(envDir, ".env.production"),
      "GOOGLE_MAPS_API_KEY=test-maps-key\nVITE_GOOGLE_MAPS_API_KEY=\n");
    expect(resolveGoogleMapsBuildKey("production", envDir)).toBe("test-maps-key");
  });

  it("prefers an explicit VITE_GOOGLE_MAPS_API_KEY over the canonical name", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-env-"));
    await writeFile(join(envDir, ".env.production"),
      "GOOGLE_MAPS_API_KEY=canonical-key\nVITE_GOOGLE_MAPS_API_KEY=vite-key\n");
    expect(resolveGoogleMapsBuildKey("production", envDir)).toBe("vite-key");
  });

  it("resolves empty when no key is provided (fail-closed at runtime, never a build failure)", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-env-"));
    expect(resolveGoogleMapsBuildKey("production", envDir)).toBe("");
  });
});
