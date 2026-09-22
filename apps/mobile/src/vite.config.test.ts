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
});
