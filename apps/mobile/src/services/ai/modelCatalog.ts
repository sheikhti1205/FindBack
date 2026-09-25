/**
 * Model catalogue parser for the official OpenRouter `GET /api/v1/models` response.
 *
 * Docs verified 2026-09-25:
 * `https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md`
 * Field names below mirror that schema exactly; nothing is guessed.
 *
 * Pricing semantics (per docs): `pricing.prompt` / `pricing.completion` are REQUIRED
 * USD-per-token decimal strings; every other fee is optional; top-level keys are the
 * default-condition prices; `pricing.overrides[]` entries apply only when ALL of their
 * condition fields match (`min_prompt_tokens` strictly-greater threshold, `utc_start` /
 * `utc_end` HHMM window, `utc_days`); later entries win per key; absent keys inherit
 * base. `discount` is an endpoint multiplier and is intentionally NOT folded into the
 * lines (exact decimal strings only, no float money math): the recorded base lines are
 * the default-condition prices, and a nonzero discount keeps the record out of `free`.
 * Display conversion (per 1M tokens) is exact string math in `formatPerMillionTokens`.
 *
 * `priceClass` is derived with the frozen `priceClassFromLines`: `free` only when every
 * line is zero (a `:free` id suffix alone proves nothing), `unknown` when required
 * pricing is missing/unparseable, `variable` when any line carries conditions.
 * `contextTokens` / `maxOutputTokens` / `maxImagesPerCall` stay `undefined` when absent:
 * the current API documents no per-call image-count field, so images are never invented.
 *
 * Pagination IS documented (`offset`/`limit`, max 1000, full list when both omitted,
 * plus `links.next` / `total_count`): parse one page per call and follow `getNextPageLink`.
 * No network here — fixtures only; fetching belongs to a later provider packet.
 */
import {
  isDecimalAmount,
  priceClassFromLines,
  type ModelRecord,
  type PriceLine,
} from "./providerContract";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models" as const;
export const OPENROUTER_MODELS_DOCS_URL =
  "https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md" as const;
export const OPENROUTER_MODELS_DOCS_RETRIEVED = "2026-09-25" as const;

/** Default catalogue freshness budget: 24h. */
export const CATALOG_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Raw pricing block straight from the API (all values unknown-shaped until validated). */
export type OpenRouterModelPricing = {
  readonly prompt?: unknown;
  readonly completion?: unknown;
  readonly image?: unknown;
  readonly image_output?: unknown;
  readonly image_token?: unknown;
  readonly audio?: unknown;
  readonly audio_output?: unknown;
  readonly input_audio_cache?: unknown;
  readonly request?: unknown;
  readonly web_search?: unknown;
  readonly internal_reasoning?: unknown;
  readonly input_cache_read?: unknown;
  readonly input_cache_write?: unknown;
  readonly input_cache_write_1h?: unknown;
  readonly discount?: unknown;
  readonly overrides?: unknown;
};

/** One raw model row straight from the API. Only documented fields are read. */
export type OpenRouterModel = {
  readonly id: string;
  readonly canonical_slug?: unknown;
  readonly name?: unknown;
  readonly created?: unknown;
  readonly description?: unknown;
  readonly context_length?: unknown;
  readonly architecture?: unknown;
  readonly pricing?: unknown;
  readonly top_provider?: unknown;
  readonly per_request_limits?: unknown;
  readonly alias_target?: unknown;
};

/** One page of the documented list response. */
export type OpenRouterModelsResponse = {
  readonly data: readonly OpenRouterModel[];
  readonly total_count: number;
  readonly links: { readonly next: string | null };
};

export type ParseCatalogOptions = {
  /** ISO timestamp stamped on every record; defaults to now. */
  readonly retrievedAt?: string;
  /** Model ids known-unusable for this account (e.g. provider-blocked). */
  readonly blockedIds?: readonly string[];
  /** Model ids positively verified usable for this account. */
  readonly verifiedIds?: readonly string[];
};

type FeeDef = { readonly key: string; readonly dimension: string; readonly unit: PriceLine["unit"] };

const BASE_FEES: readonly FeeDef[] = [
  { key: "prompt", dimension: "input", unit: "token" },
  { key: "completion", dimension: "output", unit: "token" },
  { key: "image", dimension: "image", unit: "image" },
  { key: "image_output", dimension: "image-output", unit: "image" },
  { key: "image_token", dimension: "image-tokens", unit: "token" },
  { key: "audio", dimension: "audio-input", unit: "token" },
  { key: "audio_output", dimension: "audio-output", unit: "token" },
  { key: "input_audio_cache", dimension: "audio-cache", unit: "token" },
  { key: "request", dimension: "request", unit: "request" },
  { key: "web_search", dimension: "web-search", unit: "request" },
  { key: "internal_reasoning", dimension: "reasoning", unit: "token" },
  { key: "input_cache_read", dimension: "cache-read", unit: "token" },
  { key: "input_cache_write", dimension: "cache-write", unit: "token" },
  { key: "input_cache_write_1h", dimension: "cache-write-1h", unit: "token" },
];

/** Override price keys use the same dimensions as base fees. */
const OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  "prompt",
  "completion",
  "audio",
  "input_audio_cache",
  "input_cache_read",
  "input_cache_write",
  "input_cache_write_1h",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/** Positive integers only; missing / non-finite / non-positive stays undefined (never 0). */
function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function describeOverrideConditions(entry: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const minTokens = entry["min_prompt_tokens"];
  if (typeof minTokens === "number" && Number.isFinite(minTokens)) {
    parts.push(`applies when prompt tokens > ${minTokens}`);
  }
  const start = entry["utc_start"];
  const end = entry["utc_end"];
  if (typeof start === "number" && typeof end === "number") {
    parts.push(`applies in UTC window [${start}, ${end})`);
  }
  const days = entry["utc_days"];
  if (Array.isArray(days) && days.length > 0 && days.every((d) => typeof d === "string")) {
    parts.push(`applies on ${(days as string[]).join(", ")}`);
  }
  if (parts.length === 0) return undefined;
  return parts.join("; ");
}

function parseOverrides(pricing: Record<string, unknown>): PriceLine[] {
  const raw = pricing["overrides"];
  if (!Array.isArray(raw)) return [];
  const lines: PriceLine[] = [];
  raw.forEach((item, index) => {
    const entry = asRecord(item);
    if (entry === null) return;
    const conditions = describeOverrideConditions(entry);
    for (const key of OVERRIDE_KEYS) {
      const amount = entry[key];
      if (!isDecimalAmount(amount)) continue;
      const def = BASE_FEES.find((fee) => fee.key === key);
      if (def === undefined) continue;
      lines.push({
        amountDecimal: amount,
        currency: "USD",
        unit: def.unit,
        dimension: def.dimension,
        ...(conditions === undefined ? {} : { conditions }),
        sourceField: `pricing.overrides[${index}].${key}`,
      });
    }
  });
  return lines;
}

function parsePrices(pricing: OpenRouterModelPricing | null): PriceLine[] {
  if (pricing === null) return [];
  const raw = pricing as Record<string, unknown>;
  // Required pair first: without both, the record is unknown (never guessed, never zero).
  const prompt = raw["prompt"];
  const completion = raw["completion"];
  if (!isDecimalAmount(prompt) || !isDecimalAmount(completion)) return [];
  const lines: PriceLine[] = [];
  for (const def of BASE_FEES) {
    const amount = raw[def.key];
    if (amount === undefined) continue;
    // Optional fees: invalid values are skipped, never coerced to zero.
    if (!isDecimalAmount(amount)) continue;
    lines.push({
      amountDecimal: amount,
      currency: "USD",
      unit: def.unit,
      dimension: def.dimension,
      sourceField: `pricing.${def.key}`,
    });
  }
  lines.push(...parseOverrides(raw));
  return lines;
}

function parseModalities(architecture: unknown, key: "input_modalities" | "output_modalities"): readonly string[] {
  const arch = asRecord(architecture);
  if (arch === null) return [];
  return asStringList(arch[key]);
}

/**
 * Parse one documented response page into records. Pure and single-pass so
 * 1000-row lists stay fast; throws nothing (malformed rows degrade to unknown,
 * a non-array `data` yields `[]`).
 */
export function parseModelCatalog(
  response: OpenRouterModelsResponse,
  options: ParseCatalogOptions = {},
): readonly ModelRecord[] {
  const data = Array.isArray(response?.data) ? response.data : [];
  const retrievedAt =
    typeof options.retrievedAt === "string" && options.retrievedAt.trim() !== ""
      ? options.retrievedAt
      : new Date().toISOString();
  const blocked = new Set(options.blockedIds ?? []);
  const verified = new Set(options.verifiedIds ?? []);
  return data.map((model) => {
    const id = typeof model?.id === "string" ? model.id : "";
    const pricing = asRecord(model?.pricing);
    const prices = parsePrices(pricing);
    const topProvider = asRecord(model?.top_provider);
    const limits = asRecord(model?.per_request_limits);
    const topContext = asPositiveInt(topProvider?.["context_length"]);
    const topMaxOut = asPositiveInt(topProvider?.["max_completion_tokens"]);
    const limitMaxOut = asPositiveInt(limits?.["completion_tokens"]);
    return {
      provider: "openrouter",
      id,
      input: parseModalities(model?.architecture, "input_modalities"),
      output: parseModalities(model?.architecture, "output_modalities"),
      ...(asPositiveInt(model?.context_length) !== undefined
        ? { contextTokens: asPositiveInt(model?.context_length) as number }
        : topContext !== undefined
          ? { contextTokens: topContext }
          : {}),
      ...(topMaxOut !== undefined
        ? { maxOutputTokens: topMaxOut }
        : limitMaxOut !== undefined
          ? { maxOutputTokens: limitMaxOut }
          : {}),
      prices,
      priceClass: priceClassFromLines(prices),
      retrievedAt,
      entitlement: blocked.has(id) ? ("blocked" as const) : verified.has(id) ? ("verified" as const) : ("untested" as const),
    } satisfies ModelRecord;
  });
}

/** True when the model accepts image input (unsupported vision stays explicit). */
export function supportsVision(record: ModelRecord): boolean {
  return record.input.includes("image");
}

/**
 * True when `retrievedAt` is older than `maxAgeMs` or unparseable.
 * Unparseable timestamps are stale (never treated as fresh).
 */
export function isCatalogStale(
  retrievedAt: string,
  nowMs: number = Date.now(),
  maxAgeMs: number = CATALOG_STALE_AFTER_MS,
): boolean {
  const parsed = Date.parse(retrievedAt);
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed > maxAgeMs;
}

/**
 * Exact USD-per-token → USD-per-1M-tokens decimal string (amount × 1,000,000)
 * with string math only — no float money math. Returns null for non-decimals.
 */
export function formatPerMillionTokens(amountDecimal: string): string | null {
  if (!isDecimalAmount(amountDecimal)) return null;
  const dot = amountDecimal.indexOf(".");
  const intPart = dot === -1 ? amountDecimal : amountDecimal.slice(0, dot);
  const fracPart = dot === -1 ? "" : amountDecimal.slice(dot + 1);
  const strip = (value: string): string => {
    const out = value.replace(/^0+(?=\d)/, "");
    return out === "" ? "0" : out;
  };
  if (fracPart.length <= 6) {
    return strip(intPart + fracPart.padEnd(6, "0"));
  }
  const head = fracPart.slice(0, 6);
  const tail = fracPart.slice(6).replace(/0+$/, "");
  const intOut = strip(intPart + head);
  return tail === "" ? intOut : `${intOut}.${tail}`;
}

/** Stable fingerprint of the priced surface; any fee change invalidates consent. */
export function priceFingerprint(record: ModelRecord): string {
  return JSON.stringify(
    record.prices.map((line) =>
      [line.dimension, line.amountDecimal, line.unit, line.conditions ?? "", line.sourceField].join("|"),
    ),
  );
}

/**
 * Documented pagination chain: the `links.next` path (`/api/v1/models?offset=…`),
 * or null on the last page. Callers fetch one page per call and follow this.
 */
export function getNextPageLink(response: OpenRouterModelsResponse): string | null {
  const next = response?.links?.next;
  return typeof next === "string" && next.trim() !== "" ? next : null;
}
