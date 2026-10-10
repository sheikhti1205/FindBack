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

/**
 * SmolVLM-tolerant key aliases: the small local model frequently emits
 * snake_case, differently-cased, or shortened keys (`object_name`, `title`,
 * `category`, `features`). Aliases map to the canonical key; canonical keys
 * win when both are present. Unknown keys are ignored.
 */
const KEY_ALIASES: Readonly<Record<string, (typeof REQUIRED_KEYS)[number]>> = {
  objectname: "objectName",
  object_name: "objectName",
  item: "objectName",
  itemname: "objectName",
  item_name: "objectName",
  suggestedcategory: "suggestedCategory",
  suggested_category: "suggestedCategory",
  category: "suggestedCategory",
  predictedcategory: "suggestedCategory",
  predicted_category: "suggestedCategory",
  colour: "colors",
  colours: "colors",
  color: "colors",
  colors: "colors",
  visiblebrand: "visibleBrand",
  visible_brand: "visibleBrand",
  brand: "visibleBrand",
  visibletext: "visibleText",
  visible_text: "visibleText",
  text: "visibleText",
  ocr: "visibleText",
  transcription: "visibleText",
  identifyingfeatures: "identifyingFeatures",
  identifying_features: "identifyingFeatures",
  features: "identifyingFeatures",
  details: "identifyingFeatures",
  suggestedtitle: "suggestedTitle",
  suggested_title: "suggestedTitle",
  title: "suggestedTitle",
  suggesteddescription: "suggestedDescription",
  suggested_description: "suggestedDescription",
  description: "suggestedDescription",
  uncertainfields: "uncertainFields",
  uncertain_fields: "uncertainFields",
  uncertain: "uncertainFields",
};

function canonicalKeyOf(rawKey: string): (typeof REQUIRED_KEYS)[number] | null {
  const normalized = rawKey.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((REQUIRED_KEYS as readonly string[]).includes(rawKey)) {
    return rawKey as (typeof REQUIRED_KEYS)[number];
  }
  const direct = (REQUIRED_KEYS as readonly string[]).find(
    (key) => key.toLowerCase() === rawKey.trim().toLowerCase(),
  );
  if (direct !== undefined) return direct as (typeof REQUIRED_KEYS)[number];
  return KEY_ALIASES[normalized] ?? null;
}

/** Collapse pathological echo loops ("black umbrella black umbrella x6") to one instance. */
function collapseEchoLoop(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  // Same sentence echoed 3+ times: keep the first.
  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  if (sentences.length >= 3) {
    const first = sentences[0]!.trim().toLowerCase();
    if (first.length > 10 && sentences.every((s) => s.trim().toLowerCase() === first)) {
      return sentences[0]!.trim();
    }
  }
  // Same word/phrase repeated 6+ times in a row (bench loop_flag spans 1/2/4).
  const words = trimmed.split(/\s+/);
  if (words.length >= 12) {
    for (const span of [1, 2, 4]) {
      let runs = 1;
      let looped = false;
      for (let i = span; i + span <= words.length; i += span) {
        const a = words.slice(i - span, i).join(" ").toLowerCase();
        const b = words.slice(i, i + span).join(" ").toLowerCase();
        if (a === b) {
          runs += 1;
          if (runs >= 6) {
            looped = true;
            break;
          }
        } else {
          runs = 1;
        }
      }
      if (looped) {
        return words.slice(0, span).join(" ");
      }
    }
  }
  return trimmed;
}

function coerceStringOrNull(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") {
    return sanitizeString(String(value), maxLength);
  }
  if (typeof value !== "string") return null;
  const collapsed = collapseEchoLoop(value);
  return sanitizeString(collapsed, maxLength);
}

function coerceStringArray(value: unknown, maxItems: number, maxItemLength: number): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (result.length >= maxItems) break;
    if (typeof item === "number" || typeof item === "boolean") {
      const text = sanitizeString(collapseEchoLoop(String(item)), maxItemLength);
      if (text !== null && text.length > 0 && !seen.has(text.toLowerCase())) {
        seen.add(text.toLowerCase());
        result.push(text);
      }
      continue;
    }
    if (typeof item !== "string") continue;
    const collapsed = collapseEchoLoop(item);
    let sanitized = collapsed.replace(CONTROL_CHAR_REGEX, "").replace(MARKDOWN_FENCE_REGEX, "");
    sanitized = redactSensitiveText(sanitized);
    if (sanitized.length > maxItemLength) {
      sanitized = sanitized.slice(0, maxItemLength);
    }
    sanitized = sanitized.trim();
    if (sanitized.length > 0 && !seen.has(sanitized.toLowerCase())) {
      seen.add(sanitized.toLowerCase());
      result.push(sanitized);
    }
  }
  return result;
}

/** Attempt to repair an unterminated looped JSON object (missing closing braces). */
function repairTruncatedJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  const slice = text.slice(start);
  // Try the longest balanced prefix first, then progressively shorter, then
  // brace-completion for unterminated loops.
  const lastClose = slice.lastIndexOf("}");
  if (lastClose !== -1) {
    const candidate = slice.slice(0, lastClose + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Fall through to brace completion.
    }
  }
  // Unterminated: strip trailing partial token/loop and close open braces.
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let end = slice.length;
  for (let i = 0; i < slice.length; i++) {
    const char = slice[i];
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
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (inString || depth <= 0) return null;
  // Close any open string, then open objects/arrays.
  let repaired = slice.slice(0, end).trim();
  if (inString) repaired += '"';
  // Count unclosed structures from the repaired prefix.
  let openObjects = 0;
  let openArrays = 0;
  let str = false;
  let esc = false;
  for (const ch of repaired) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      str = !str;
      continue;
    }
    if (str) continue;
    if (ch === "{") openObjects++;
    else if (ch === "}") openObjects--;
    else if (ch === "[") openArrays++;
    else if (ch === "]") openArrays--;
  }
  repaired += "]".repeat(Math.max(0, openArrays)) + "}".repeat(Math.max(0, openObjects));
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return null;
  }
}

export function parseVlmOutput(raw: string, allowedCategories: readonly string[]): VlmAnalysis | null {
  const trimmed = String(raw).trim();
  const withoutFence = stripCodeFence(trimmed);
  let jsonText = extractFirstJsonObject(withoutFence);
  if (!jsonText) {
    jsonText = repairTruncatedJson(withoutFence);
  }

  if (!jsonText) {
    diag("vlm.parser.no_json", { inputLength: raw.length }, {});
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    const repaired = repairTruncatedJson(withoutFence);
    if (repaired === null) {
      diag("vlm.parser.json_parse_error", { inputLength: raw.length, jsonLength: jsonText.length }, {});
      return null;
    }
    try {
      parsed = JSON.parse(repaired);
    } catch {
      diag("vlm.parser.json_parse_error", { inputLength: raw.length, jsonLength: jsonText.length }, {});
      return null;
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    diag("vlm.parser.not_object", { inputLength: raw.length }, {});
    return null;
  }

  const rawObj = parsed as Record<string, unknown>;
  // Normalize keys via aliases (SmolVLM snake_case/shorthand); canonical wins.
  const obj: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(rawObj)) {
    const canonical = canonicalKeyOf(rawKey);
    if (canonical === null) continue;
    if (!(canonical in obj)) obj[canonical] = value;
  }

  // Tolerant: missing keys default (null/[]); wrong types coerce; unknown
  // categories drop to null instead of failing the whole output. Only a
  // signal-free object (no usable field at all) is UNUSABLE.
  const categoryRaw = obj.suggestedCategory ?? null;
  let suggestedCategory: string | null = null;
  if (typeof categoryRaw === "string") {
    const wanted = categoryRaw.trim();
    const exact = (allowedCategories as readonly string[]).includes(wanted);
    if (exact) {
      suggestedCategory = wanted;
    } else {
      const lowered = wanted.toLowerCase();
      const match = (allowedCategories as readonly string[]).find(
        (candidate) => candidate.toLowerCase() === lowered,
      );
      suggestedCategory = match ?? null;
      if (suggestedCategory === null && wanted !== "") {
        diag("vlm.parser.invalid_category", { category: wanted, inputLength: raw.length }, {});
      }
    }
  } else if (typeof categoryRaw === "number") {
    suggestedCategory = null;
  }

  const result = {
    objectName: coerceStringOrNull(obj.objectName, MAX_OBJECT_NAME),
    suggestedCategory,
    colors: coerceStringArray(obj.colors, MAX_COLORS, MAX_ARRAY_ITEM),
    visibleBrand: coerceStringOrNull(obj.visibleBrand, MAX_VISIBLE_BRAND),
    visibleText: coerceStringArray(obj.visibleText, MAX_VISIBLE_TEXT, MAX_ARRAY_ITEM),
    identifyingFeatures: coerceStringArray(obj.identifyingFeatures, MAX_IDENTIFYING_FEATURES, MAX_ARRAY_ITEM),
    suggestedTitle: coerceStringOrNull(obj.suggestedTitle, MAX_SUGGESTED_TITLE),
    suggestedDescription: coerceStringOrNull(obj.suggestedDescription, MAX_SUGGESTED_DESCRIPTION),
    uncertainFields: coerceStringArray(obj.uncertainFields, MAX_UNCERTAIN_FIELDS, MAX_ARRAY_ITEM),
  };
  // Maximally usable: even an all-null/empty object resolves (the form stays
  // usable with manual entry). Only missing/unparseable JSON is UNUSABLE —
  // a parsed object, however sparse, carries the model's best signal.
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
