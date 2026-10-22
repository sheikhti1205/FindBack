/**
 * The ONE coordinate detector — "is this text a position, not a name?".
 *
 * Three surfaces ask this question and there must be one answer:
 *
 *  * the AI validators (`services/ai/normalize.ts`), because a model must
 *    never turn a position into a free-text slot;
 *  * the place matcher (`services/search/placeScope.ts`), because a place is
 *    a NAME the reader typed;
 *  * the natural-language filter reader (`services/search/nlFilters.ts`),
 *    which turns a sentence into those same slots.
 *
 * A narrow decimal-comma regex is not enough. A model or a reader writes a
 * position as `23.8103, 90.4125`, as `23.8103° N, 90.4125° E`, as
 * `23.8103N, 90.4125E`, or as `23°48'37"N 90°24'45"E`, and every one of
 * those is still a position. Requiring at least TWO angular components keeps
 * a real name intact: `221B Baker Street`, `Sector 12, Uttara` and
 * `12 North Street` contain a number or a compass word, not a position.
 */

/** A decimal pair whose two values could be a latitude and a longitude. */
const DECIMAL_PAIR = /(-?\d{1,3}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)/g;

/**
 * One angular component: degrees, optional minutes and seconds, then a
 * hemisphere letter. `12 North Street` is excluded by the trailing
 * `(?![A-Za-z])`, because `North` continues past the `N`.
 */
const HEMISPHERE_COMPONENT = /\d{1,3}(?:\.\d+)?\s*°?\s*(?:\d{1,2}(?:\.\d+)?\s*['′m])?\s*(?:\d{1,2}(?:\.\d+)?\s*(?:"|″|s))?\s*[NSEWnsew](?![A-Za-z])/g;

/** Consecutive decimal values `12.5 65.5` (no comma) in plausible ranges. */
const WHITESPACE_PAIR = /(-?\d{1,3}\.\d+)\s+(-?\d{1,3}\.\d+)/g;

/** A degrees-only pair such as `23°N 90°E` or `23°, 90°`. */
const DEGREE_PAIR = /\d{1,3}(?:\.\d+)?\s*°(?:\s*[NSEWnsew](?![A-Za-z]))?/g;

function plausible(first: string, second: string): boolean {
  const a = Number(first);
  const b = Number(second);
  // A position may be written latitude-first ("23.8103, 90.4125") or
  // longitude-first ("90.4125, 23.8103"), and Dhaka sits at 90.4125 east — so
  // both assignments count. A pair where neither value fits either range is
  // not a position.
  return (
    (Math.abs(a) <= 90 && Math.abs(b) <= 180) ||
    (Math.abs(b) <= 90 && Math.abs(a) <= 180)
  );
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _ of text.matchAll(pattern)) count += 1;
  return count;
}

/**
 * True when `value` is a written position rather than a place name.
 *
 * Conservative by construction: a value must look like two angular values
 * (a plausible decimal pair, or two hemisphere/degree components) before it
 * is called a coordinate.
 */
export function looksLikeCoordinates(value: string): boolean {
  const text = value.trim();
  if (text === "") return false;

  for (const match of text.matchAll(DECIMAL_PAIR)) {
    if (plausible(match[1]!, match[2]!)) return true;
  }
  for (const match of text.matchAll(WHITESPACE_PAIR)) {
    if (plausible(match[1]!, match[2]!)) return true;
  }
  // A single decimal followed by a degree sign and a hemisphere letter is
  // already one angular component; two of them are a position.
  if (countMatches(text, HEMISPHERE_COMPONENT) >= 2) return true;
  if (countMatches(text, DEGREE_PAIR) >= 2) return true;
  return false;
}
