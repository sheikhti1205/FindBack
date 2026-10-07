/**
 * Narrow op: embed-texts.
 *
 * Local-only preprocessing for retrieval embeddings: validates and
 * normalizes caller-supplied texts before they reach the on-device embedder.
 * No model call happens here, no consent flag is taken (texts never leave
 * the device), and nothing is persisted — the result is a validated request
 * envelope the caller may hand to the native embedding bridge. Pure.
 */
import { makeAiError, type AiResult } from "../types";

/** Retrieval purpose. Anything else is refused (invalid enum). */
export const EMBED_MODES = ["retrieval", "dedupe"] as const;
export type EmbedMode = (typeof EMBED_MODES)[number];

export function isEmbedMode(value: unknown): value is EmbedMode {
  return typeof value === "string" && (EMBED_MODES as readonly string[]).includes(value);
}

export const EMBED_MAX_TEXTS = 32;
export const EMBED_MAX_CHARS_PER_TEXT = 500;

export interface EmbedTextsInput {
  readonly texts: readonly string[];
  readonly mode?: EmbedMode;
}

export interface EmbedTextsRequest {
  readonly texts: readonly string[];
  readonly mode: EmbedMode;
}

export interface EmbedTextsOptions {
  readonly signal?: AbortSignal;
}

/**
 * Pure validator: shape (texts array of strings), enum (mode allowlist),
 * length (count and per-text bounds), business rules (no blank texts, no
 * exact duplicates — embedding the same text twice is caller error).
 */
export function validateEmbedTexts(input: unknown): AiResult<EmbedTextsRequest> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_EMBED_OBJECT") };
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["texts", "mode"].includes(key)) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_FIELD:embed:${key}`) };
    }
  }
  if (!Array.isArray(record["texts"])) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_FIELD:texts") };
  }
  const rawTexts = record["texts"];
  if (rawTexts.length === 0) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_EMPTY_TEXTS") };
  }
  if (rawTexts.length > EMBED_MAX_TEXTS) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_TOO_MANY_TEXTS") };
  }
  const texts: string[] = [];
  for (const item of rawTexts) {
    if (typeof item !== "string") {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BAD_FIELD:texts") };
    }
    const trimmed = item.trim();
    if (trimmed === "") {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R4_BLANK_TEXT") };
    }
    if (trimmed.length > EMBED_MAX_CHARS_PER_TEXT) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R5_FIELD_TOO_LONG:text") };
    }
    texts.push(trimmed);
  }
  const seen = new Set<string>();
  for (const text of texts) {
    const key = text.toLowerCase();
    if (seen.has(key)) {
      return { ok: false, error: makeAiError("INVALID_OUTPUT", "R1_BUSINESS_RULE:DUPLICATE_TEXT") };
    }
    seen.add(key);
  }
  const mode = record["mode"] ?? "retrieval";
  if (!isEmbedMode(mode)) {
    return { ok: false, error: makeAiError("INVALID_OUTPUT", `R1_UNKNOWN_MODE:${String(record["mode"])}`) };
  }
  return { ok: true, value: { texts, mode } };
}

export async function embedTextsOp(
  input: EmbedTextsInput,
  options?: EmbedTextsOptions,
): Promise<AiResult<EmbedTextsRequest>> {
  const signal = options?.signal;
  if (signal !== undefined && signal.aborted) {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_BEFORE_START") };
  }
  const validated = validateEmbedTexts(input);
  if (signal !== undefined && signal.aborted) {
    return { ok: false, error: makeAiError("CANCELLED", "ABORT_MID_GENERATION") };
  }
  return validated;
}

