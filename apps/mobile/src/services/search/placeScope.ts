/**
 * The place scope of a search — the ONE place matcher.
 *
 * There is no server-side place filter. The feed RPC matches the title and
 * the description, and the only server-side geo scope is the nearby radius
 * (coordinates, map-pin reports only). A place NAME is therefore matched on
 * the device against the canonical place field of a report
 * (`locationLabel`), and the screen says how many of the loaded reports that
 * kept. Nothing here reads, derives or stores a coordinate: a place is a
 * name the reader typed, never a position.
 *
 * The match is a whole-word containment, so "Dhaka" matches "Dhaka,
 * Bangladesh" and does NOT match "Dhakaimpur". A report without a place name
 * cannot match a place filter — the sheet says so, because a map pin with no
 * place name is a real report the reader may expect to see.
 *
 * Everything is Unicode-aware: a place name may be written in any script.
 */

import { looksLikeCoordinates } from "./coordinates";

/** Longest place name the app accepts (a name, not a paragraph). */
export const MAX_PLACE_CHARS = 80;

/**
 * Why a value cannot be a place name — or null when it can.
 *
 * The reasons are kept apart so the reader is told the RIGHT one: a
 * coordinate, a bare number and an over-long name are three different
 * mistakes, and one sentence cannot be true of all of them.
 */
export type PlaceRejection = "coordinate" | "number" | "too-long";

/** The place name as it is matched and displayed (whitespace collapsed). */
function normalizePlace(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "").trim();
}

/** Why `value` is not a usable place name, or null when it is one. */
export function placeRejection(value: string | null | undefined): PlaceRejection | null {
  if (!value) return null;
  const trimmed = normalizePlace(value);
  if (trimmed === "") return null;
  if (trimmed.length > MAX_PLACE_CHARS) return "too-long";
  if (looksLikeCoordinates(trimmed)) return "coordinate";
  if (/^[\d\s.,#-]+$/.test(trimmed)) return "number";
  return null;
}

/**
 * Clean a place name for matching and display.
 *
 * Empty when the value is not a place name: empty, too long, a coordinate
 * pair, or nothing but digits and punctuation. A number on its own is an
 * address fragment, not a place, and a coordinate is never a place.
 */
export function cleanPlace(value: string | null | undefined): string {
  if (!value) return "";
  const trimmed = normalizePlace(value);
  if (trimmed === "" || placeRejection(value) !== null) return "";
  return trimmed;
}

/** The words of a place name, lowercased, in any script. */
export function placeTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0);
}

/**
 * True when a report's place label matches the filter.
 *
 * The filter's words must appear in the label in order and side by side, so
 * "Gulshan Dhaka" matches "Gulshan, Dhaka" and "Dhaka" matches "Dhaka,
 * Bangladesh", while "Dhaka" never matches "Dhakaimpur".
 */
export function matchesPlace(
  locationLabel: string | null | undefined,
  place: string,
): boolean {
  const target = placeTokens(place);
  if (target.length === 0) return false;
  const label = placeTokens(locationLabel);
  if (label.length === 0) return false;
  for (let start = 0; start + target.length <= label.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < target.length; offset += 1) {
      if (label[start + offset] !== target[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}
