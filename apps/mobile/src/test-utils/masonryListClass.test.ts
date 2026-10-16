// @vitest-environment node
import { describe, expect, it } from "vitest";
import { masonryListPaddingRem, resolveMasonryPaddingRem } from "./masonryListClass";

/**
 * The gutter readers are the evidence two other checks lean on (the column-floor
 * sweep and the fixture captions), so their own discrimination is pinned here.
 * The promise is specific — "the arm the lane really takes, or a throw" — and
 * each case below is a shape that could otherwise make them lie by silently
 * resolving the fallback.
 */

/** A well-formed chain with an optional extra arm, so each case varies one thing. */
function chain(extraArm?: string, fallback = '"flex flex-col gap-3 px-4"') {
  return [
    "  const listClass =",
    '    density === "compact"',
    '      ? "flex flex-col gap-2 px-3"',
    ...(extraArm ? [extraArm] : []),
    '      : density === "home-feed"',
    '        ? "flex flex-col gap-3 px-4"',
    "        : " + fallback + ";",
    "",
  ].join("\n");
}

describe("masonry list gutter readers", () => {
  it("reads the masonry lane's own arm, not the fallback", () => {
    const withMasonryArm = chain(
      '      : density === "masonry"\n        ? "flex flex-col gap-3 px-6"',
    );
    expect(resolveMasonryPaddingRem(withMasonryArm)).toBe(1.5);
  });

  it("falls back to the final arm when masonry has no arm of its own", () => {
    // The product today: masonry is served by the final `else`.
    expect(masonryListPaddingRem()).toBe(1);
    expect(resolveMasonryPaddingRem(chain())).toBe(1);
  });

  it("throws when an arm is guarded by a variable instead of a lane test", () => {
    // `isMasonry` already exists in `PostList`, so this is the shape a future
    // edit is most likely to take. Collecting it as a bare arm keeps the arm
    // count balanced and quietly answers with the fallback.
    const variableGuarded = chain(
      '      : isMasonry\n        ? "flex flex-col gap-3 px-6"',
    );
    expect(() => resolveMasonryPaddingRem(variableGuarded)).toThrow(
      /guarded by something this guard cannot read/,
    );
  });

  it("throws when a guard or its value is not the quoted shape it reads", () => {
    const singleQuoted = chain("      : density === 'masonry'\n        ? 'flex px-6'");
    expect(() => resolveMasonryPaddingRem(singleQuoted)).toThrow(
      /guarded by something this guard cannot read/,
    );

    // Extra spaces around the comparison are legal TypeScript and invisible to a
    // literal-spacing regex.
    const reSpaced = chain('      : density  ===  "masonry"\n        ? "flex px-6"');
    expect(() => resolveMasonryPaddingRem(reSpaced)).toThrow(
      /guarded by something this guard cannot read/,
    );
  });

  it("throws when a value is not a plain literal", () => {
    // The fallback as a shared constant: every guard is readable, but one arm's
    // value is not a literal, so the chain has fewer arms than ternaries.
    expect(() => resolveMasonryPaddingRem(chain(undefined, "DEFAULT_LIST_CLASS"))).toThrow(
      /not a plain string literal/,
    );

    // A literal that starts a larger expression — half a class is not the class.
    const concatenated = chain('      : density === "masonry"\n        ? "flex px-6" + extra');
    expect(() => resolveMasonryPaddingRem(concatenated)).toThrow(
      /part of a larger expression/,
    );
  });

  it("throws when a guard's own value is not a quoted literal", () => {
    const sharedConstant = chain('      : density === "masonry"\n        ? MASONRY_LIST_CLASS');
    expect(() => resolveMasonryPaddingRem(sharedConstant)).toThrow(
      /guarded by something this guard cannot read/,
    );

    const templateLiteral = chain('      : density === "masonry"\n        ? `flex px-6`');
    expect(() => resolveMasonryPaddingRem(templateLiteral)).toThrow(
      /guarded by something this guard cannot read/,
    );
  });

  it("refuses a declaration it cannot read instead of grading the fallback", () => {
    // No `listClass` at all — and the multiplicity rule is what reports it.
    expect(() => resolveMasonryPaddingRem("const other = 1;\n")).toThrow(
      /exactly one listClass declaration/,
    );
    // A declaration with no statement terminator is not the declaration.
    expect(() =>
      resolveMasonryPaddingRem('  const listClass = density === "compact" ? "flex px-3" : "flex px-4";'),
    ).toThrow(/no listClass declaration found/);
    expect(() =>
      resolveMasonryPaddingRem(
        '  const listClass = density === "compact" ? "flex px-3" : "flex flex-col gap-3";\n',
      ),
    ).toThrow(/no px-\* gutter/);
    expect(() =>
      resolveMasonryPaddingRem(chain(undefined, '"flex flex-col gap-3 px-4"')),
    ).not.toThrow();
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

  it("refuses a source with more than one listClass declaration", () => {
    // A sibling component above `PostList` (a skeleton, a preview) with its own
    // `listClass` would be read in the lane's place: the reader would answer with
    // that chain's gutter while the lane renders another one.
    const sibling = [chain(), "  const listClass =", '    density === "masonry" ? "flex px-6" : "flex px-4";', ""].join(
      "\n",
    );
    expect(() => resolveMasonryPaddingRem(sibling)).toThrow(
      /exactly one listClass declaration/,
    );
  });

  it("stops at the declaration's own semicolon, however it is commented", () => {
    // A naive `;\n` terminator runs past a trailing comment into the NEXT
    // statement, and then the answer can come from a class the masonry lane
    // never renders — here the toolbar's `px-9`.
    const build = (comment: string) =>
      [
        chain(
          '      : density === "masonry"\n        ? "flex flex-col gap-3 px-6"',
          '"flex flex-col gap-3 px-4"',
        ).trimEnd() + comment,
        "  const toolbarClass =",
        '    density === "compact" ? "flex gap-1 px-9" : "flex gap-1 px-1";',
        "",
      ].join("\n");
    // The comment trails the declaration's own `;`, which is exactly the shape a
    // `;` + newline terminator reads past.
    expect(resolveMasonryPaddingRem(build(" // masonry takes the fallback arm"))).toBe(1.5);
    expect(resolveMasonryPaddingRem(build(" /* masonry takes the fallback arm */"))).toBe(1.5);
  });
});
