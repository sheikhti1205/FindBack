/**
 * Task registry: the single canonical authority for the routable local tool
 * tasks.
 *
 * Each spec bounds one task (input bytes, ordered runtime preferences,
 * enforced timeout, route consent, result schema) and carries the advisory op
 * bounds (maxInputChars/maxOutputTokens/retryLimit/privacy handles). Lookup is
 * total: unknown ids yield `undefined` and the orchestrator fails closed.
 *
 * Timeout values are the ENFORCED route budgets.
 *
 * `tryDeterministic` is the deterministic-first path: pure, synchronous, no
 * I/O. A resolved outcome lets `route` skip model runtimes entirely. Anything
 * it cannot decide returns `{ resolved: false }` and the model path runs.
 */
import type { AiTaskId, AiTaskSpec } from "../types";
import { isAiTaskId } from "../types";

export const TASK_IDS: readonly AiTaskId[] = [
  "classify-intent",
  "extract-report-fields",
  "extract-search-filters",
  "route-intent",
  "embed-texts",
  "classify-category",
];

const TEXT_PRIVACY = { tier: "local-only", handlesImage: false, handlesText: true } as const;
const NO_ROUTE_CONSENT = { required: false } as const;

const SPECS: Readonly<Record<AiTaskId, AiTaskSpec>> = {
  "classify-intent": {
    taskId: "classify-intent",
    maxBytes: 4_096,
    maxImages: 0,
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 5_000,
    schema: "classify-intent/v1",
    maxInputChars: 2000,
    maxOutputTokens: 256,
    retryLimit: 0,
    privacy: TEXT_PRIVACY,
    consent: NO_ROUTE_CONSENT,
  },
  "extract-report-fields": {
    taskId: "extract-report-fields",
    maxBytes: 8_192,
    maxImages: 0,
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 8_000,
    schema: "report-slots/v1",
    maxInputChars: 2000,
    maxOutputTokens: 256,
    retryLimit: 0,
    privacy: TEXT_PRIVACY,
    consent: NO_ROUTE_CONSENT,
  },
  "extract-search-filters": {
    taskId: "extract-search-filters",
    maxBytes: 4_096,
    maxImages: 0,
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 5_000,
    schema: "search-filters/v1",
    maxInputChars: 2000,
    maxOutputTokens: 256,
    retryLimit: 0,
    privacy: TEXT_PRIVACY,
    consent: NO_ROUTE_CONSENT,
  },
  "route-intent": {
    taskId: "route-intent",
    maxBytes: 4_096,
    maxImages: 0,
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 5_000,
    schema: "route-intent/v1",
    maxInputChars: 280,
    maxOutputTokens: 256,
    retryLimit: 0,
    privacy: TEXT_PRIVACY,
    consent: NO_ROUTE_CONSENT,
  },
  "embed-texts": {
    taskId: "embed-texts",
    maxBytes: 32_768,
    maxImages: 0,
    runtimes: ["local-embedding"],
    timeoutMs: 10_000,
    schema: "text-embeddings/v1",
    maxInputChars: 16_000,
    maxOutputTokens: 0,
    retryLimit: 0,
    privacy: TEXT_PRIVACY,
    consent: NO_ROUTE_CONSENT,
  },
  "classify-category": {
    taskId: "classify-category",
    maxBytes: 4_096,
    maxImages: 0,
    runtimes: ["deterministic-local", "local-text"],
    timeoutMs: 5_000,
    schema: "item-category/v1",
    maxInputChars: 280,
    maxOutputTokens: 256,
    retryLimit: 0,
    privacy: TEXT_PRIVACY,
    consent: NO_ROUTE_CONSENT,
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

function readText(input: unknown): string {
  if (typeof input === "string") return input;
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

const CATEGORY_KEYWORDS: ReadonlyArray<{ readonly match: RegExp; readonly category: string }> = [
  { match: /\b(wallet|keys|phone|bag|umbrella|backpack|laptop)\b/i, category: "accessories" },
  { match: /\b(dog|cat|parrot|pet)\b/i, category: "pets" },
  { match: /\b(passport|id card|license|document)\b/i, category: "documents" },
  { match: /\b(jacket|coat|shoe|hat|glove)\b/i, category: "clothing" },
];

/**
 * Pure deterministic rules, one per task that admits them. Embedding never
 * resolves here (it needs a runtime); text tasks resolve only on unambiguous
 * local signals and defer otherwise.
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
    case "embed-texts":
      return { resolved: false };
  }
}

/**
 * Local fallback surfaced (alongside the failure) when a model runtime fails.
 * The retained local tools have no model-free fallback: callers fail closed
 * and the ordinary non-AI path keeps working.
 */
export function fallbackFor(_taskId: AiTaskId, _input: unknown): unknown | undefined {
  return undefined;
}
