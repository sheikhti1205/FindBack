import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAP_CONTACT, DEFAULT_MAP_STYLE_URL, DEFAULT_NOMINATIM_SEARCH_URL, resolveMapBuildEnv } from "../vite.config";

let envDir = "";

// loadEnv merges process.env, so scrub the owner keys per test for hermeticity.
const ENV_KEYS = [
  "FINDBACK_MAP_STYLE_URL",
  "FINDBACK_MAP_CONTACT",
  "VITE_NOMINATIM_SEARCH_URL",
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

describe("resolveMapBuildEnv", () => {
  it("resolves the owner-decided defaults when no custom map config exists", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-map-"));
    await writeFile(join(envDir, ".env.production"), "# no map overrides\n");
    expect(resolveMapBuildEnv("production", envDir)).toEqual({
      styleUrl: DEFAULT_MAP_STYLE_URL,
      contact: DEFAULT_MAP_CONTACT,
      styleSource: "default",
      contactSource: "default",
      nominatimSearchUrl: DEFAULT_NOMINATIM_SEARCH_URL,
      searchSource: "default",
    });
  });

  it("passes custom root-env map config to both the map and search sides", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-map-"));
    await writeFile(
      join(envDir, ".env.production"),
      "FINDBACK_MAP_STYLE_URL=https://tiles.provider.net/styles/bright\n" +
        "FINDBACK_MAP_CONTACT=https://contact.provider.net\n" +
        "VITE_NOMINATIM_SEARCH_URL=https://proxy.provider.net/search\n",
    );
    expect(resolveMapBuildEnv("production", envDir)).toEqual({
      styleUrl: "https://tiles.provider.net/styles/bright",
      contact: "https://contact.provider.net",
      styleSource: "custom",
      contactSource: "custom",
      nominatimSearchUrl: "https://proxy.provider.net/search",
      searchSource: "custom",
    });
  });

  it("treats blank overrides as absent (defaults win)", async () => {
    envDir = await mkdtemp(join(tmpdir(), "findback-vite-map-"));
    await writeFile(
      join(envDir, ".env.production"),
      "FINDBACK_MAP_STYLE_URL=\nFINDBACK_MAP_CONTACT=   \n",
    );
    const resolved = resolveMapBuildEnv("production", envDir);
    expect(resolved.styleUrl).toBe(DEFAULT_MAP_STYLE_URL);
    expect(resolved.contact).toBe(DEFAULT_MAP_CONTACT);
    expect(resolved.styleSource).toBe("default");
    expect(resolved.contactSource).toBe("default");
    expect(resolved.nominatimSearchUrl).toBe(DEFAULT_NOMINATIM_SEARCH_URL);
    expect(resolved.searchSource).toBe("default");
  });

  it("keeps the owner defaults in sync with the documented single source", () => {
    expect(DEFAULT_MAP_STYLE_URL).toBe("https://tiles.openfreemap.org/styles/liberty");
    expect(DEFAULT_MAP_CONTACT).toBe("https://findbackapp.social");
    expect(DEFAULT_NOMINATIM_SEARCH_URL).toBe("https://nominatim.openstreetmap.org/search");
  });
});
