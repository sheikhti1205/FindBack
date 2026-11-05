// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static geometry contract for the Settings root.
 *
 * jsdom has no layout engine, so these assertions cannot measure a rendered
 * box. What they can do — and what the S5 defect actually was — is pin the
 * layout rules that decide clipping: the row grid must give a switch its own
 * trailing column instead of the 18px chevron column, and a row must not hide
 * overflow to make a broken grid look fine. Rendered widths at 320dp and large
 * text remain a browser/device acceptance item.
 */
const screenCss = readFileSync(new URL("./Settings.css", import.meta.url), "utf8");
const primitiveCss = readFileSync(new URL("../components/settings/settings.css", import.meta.url), "utf8");
const splitCss = readFileSync(new URL("../components/adaptiveFoundation.css", import.meta.url), "utf8");

describe("Settings row geometry", () => {
  it("keeps distinct trailing layouts for a chevron and a switch", () => {
    expect(screenCss).toMatch(/\.fb-settings-root \.fb-settings-row \{[^}]*grid-template-columns:28px minmax\(0,1fr\) auto/);
    expect(screenCss).toMatch(/\.fb-settings-root \.fb-settings-chevron \{[^}]*grid-column:3/);
    expect(screenCss).toMatch(/\.fb-settings-root \.fb-switch-track \{[^}]*grid-column:3/);
    // The old grid pinned the third column to the chevron's 18px, which clipped
    // the 44px track. That value must not come back.
    expect(screenCss).not.toMatch(/\.fb-settings-root \.fb-settings-row \{[^}]*minmax\(0,1fr\) 18px/);
  });

  it("keeps the switch at a full control width and height", () => {
    expect(primitiveCss).toMatch(/\.fb-switch-track \{[^}]*width: 44px/);
    expect(primitiveCss).toMatch(/\.fb-switch-track \{[^}]*height: 26px/);
  });

  it("never hides row overflow to mask clipping", () => {
    const rowRules = [...primitiveCss.matchAll(/\.fb-settings-row[^{]*\{([^}]*)\}/g)]
      .map((match) => match[1] ?? "")
      .join("\n");
    expect(rowRules).not.toMatch(/overflow\s*:\s*hidden/);
    expect(screenCss).not.toMatch(/\.fb-settings-root \.fb-settings-row[^{]*\{[^}]*overflow\s*:\s*hidden/);
  });

  it("lets a split fall back to one pane when the detail side would be unusable", () => {
    // The split CSS still asks for a readable list column; the collapse decision
    // itself is in SplitView.tsx and is unit-tested there.
    expect(splitCss).toMatch(/\.fb-split-wide \{[^}]*minmax\(16rem, 22rem\)/);
    expect(splitCss).toMatch(/\.fb-split-list, \.fb-split-detail \{[^}]*min-width:\s*0/);
  });
});
