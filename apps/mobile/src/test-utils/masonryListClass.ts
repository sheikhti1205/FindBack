import { readFileSync } from "node:fs";

/**
 * The masonry list's own horizontal padding, in `rem`, read from the component
 * that applies it (`PostList`'s `listClass`).
 *
 * Read, not assumed: a check that hardcodes the same `px-4` the product applies
 * cannot notice the product changing it. Two surfaces need this number — the
 * column-floor sweep in `responsive.test.ts` and the fixture caption check in
 * `fixture.test.tsx` — so it lives here rather than being re-derived twice.
 *
 * Every arm is read, `?`-armed ones included. An earlier `:`-only extractor could
 * not see a `?` branch, so adding `density === "masonry" ? "…px-6"` left the
 * floor sweep green while the lane rendered a gutter 8px wider per side than the
 * maths assumed.
 *
 * The reader is only as good as its promise ("reads the arm the lane really
 * takes, or throws"), and that promise is enforced by three invariants rather
 * than by hoping the chain keeps its shape:
 *
 * 1. the declaration ends at the `;` that terminates the statement (a trailing
 *    comment is tolerated; a naive `;\n` terminator swallows the NEXT statement
 *    and can report that statement's class as this lane's);
 * 2. every `?` in the declaration is an arm, and every arm carries a
 *    `density === "<lane>"` guard this reader can see — so an arm guarded by a
 *    variable (`isMasonry ? "…"`), a re-spaced comparison, or a helper throws
 *    instead of being collected as a bare arm and silently grading the fallback;
 * 3. every arm's value is a plain string literal, and there is exactly one
 *    unguarded arm (the fallback).
 *
 * Violations throw. A guard that answers with a number it did not verify is
 * worse than no guard: it launders an unchecked assumption as evidence.
 *
 * Pure over its source text, so its own discrimination is tested with synthetic
 * `listClass` declarations rather than only against the product.
 */
export function resolveMasonryPaddingRem(source: string): number {
  // One declaration, and it has to be the lane's own. A file with a second
  // `listClass` above this one (a skeleton, a preview) would otherwise be read in
  // the lane's place — the reader would answer with whatever that chain resolves
  // to while the lane renders a different gutter.
  if ([...source.matchAll(/const listClass =/g)].length !== 1) {
    throw new Error("expected exactly one listClass declaration in the source");
  }
  const declaration =
    /const listClass =([\s\S]*?);(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))?\s*\n/.exec(source)?.[1];
  if (!declaration) throw new Error("no listClass declaration found");

  // `?.` and `??` are not ternaries; every other `?` introduces an arm.
  const armCount = [...declaration.matchAll(/\?(?![.?])/g)].length;
  const guardCount = [...declaration.matchAll(/density === "[\w-]+"\s*\?\s*(?=")/g)].length;
  if (guardCount !== armCount) {
    throw new Error("a listClass arm is guarded by something this guard cannot read");
  }

  const arms: Array<{ lane: string | null; className: string }> = [];
  for (const match of declaration.matchAll(/(?:density === "([\w-]+)"\s*\?\s*)?"([^"]*)"/g)) {
    // An arm's literal ends the arm: the chain's next `:` or the declaration's
    // `;`. Anything else means the value is built from more than the literal this
    // reader saw (`"flex px-4" + (wide ? " px-6" : "")`), and half a class is not
    // the gutter the lane renders.
    const tail = declaration.slice((match.index ?? 0) + match[0].length);
    if (!/^(?:\s*[:;]|\s*$)/.test(tail)) {
      throw new Error("a listClass arm is part of a larger expression this guard cannot read");
    }
    arms.push({ lane: match[1] ?? null, className: match[2] as string });
  }
  // Guarded arms + the one fallback arm. A value that is not a literal (a shared
  // constant, a template string) leaves fewer arms than the ternary count demands.
  if (arms.length !== armCount + 1) {
    throw new Error("a listClass arm is not a plain string literal this guard can read");
  }
  const guarded = arms.filter((arm) => arm.lane !== null);
  if (new Set(guarded.map((arm) => arm.lane)).size !== guarded.length) {
    throw new Error("listClass names the same density twice");
  }
  const unguarded = arms.filter((arm) => arm.lane === null);
  const fallback = unguarded[0];
  if (unguarded.length !== 1 || !fallback) throw new Error("listClass has no single fallback arm");
  const resolved = guarded.find((arm) => arm.lane === "masonry") ?? fallback;
  const gutter = /(?:^|\s)px-(\d+)(?=\s|$)/.exec(resolved.className);
  if (!gutter) throw new Error(`no px-* gutter in the masonry list class: ${resolved.className}`);
  // Tailwind's spacing unit is 0.25rem.
  return Number(gutter[1]) / 4;
}

/** {@link resolveMasonryPaddingRem} against the real product component. */
export function masonryListPaddingRem(): number {
  return resolveMasonryPaddingRem(readFileSync("src/components/PostList.tsx", "utf8"));
}
