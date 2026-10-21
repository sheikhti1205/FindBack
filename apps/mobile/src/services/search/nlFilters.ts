/**
 * NL search consumer over the extract-search-filters op.
 *
 * Raw input ("black wallet lost last week") flows through the narrow op and
 * comes back as validated, editable filter patches
 * ({query, category, status, postType, place, dateFrom, dateTo}). Anything
 * invalid or uncertain stays empty — this module never guesses, never invents
 * coordinates, and fails closed to an empty patch when the op fails.
 */
import { CATEGORIES, searchCategoryCatalog, type Category, type PostStatus, type PostType } from "@findback/shared";
import type { ModelProfile } from "../ai/modelProfiles";
import { extractSearchFilters } from "../ai/ops/extractSearchFilters";
import type { GenerateFn, SearchFilterFields } from "../ai/types";
import { recentCutoffDate } from "../nearby";
import { cleanPlace } from "./placeScope";

export interface NlFilterPatch {
  readonly query?: string;
  readonly category?: Category | "";
  readonly status?: PostStatus | "";
  /** The LOST/FOUND type, resolved to the canonical enum. */
  readonly postType?: PostType;
  /** A place NAME (never coordinates). */
  readonly place?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  /**
   * Set when the extractor offered a place that is not a usable place NAME.
   *
   * The place itself is ABSENT from the patch — an unusable place never
   * becomes a filter — but the refusal is carried out, so the screen can
   * tell the reader that a place was refused instead of silently dropping
   * it. A refusal is not a filter: it never counts as one, and it never
   * makes a patch non-empty.
   */
  readonly placeRefused?: boolean;
}

export interface NlFilterRange {
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

const COORD_PATTERN = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(now: Date, days: number): Date {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() - days);
  return next;
}

/**
 * True when the patch carries no usable filter (nothing to apply).
 *
 * A refused place is not a filter: the marker never makes a patch
 * non-empty, so an extraction that only refused a place stays empty.
 */
export function isNlPatchEmpty(patch: NlFilterPatch): boolean {
  return (
    patch.query === undefined &&
    patch.category === undefined &&
    patch.status === undefined &&
    patch.postType === undefined &&
    patch.place === undefined &&
    patch.dateFrom === undefined &&
    patch.dateTo === undefined
  );
}

/**
 * Resolve a free-text category to its canonical value. Exact canonical
 * match (case-insensitive) wins; otherwise a single unambiguous catalog hit
 * (canonical or synonym) is accepted. Ambiguous or unknown values resolve
 * to undefined — the caller leaves the filter empty.
 */
export function resolveNlCategory(value: string | undefined): Category | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const lowered = trimmed.toLowerCase();
  const exact = (CATEGORIES as readonly string[]).find((entry) => entry.toLowerCase() === lowered);
  if (exact !== undefined) return exact as Category;
  const hits = searchCategoryCatalog(trimmed);
  if (hits.length === 1) return hits[0]!.canonical as Category;
  return undefined;
}

/**
 * Resolve free-text status to a known PostStatus. Post types ("lost",
 * "found") and anything outside the status enum resolve to undefined.
 */
export function resolveNlStatus(value: string | undefined): PostStatus | undefined {
  if (value === undefined) return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === "") return undefined;
  return (["OPEN", "MATCHED", "RECOVERED", "CLOSED"] as const).includes(upper as PostStatus)
    ? (upper as PostStatus)
    : undefined;
}

/**
 * Resolve free text to the LOST/FOUND type.
 *
 * Only words that MEAN the type resolve: "lost", "missing" and "stolen" are
 * a lost report, "found" is a found report. Anything else (a report status,
 * a sentence, an empty value) resolves to undefined, and the caller leaves
 * the type filter empty rather than guessing one.
 */
export function resolveNlPostType(value: string | undefined): PostType | undefined {
  if (value === undefined) return undefined;
  const key = value.trim().toLowerCase();
  if (key === "") return undefined;
  if (key === "lost" || key === "missing" || key === "stolen") return "LOST";
  if (key === "found") return "FOUND";
  return undefined;
}

/**
 * Resolve free text to a place NAME.
 *
 * A place is a name the reader typed, never a coordinate and never a time
 * phrase: "last week" is a date, not a place, and a coordinate pair is
 * refused outright (the app has no geo filter and must never be handed one).
 */
export function resolveNlPlace(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = cleanPlace(value);
  if (cleaned === "") return undefined;
  if (/^(today|yesterday|tomorrow|last|past|this|next|recent|earlier|later)\b/i.test(cleaned)) return undefined;
  return cleaned;
}

/**
 * Map a relative date-range phrase to a bounded ISO range. Only a small
 * allowlist of relative phrases is supported; absolute dates are never
 * parsed from free text (no fabrication) and vague values yield no range.
 */
export function resolveNlDateRange(value: string | undefined, now: Date = new Date()): NlFilterRange {
  if (value === undefined) return {};
  const text = value.trim().toLowerCase();
  if (text === "" || COORD_PATTERN.test(text)) return {};
  const today = isoDay(now);
  if (text === "today") return { dateFrom: today, dateTo: today };
  if (text === "yesterday") {
    const day = isoDay(shiftDays(now, 1));
    return { dateFrom: day, dateTo: day };
  }
  if (text === "last week" || text === "past week" || text === "last 7 days") {
    return { dateFrom: recentCutoffDate(7, now), dateTo: today };
  }
  if (text === "last month" || text === "past month" || text === "last 30 days") {
    return { dateFrom: recentCutoffDate(30, now), dateTo: today };
  }
  return {};
}

/** Pure validator: op slot fields → validated patch (no I/O, no guessing). */
export function toValidatedPatch(fields: SearchFilterFields, now: Date = new Date()): NlFilterPatch {
  const patch: Record<string, string | undefined | boolean> = {};
  const query = fields.query?.trim();
  if (query !== undefined && query !== "" && query.length <= 140 && !COORD_PATTERN.test(query)) {
    patch["query"] = query;
  }
  const category = resolveNlCategory(fields.category);
  if (category !== undefined) patch["category"] = category;
  const status = resolveNlStatus(fields.status);
  if (status !== undefined) patch["status"] = status;
  // The type has its own slot. A model that still puts the type in `status`
  // (the old schema said so) is read there too — the type is a thing the
  // reader can filter by, whatever slot it arrives in.
  const postType = resolveNlPostType(fields.postType) ?? resolveNlPostType(fields.status);
  if (postType !== undefined) patch["postType"] = postType;
  const place = resolveNlPlace(fields.place);
  if (place !== undefined) {
    patch["place"] = place;
  } else if (fields.place !== undefined && fields.place.trim() !== "") {
    // A place WAS offered and it is not a usable name. The place stays out
    // of the patch (it never becomes a filter) and the refusal is carried
    // out, so the screen can tell the reader instead of dropping it in
    // silence.
    patch["placeRefused"] = true;
  }
  const range = resolveNlDateRange(fields.dateRangeText, now);
  if (range.dateFrom !== undefined && ISO_DATE_PATTERN.test(range.dateFrom)) {
    patch["dateFrom"] = range.dateFrom;
  }
  if (range.dateTo !== undefined && ISO_DATE_PATTERN.test(range.dateTo)) {
    patch["dateTo"] = range.dateTo;
  }
  return patch as NlFilterPatch;
}

export interface ExtractNlFiltersOptions {
  readonly now?: Date;
}

/**
 * Run raw NL input through extract-search-filters and return a validated
 * patch. Fail-closed: empty input never calls the model, and any op failure
 * yields an empty patch (invalid/uncertain values stay empty).
 */
export async function extractNlFilters(
  generate: GenerateFn,
  input: string,
  profile: ModelProfile,
  options?: ExtractNlFiltersOptions,
): Promise<NlFilterPatch> {
  if (input.trim() === "") return {};
  try {
    const result = await extractSearchFilters(generate, input, profile);
    if (!result.ok) return {};
    return toValidatedPatch(result.value.fields, options?.now);
  } catch {
    return {};
  }
}
