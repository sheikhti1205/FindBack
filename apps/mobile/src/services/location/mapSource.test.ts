import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAP_SOURCE,
  OPENFREEMAP_STYLE_BRIGHT,
  OPENFREEMAP_STYLE_POSITRON,
  resolveMapSource,
} from "./mapSource";

describe("mapSource tile config seam", () => {
  it("defaults to the OpenFreeMap public instance behind the seam", () => {
    expect(DEFAULT_MAP_SOURCE.styleUrl).toMatch(/^https:\/\/tiles\.openfreemap\.org\//);
    expect(DEFAULT_MAP_SOURCE.name.trim()).not.toBe("");
    expect(DEFAULT_MAP_SOURCE.attribution).toContain("OpenStreetMap");
  });

  it("resolves to the default with no override", () => {
    expect(resolveMapSource()).toEqual(DEFAULT_MAP_SOURCE);
  });

  it("lets an explicit override replace the endpoint without code changes", () => {
    const resolved = resolveMapSource({
      styleUrl: "https://tiles.example.com/style.json",
      name: "Self-hosted",
      attribution: "© OpenStreetMap contributors",
    });
    expect(resolved.styleUrl).toBe("https://tiles.example.com/style.json");
    expect(resolved.name).toBe("Self-hosted");
    expect(resolved.attribution).toBe("© OpenStreetMap contributors");
  });

  it("advertises alternate OpenFreeMap styles as overrides", () => {
    for (const styleUrl of [OPENFREEMAP_STYLE_BRIGHT, OPENFREEMAP_STYLE_POSITRON]) {
      expect(resolveMapSource({ styleUrl }).styleUrl).toBe(styleUrl);
    }
  });

  it("never mutates the default", () => {
    const before = { ...DEFAULT_MAP_SOURCE };
    resolveMapSource({ styleUrl: "https://tiles.example.com/other.json" });
    expect(DEFAULT_MAP_SOURCE).toEqual(before);
  });
});
