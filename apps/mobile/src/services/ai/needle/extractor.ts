/**
 * WS2 Needle TEXT challenger seam — local structured-field extractor.
 *
 * Isolated scope: pure local parsing only. No network, no model download, no
 * bridge calls. Returns the nine fields below so the challenger can be compared
 * field-for-field against the incumbent report-field suggester without touching
 * `possibleMatches.ts`, `orchestrator/`, or any LiteRT/llama/probe/UI code.
 */

export const NEEDLE_EXTRACTION_KEYS = [
  "objectName",
  "suggestedCategory",
  "colors",
  "visibleBrand",
  "visibleText",
  "identifyingFeatures",
  "suggestedTitle",
  "suggestedDescription",
  "uncertainFields",
] as const;

export type NeedleExtractionKey = (typeof NEEDLE_EXTRACTION_KEYS)[number];

/** Structured fields this seam defines; the report-field suggester consumes the same keys. */
export interface NeedleExtraction {
  objectName: string | null;
  suggestedCategory: string | null;
  colors: string[];
  visibleBrand: string | null;
  visibleText: string[];
  identifyingFeatures: string[];
  suggestedTitle: string | null;
  suggestedDescription: string | null;
  uncertainFields: string[];
}

const MAX_OBJECT_NAME = 120;
const MAX_VISIBLE_BRAND = 80;
const MAX_ARRAY_ITEM = 40;
const MAX_COLORS = 8;
const MAX_VISIBLE_TEXT = 20;
const MAX_IDENTIFYING_FEATURES = 20;
const MAX_SUGGESTED_TITLE = 120;
const MAX_SUGGESTED_DESCRIPTION = 600;
const MAX_UNCERTAIN_FIELDS = 12;

function sanitizeString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const sanitized = value.replace(/\s+/g, " ").trim();
  return sanitized.slice(0, maxLength);
}

function sanitizeArray(value: unknown, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (result.length >= maxItems) break;
    if (typeof item !== "string") continue;
    const sanitized = item.replace(/\s+/g, " ").trim().slice(0, maxItemLength);
    if (sanitized.length > 0) result.push(sanitized);
  }
  return result;
}

function extractFirstJsonObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let startIndex = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) startIndex = i;
      depth++;
    } else if (char === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIndex !== -1) return text.slice(startIndex, i + 1);
      }
    }
  }
  return null;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch?.[1] !== undefined) return fenceMatch[1].trim();
  return trimmed;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Parses structured challenger output into `NeedleExtraction`.
 * Local-only: no fetch, no bridge, no model. Returns `null` for missing
 * canonical keys, wrong-typed fields, unknown categories, or unparsable
 * input — mirroring `parseVlmOutput` rejection semantics.
 */
export function extractNeedleFields(
  raw: string,
  allowedCategories: readonly string[] = [],
): NeedleExtraction | null {
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const jsonText = extractFirstJsonObject(stripCodeFence(trimmed));
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  for (const key of NEEDLE_EXTRACTION_KEYS) {
    if (!(key in obj)) return null;
  }
  if (!isStringOrNull(obj.objectName)) return null;
  if (!isStringOrNull(obj.visibleBrand)) return null;
  if (!isStringOrNull(obj.suggestedTitle)) return null;
  if (!isStringOrNull(obj.suggestedDescription)) return null;
  if (!isStringArray(obj.colors)) return null;
  if (!isStringArray(obj.visibleText)) return null;
  if (!isStringArray(obj.identifyingFeatures)) return null;
  if (!isStringArray(obj.uncertainFields)) return null;

  const suggestedCategory = obj.suggestedCategory;
  if (suggestedCategory !== null) {
    if (typeof suggestedCategory !== "string" || !allowedCategories.includes(suggestedCategory)) {
      return null;
    }
  }

  return {
    objectName: sanitizeString(obj.objectName, MAX_OBJECT_NAME),
    suggestedCategory: (suggestedCategory as string | null) ?? null,
    colors: sanitizeArray(obj.colors, MAX_COLORS, MAX_ARRAY_ITEM),
    visibleBrand: sanitizeString(obj.visibleBrand, MAX_VISIBLE_BRAND),
    visibleText: sanitizeArray(obj.visibleText, MAX_VISIBLE_TEXT, MAX_ARRAY_ITEM),
    identifyingFeatures: sanitizeArray(
      obj.identifyingFeatures,
      MAX_IDENTIFYING_FEATURES,
      MAX_ARRAY_ITEM,
    ),
    suggestedTitle: sanitizeString(obj.suggestedTitle, MAX_SUGGESTED_TITLE),
    suggestedDescription: sanitizeString(obj.suggestedDescription, MAX_SUGGESTED_DESCRIPTION),
    uncertainFields: sanitizeArray(obj.uncertainFields, MAX_UNCERTAIN_FIELDS, MAX_ARRAY_ITEM),
  };
}
