import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSupabaseBuildEnv } from "../vite.config";

let envDir = "";

afterEach(async () => {
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
