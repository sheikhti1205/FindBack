import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("one product palette value owner", () => {
  it("has a canonical color system, not independent accent/functional/CSS palettes", () => {
    expect(existsSync("src/design/colorSystem.ts")).toBe(true);
    for (const path of ["src/appearance.ts", "src/design/functionalColors.ts"]) {
      const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code, path).not.toMatch(/#[0-9a-f]{6}\b/i);
    }
    const css = readFileSync("src/index.css", "utf8");
    expect(css).not.toMatch(/--fb-(?:surface|lost-bg|primary)\s*:\s*#[0-9a-f]/i);
    expect(css).not.toMatch(/:root:not\(\.light\):not\(\.amoled\)/);
  });
});
