import { diag } from "./diag";

/** Result of parsing structured VLM output. */
export interface VlmAnalysis {
  objectName: string | null;
  suggestedCategory: string | null;
  /** The proposed category was not released, so only text suggestions may be used. */
  categoryUnavailable?: boolean;
  colors: string[];
  visibleBrand: string | null;
  visibleText: string[];
  identifyingFeatures: string[];
  suggestedTitle: string | null;
  suggestedDescription: string | null;
  uncertainFields: string[];
}

/** Raised when VLM output cannot be parsed into a structured analysis. */
export class VlmUnstructuredOutputError extends Error {
  constructor(message = "VLM output is not valid structured JSON.") {
    super(message);
    this.name = "VlmUnstructuredOutputError";
  }
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

function buildControlCharRegex(): RegExp {
  const c0Controls = Array.from({ length: 0x20 }, (_, i) => i);
  const del = [0x7f];
  const c1Controls = Array.from({ length: 0x20 }, (_, i) => 0x80 + i);
  const codePoints = [...c0Controls, ...del, ...c1Controls];
  const pattern = codePoints.map((cp) => String.fromCodePoint(cp)).join("");
  return new RegExp(`[${pattern}]`, "g");
}

const CONTROL_CHAR_REGEX = buildControlCharRegex();
const MARKDOWN_FENCE_REGEX = /^```(?:json)?\s*|\s*```$/g;

const SENSITIVE_PATTERNS = [
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b\+?\d[\d\s().-]{7,}\d\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(id|passport|license|nid)\b[\s\S]{0,12}?[A-Z0-9-]{4,}/i,
  /\b(?:otp|one[\s-]?time|verification|code|pin)[\s:]*\d{4,8}\b/i,
  /\b\d{6}\b/,
  /\bhttps?:\/\/\S+/i,
  /\bWIFI:[^\s]+/i,
  /\bBEGIN:(?:VCARD|VEVENT)/i,
];

function redactSensitiveText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return SENSITIVE_PATTERNS.some((re) => re.test(trimmed)) ? "[redacted]" : trimmed;
}

function sanitizeString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  let sanitized = value.replace(CONTROL_CHAR_REGEX, "").replace(MARKDOWN_FENCE_REGEX, "");
  sanitized = redactSensitiveText(sanitized);
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }
  return sanitized;
}

function sanitizeArray(value: unknown, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (result.length >= maxItems) break;
    if (typeof item !== "string") continue;
    let sanitized = item.replace(CONTROL_CHAR_REGEX, "").replace(MARKDOWN_FENCE_REGEX, "");
    sanitized = redactSensitiveText(sanitized);
    if (sanitized.length > maxItemLength) {
      sanitized = sanitized.slice(0, maxItemLength);
    }
    if (sanitized.length > 0) {
      result.push(sanitized);
    }
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

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && startIndex !== -1) {
          return text.slice(startIndex, i + 1);
        }
      }
    }
  }

  return null;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    return fenceMatch[1]!.trim();
  }
  return trimmed;
}

/** Every canonical key must be present; a missing key is invalid output. */
const REQUIRED_KEYS = [
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

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseVlmOutput(raw: string, allowedCategories: readonly string[]): VlmAnalysis | null {
  const trimmed = String(raw).trim();
  const withoutFence = stripCodeFence(trimmed);
  const jsonText = extractFirstJsonObject(withoutFence);

  if (!jsonText) {
    diag("vlm.parser.no_json", { inputLength: raw.length }, {});
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    diag("vlm.parser.json_parse_error", { inputLength: raw.length, jsonLength: jsonText.length }, {});
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diag("vlm.parser.not_object", { inputLength: raw.length }, {});
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  // Missing key != key present with a null value. Reject incomplete output so
  // it goes through the correction retry instead of becoming a "valid" result.
  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      diag("vlm.parser.missing_key", { key, inputLength: raw.length }, {});
      return null;
    }
  }

  if (!isStringOrNull(obj.objectName)) {
    diag("vlm.parser.invalid_objectName", { inputLength: raw.length }, {});
    return null;
  }
  if (!isStringOrNull(obj.visibleBrand)) {
    diag("vlm.parser.invalid_visibleBrand", { inputLength: raw.length }, {});
    return null;
  }
  if (!isStringOrNull(obj.suggestedTitle)) {
    diag("vlm.parser.invalid_suggestedTitle", { inputLength: raw.length }, {});
    return null;
  }
  if (!isStringOrNull(obj.suggestedDescription)) {
    diag("vlm.parser.invalid_suggestedDescription", { inputLength: raw.length }, {});
    return null;
  }
  if (!isStringArray(obj.colors)) {
    diag("vlm.parser.invalid_colors", { inputLength: raw.length }, {});
    return null;
  }
  if (!isStringArray(obj.visibleText)) {
    diag("vlm.parser.invalid_visibleText", { inputLength: raw.length }, {});
    return null;
  }
  if (!isStringArray(obj.identifyingFeatures)) {
    diag("vlm.parser.invalid_identifyingFeatures", { inputLength: raw.length }, {});
    return null;
  }
  if (!isStringArray(obj.uncertainFields)) {
    diag("vlm.parser.invalid_uncertainFields", { inputLength: raw.length }, {});
    return null;
  }

  const suggestedCategory = obj.suggestedCategory;
  if (suggestedCategory !== null) {
    if (typeof suggestedCategory !== "string" || !allowedCategories.includes(suggestedCategory)) {
      diag("vlm.parser.invalid_category", { category: String(suggestedCategory), inputLength: raw.length }, {});
      return null;
    }
  }

  const result = {
    objectName: sanitizeString(obj.objectName, MAX_OBJECT_NAME),
    suggestedCategory: suggestedCategory ?? null,
    colors: sanitizeArray(obj.colors, MAX_COLORS, MAX_ARRAY_ITEM),
    visibleBrand: sanitizeString(obj.visibleBrand, MAX_VISIBLE_BRAND),
    visibleText: sanitizeArray(obj.visibleText, MAX_VISIBLE_TEXT, MAX_ARRAY_ITEM),
    identifyingFeatures: sanitizeArray(obj.identifyingFeatures, MAX_IDENTIFYING_FEATURES, MAX_ARRAY_ITEM),
    suggestedTitle: sanitizeString(obj.suggestedTitle, MAX_SUGGESTED_TITLE),
    suggestedDescription: sanitizeString(obj.suggestedDescription, MAX_SUGGESTED_DESCRIPTION),
    uncertainFields: sanitizeArray(obj.uncertainFields, MAX_UNCERTAIN_FIELDS, MAX_ARRAY_ITEM),
  };
  diag("vlm.parser.success", {
    hasTitle: !!result.suggestedTitle,
    hasDescription: !!result.suggestedDescription,
    hasCategory: !!result.suggestedCategory,
    colorCount: result.colors.length,
    visibleTextCount: result.visibleText.length,
    featureCount: result.identifyingFeatures.length,
  }, {});
  return result;
}
