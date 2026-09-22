import {
  CATEGORIES,
  POST_STATUSES,
  POST_TYPES,
  type Category,
  type PostStatus,
  type PostType,
} from "@findback/shared";
import type { SearchFilterFields } from "../ai/types";

export const ASSISTANT_SEARCH_PATH = "/search";

/**
 * The subset of assistant-extracted search output that `SearchScreen`
 * actually supports. `dateRangeText` has no screen control and is always
 * dropped; unknown category/status values degrade to empty like unknown
 * deep-linked params rather than reaching the API.
 */
export interface AssistantSearchFilters {
  readonly type?: PostType;
  readonly q?: string;
  readonly category?: Category;
  readonly status?: PostStatus;
}

export interface AssistantSearchTarget {
  /** Ordinary search route with only supported params, e.g. `/search?q=keys`. */
  readonly path: string;
  readonly filters: AssistantSearchFilters;
  /** Extracted slot names the screen cannot honor (dropped or clarified). */
  readonly dropped: readonly string[];
}

function matchValue<T extends string>(value: string, allowed: readonly T[]): T | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return undefined;
  return allowed.find((entry) => entry.toLowerCase() === normalized);
}

export function mapAssistantSearchFilters(fields: SearchFilterFields): AssistantSearchTarget {
  const dropped: string[] = [];
  let type: PostType | undefined;
  let q: string | undefined;
  let category: Category | undefined;
  let status: PostStatus | undefined;

  const query = fields.query?.trim();
  if (query !== undefined && query !== "") q = query;

  if (fields.category !== undefined) {
    const matched = matchValue(fields.category, CATEGORIES);
    if (matched !== undefined) category = matched;
    else if (fields.category.trim() !== "") dropped.push("category");
  }

  if (fields.status !== undefined) {
    const matchedStatus = matchValue(fields.status, POST_STATUSES);
    if (matchedStatus !== undefined) {
      status = matchedStatus;
    } else {
      const matchedType = matchValue(fields.status, POST_TYPES);
      if (matchedType !== undefined) type = matchedType;
      else if (fields.status.trim() !== "") dropped.push("status");
    }
  }

  if (fields.dateRangeText !== undefined && fields.dateRangeText.trim() !== "") {
    dropped.push("dateRangeText");
  }

  const params = new URLSearchParams();
  if (type !== undefined) params.set("type", type);
  if (q !== undefined) params.set("q", q);
  if (category !== undefined) params.set("category", category);
  if (status !== undefined) params.set("status", status);
  const queryString = params.toString();
  const path = queryString === "" ? ASSISTANT_SEARCH_PATH : `${ASSISTANT_SEARCH_PATH}?${queryString}`;

  return { path, filters: { type, q, category, status }, dropped };
}

/**
 * Enter the ordinary search flow with the mapped filters. The model never
 * touches the database: this only navigates, and `SearchScreen` runs its
 * normal feed fetch from the URL params.
 */
export function navigateToAssistantSearch(
  navigate: (to: string) => void,
  fields: SearchFilterFields,
): AssistantSearchTarget {
  const target = mapAssistantSearchFilters(fields);
  navigate(target.path);
  return target;
}
