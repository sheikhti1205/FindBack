// @vitest-environment node
import { describe, expect, it } from "vitest";
import { masonryListPaddingRem, resolveMasonryPaddingRem } from "./masonryListClass";

/**
 * The gutter readers are the evidence two other checks lean on (the column-floor
 * sweep and the fixture captions), so their own discrimination is pinned here:
 * a reader that silently grades the fallback would make both of them lie.
 */
describe("masonry list gutter readers", () => {
  it("reads the masonry lane's own arm, not the fallback", () => {
    const withMasonryArm = [
      "  const listClass =",
      '    density === "compact"',
      '      ? "flex flex-col gap-2 px-3"',
      '      : density === "masonry"',
      '        ? "flex flex-col gap-3 px-6"',
      '        : "flex flex-col gap-3 px-4";',
      "",
    ].join("\n");
    expect(resolveMasonryPaddingRem(withMasonryArm)).toBe(1.5);
  });

  it("falls back to the final arm when masonry has no arm of its own", () => {
    // The product today: masonry is served by the final `else`.
    expect(masonryListPaddingRem()).toBe(1);
  });

  it("refuses a listClass shape it cannot read instead of grading the fallback", () => {
    const notAPlainLiteral = [
      "  const listClass =",
      '    density === "compact"',
      "      ? COMPACT_LIST_CLASS",
      '      : "flex flex-col gap-3 px-4";',
      "",
    ].join("\n");
    expect(() => resolveMasonryPaddingRem(notAPlainLiteral)).toThrow(
      /arm is not a plain string literal/,
    );
    expect(() => resolveMasonryPaddingRem("const other = 1;\n")).toThrow(
      /no listClass declaration/,
    );
    expect(() =>
      resolveMasonryPaddingRem(
        '  const listClass = density === "compact" ? "flex px-3" : "flex flex-col gap-3";\n',
      ),
    ).toThrow(/no px-\* gutter/);
  });

  it("refuses the same density twice", () => {
    const duplicated = [
      "  const listClass =",
      '    density === "masonry" ? "flex flex-col gap-3 px-4"',
      '      : density === "masonry" ? "flex flex-col gap-3 px-6"',
      '      : "flex flex-col gap-3 px-4";',
      "",
    ].join("\n");
    expect(() => resolveMasonryPaddingRem(duplicated)).toThrow(/names the same density twice/);
  });
});
