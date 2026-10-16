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
 * maths assumed. The resolver below either reads the arm the masonry lane really
 * takes or throws, so a shape it cannot understand fails the check instead of
 * quietly grading the fallback.
 *
 * Pure over its source text, so its own discrimination is tested with synthetic
 * `listClass` declarations rather than only against the product.
 */
export function resolveMasonryPaddingRem(source: string): number {
  const declaration = /const listClass =([\s\S]*?);\n/.exec(source)?.[1];
  if (!declaration) throw new Error("no listClass declaration found");
  const arms = [...declaration.matchAll(/(?:density === "([\w-]+)"\s*\?\s*)?"([^"]*)"/g)].map(
    (match) => ({ lane: match[1], className: match[2] as string }),
  );
  const guarded = arms.filter((arm) => arm.lane);
  const guards = declaration.match(/density === "[\w-]+"\s*\?/g) ?? [];
  if (guarded.length !== guards.length) {
    throw new Error("a listClass arm is not a plain string literal this guard can read");
  }
  if (new Set(guarded.map((arm) => arm.lane)).size !== guarded.length) {
    throw new Error("listClass names the same density twice");
  }
  const fallback = arms.filter((arm) => !arm.lane).pop();
  if (!fallback) throw new Error("listClass has no fallback arm");
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
