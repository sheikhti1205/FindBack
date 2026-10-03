/**
 * WS-A task registry: the 10 routable AI tasks and their budgets.
 *
 * Each spec bounds one task (input bytes/images, privacy envelope, ordered
 * runtime preferences, timeout, consent, result schema). Lookup is total:
 * unknown ids yield `undefined` and the orchestrator fails closed.
 *
 * `tryDeterministic` is the deterministic-first path: pure, synchronous,
 * no I/O. A resolved outcome lets `route` skip model runtimes entirely.
 * Anything it cannot decide returns `{ resolved: false }` and the model
 * path runs. `fallbackFor` surfaces a local extractive fallback when a
 * model runtime fails (currently only summarize-local-context has one).
 */
import type { AiTaskId, AiTaskSpec } from "../types";
import { isAiTaskId } from "../types";

export const TASK_IDS: readonly AiTaskId[] = [
  "classify-intent",
  "extract-report-fields",
  "answer-help",
  "extract-search-filters",
  "analyze-image",
  "route-intent",
  "embed-texts",
  "ground-objects",
  "classify-category",
  "summarize-local-context",
];

const SPECS: Readonly<Record<AiTaskId, AiTaskSpec>> = {
  "classify-intent": {
    taskId: "classify-intent",
    maxBytes: 4_096,
    maxImages: 0,
    privacyClass: "local-only",
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 5_000,
    needsConsent: false,
    schema: "classify-intent/v1",
  },
  "extract-report-fields": {
    taskId: "extract-report-fields",
    maxBytes: 8_192,
    maxImages: 0,
    privacyClass: "local-only",
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 8_000,
    needsConsent: false,
    schema: "report-slots/v1",
  },
  "answer-help": {
    taskId: "answer-help",
    maxBytes: 4_096,
    maxImages: 0,
    privacyClass: "local-only",
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 8_000,
    needsConsent: false,
    schema: "help-answer/v1",
  },
  "extract-search-filters": {
    taskId: "extract-search-filters",
    maxBytes: 4_096,
    maxImages: 0,
    privacyClass: "local-only",
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 5_000,
    needsConsent: false,
    schema: "search-filters/v1",
  },
  "analyze-image": {
    taskId: "analyze-image",
    maxBytes: 2_048,
    maxImages: 1,
    privacyClass: "local-only",
    runtimes: ["local-vision"],
    timeoutMs: 30_000,
    needsConsent: false,
    schema: "photo-analysis/v2",
  },
  "route-intent": {
    taskId: "route-intent",
    maxBytes: 4_096,
    maxImages: 0,
    privacyClass: "local-only",
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 5_000,
    needsConsent: false,
    schema: "route-intent/v1",
  },
  "embed-texts": {
    taskId: "embed-texts",
    maxBytes: 32_768,
    maxImages: 0,
    privacyClass: "local-only",
    runtimes: ["local-embedding"],
    timeoutMs: 10_000,
    needsConsent: false,
    schema: "text-embeddings/v1",
  },
  "ground-objects": {
    taskId: "ground-objects",
    maxBytes: 2_048,
    maxImages: 1,
    privacyClass: "local-only",
    runtimes: ["local-vision"],
    timeoutMs: 30_000,
    needsConsent: false,
    schema: "object-grounding/v1",
  },
  "classify-category": {
    taskId: "classify-category",
    maxBytes: 4_096,
    maxImages: 0,
    privacyClass: "local-only",
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 5_000,
    needsConsent: false,
    schema: "item-category/v1",
  },
  "summarize-local-context": {
    taskId: "summarize-local-context",
    maxBytes: 16_384,
    maxImages: 0,
    privacyClass: "local-only",
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 10_000,
    needsConsent: false,
    schema: "local-summary/v1",
  },
};

export function getTaskSpec(taskId: string): AiTaskSpec | undefined {
  if (!isAiTaskId(taskId)) return undefined;
  return SPECS[taskId];
}

export function listTaskSpecs(): readonly AiTaskSpec[] {
  return TASK_IDS.map((taskId) => SPECS[taskId]);
}

export function isTaskId(value: unknown): value is AiTaskId {
  return isAiTaskId(value);
}

export type DeterministicOutcome =
  | { readonly resolved: true; readonly value: unknown }
  | { readonly resolved: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(input: unknown): string {  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null) {
    const text = (input as Record<string, unknown>)["text"];
    if (typeof text === "string") return text;
  }
  return "";
}

function classifyIntentText(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\b(lost|missing)\b/.test(lower)) return "REPORT_LOST";
  if (/\b(found|retrieve|returned)\b/.test(lower)) return "REPORT_FOUND";
  if (/\b(search|find|looking for|where)\b/.test(lower)) return "SEARCH";
  if (/\b(how|help|what|report|account|settings)\b/.test(lower)) return "APP_QUESTION";
  if (text.trim() === "") return "UNKNOWN";
  return undefined;
}

function extractAfterMarker(text: string, marker: string): string | undefined {
  const index = text.toLowerCase().indexOf(marker);
  if (index === -1) return undefined;
  const value = text.slice(index + marker.length).split("\n")[0]?.trim() ?? "";
  return value === "" ? undefined : value;
}

const HELP_FAQ: ReadonlyArray<{ readonly match: RegExp; readonly answer: string }> = [
  {
    match: /how (do|can) i report/i,
    answer: "Open the report flow from the home screen, add a title and a photo, then submit.",
  },
  {
    match: /how (do|can) i search/i,
    answer: "Open search from the home screen and enter keywords, a category, or a date range.",
  },
];

const CATEGORY_KEYWORDS: ReadonlyArray<{ readonly match: RegExp; readonly category: string }> = [
  { match: /\b(wallet|keys|phone|bag|umbrella|backpack|laptop)\b/i, category: "accessories" },
  { match: /\b(dog|cat|parrot|pet)\b/i, category: "pets" },
  { match: /\b(passport|id card|license|document)\b/i, category: "documents" },
  { match: /\b(jacket|coat|shoe|hat|glove)\b/i, category: "clothing" },
];

const SUMMARY_FALLBACK_MAX = 280;

/**
 * Pure deterministic rules, one per task that admits them. Vision and
 * embedding tasks never resolve here (they need a runtime); text tasks
 * resolve only on unambiguous local signals and defer otherwise.
 */
export function tryDeterministic(taskId: AiTaskId, input: unknown): DeterministicOutcome {
  const text = readText(input);
  switch (taskId) {
    case "classify-intent": {
      const intent = classifyIntentText(text);
      if (intent === undefined) return { resolved: false };
      return { resolved: true, value: { intent, deterministic: true } };
    }
    case "route-intent": {
      const intent = classifyIntentText(text);
      if (intent === undefined) return { resolved: false };
      return { resolved: true, value: { intent, route: intent.toLowerCase(), deterministic: true } };
    }
    case "answer-help": {
      const hit = HELP_FAQ.find((entry) => entry.match.test(text));
      if (hit === undefined) return { resolved: false };
      return { resolved: true, value: { answerText: hit.answer, deterministic: true } };
    }
    case "extract-report-fields": {
      const title = extractAfterMarker(text, "title:");
      const category = extractAfterMarker(text, "category:");
      if (title === undefined && category === undefined) return { resolved: false };
      return {
        resolved: true,
        value: {
          fields: {
            ...(title === undefined ? {} : { title }),
            ...(category === undefined ? {} : { category }),
          },
          deterministic: true,
        },
      };
    }
    case "extract-search-filters": {
      const category = extractAfterMarker(text, "category:");
      const query = extractAfterMarker(text, "query:");
      if (category === undefined && query === undefined) return { resolved: false };
      return {
        resolved: true,
        value: {
          fields: {
            ...(query === undefined ? {} : { query }),
            ...(category === undefined ? {} : { category }),
          },
          deterministic: true,
        },
      };
    }
    case "classify-category": {
      const hit = CATEGORY_KEYWORDS.find((entry) => entry.match.test(text));
      if (hit === undefined) return { resolved: false };
      return { resolved: true, value: { category: hit.category, deterministic: true } };
    }
    case "summarize-local-context": {
      // Local extractive summary needs the actual turns: plain text without
      // turns defers to the model path (whose failure still surfaces the
      // truncation fallback via `fallbackFor`).
      if (!isRecord(input) || !Array.isArray(input["turns"])) return { resolved: false };
      const turns = (input["turns"] as unknown[]).filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      );
      if (turns.length === 0) return { resolved: false };
      const joined = turns.join(" ").trim();
      const summary =
        joined.length > SUMMARY_FALLBACK_MAX
          ? `${joined.slice(0, SUMMARY_FALLBACK_MAX).trimEnd()}…`
          : joined;
      return { resolved: true, value: { summary, deterministic: true } };
    }
    case "analyze-image":
    case "embed-texts":
    case "ground-objects":
      return { resolved: false };
  }
}

/**
 * Local extractive fallback surfaced (alongside the failure) when a model
 * runtime fails. Only summarize-local-context defines one: truncation is
 * always available and never leaves the device.
 */
export function fallbackFor(taskId: AiTaskId, input: unknown): unknown | undefined {
  if (taskId !== "summarize-local-context") return undefined;
  const trimmed = readText(input).trim().replace(/\s+/g, " ");
  if (trimmed === "") return undefined;
  return trimmed.length > SUMMARY_FALLBACK_MAX
    ? `${trimmed.slice(0, SUMMARY_FALLBACK_MAX).trimEnd()}…`
    : trimmed;
}
