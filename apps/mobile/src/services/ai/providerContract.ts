/**
 * Shared provider-independent AI contract.
 *
 * This file freezes the cross-provider task/request/memory shapes that later
 * packets build on. It is intentionally free of networking, storage, and
 * provider-specific behavior: no fetch, no endpoint strings, no model
 * identifiers, no credentials.
 *
 * Archived narrow-operation vocabulary (intents, actions, validators) lives in
 * `services/ai/types.ts` and is not redefined here. The `maxOutputTokens`
 * field name below overlaps with that file's narrow-op transport options by
 * name only; the structs are distinct (provider preflight bound vs narrow-op
 * transport knob).
 */

export type ProviderId = "openrouter" | "openai" | "anthropic" | "google" | "deepseek";

export type TaskScope =
  | "general"
  | "app-help"
  | "search-intent"
  | "report-draft"
  | "image-question"
  | "history-compaction";

export type PriceClass = "free" | "paid" | "unknown" | "variable";

export type PriceLine = {
  amountDecimal: string;
  currency: "USD";
  unit:
    | "token"
    | "million_tokens"
    | "request"
    | "image"
    | "megapixel"
    | "minute"
    | "second"
    | "other";
  dimension: string;
  conditions?: string;
  sourceField: string;
};

export type ModelRecord = {
  provider: ProviderId;
  id: string;
  input: readonly string[];
  output: readonly string[];
  contextTokens?: number;
  maxOutputTokens?: number;
  maxImagesPerCall?: number;
  prices: readonly PriceLine[];
  priceClass: PriceClass;
  retrievedAt: string;
  entitlement: "verified" | "blocked" | "untested";
};

export type PaidConsent = {
  provider: ProviderId;
  modelId: string;
  fingerprint: string;
  taskScopes: readonly TaskScope[];
  acceptedAt: string;
};

export type AiSelection = {
  accountId: string;
  provider: ProviderId;
  modelId: string;
  mode: "free-only" | "paid-explicit";
  paidConsent?: PaidConsent;
};

export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachmentIds: readonly string[];
  createdAt: string;
};

export type ChatCheckpoint = {
  schemaVersion: number;
  coveredThroughTurnId: string;
  sourceTurnIds: readonly string[];
  summaryText: string;
  generatedBy: "local-extractive" | "consented-provider";
  estimatedTokens: number;
  updatedAt: string;
};

export type NormalizedRequest = {
  selection: AiSelection;
  task: TaskScope;
  policyVersion: string;
  knowledgeVersion: string;
  summary?: ChatCheckpoint;
  recentTurns: readonly ChatTurn[];
  currentText: string;
  approvedImageIds: readonly string[];
  authorizedResultIds: readonly string[];
  maxOutputTokens: number;
  signal: AbortSignal;
};

/** Observable stream phases. Attempts beyond the first are retries. */
export type StreamPhase =
  | "queued"
  | "sending"
  | "first-token"
  | "streaming"
  | "retrying"
  | "complete"
  | "failed"
  | "cancelled";

/**
 * Provider-neutral stream events. Every variant carries `attempt` so partial
 * outputs from separate attempts stay separately attributable.
 */
export type StreamEvent =
  | { readonly kind: "phase"; readonly phase: StreamPhase; readonly attempt: number; readonly message?: string }
  | { readonly kind: "text"; readonly attempt: number; readonly delta: string }
  | { readonly kind: "usage"; readonly attempt: number; readonly inputTokens?: number; readonly outputTokens?: number }
  | {
      readonly kind: "error";
      readonly attempt: number;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly kind: "done"; readonly attempt: number; readonly stopReason: "complete" | "cancelled" | "error" };

/**
 * Opaque per-account/per-provider credential handle. `handle` is a storage
 * reference resolved via the secure vault by the adapter; it is never key
 * material and no struct in this file carries key material.
 */
export type CredentialHandle = {
  readonly accountId: string;
  readonly provider: ProviderId;
  readonly handle: string;
};

/** One capability slot: a known value or an explicit unknown. */
export type CapabilityValue<T> = { readonly state: "known"; readonly value: T } | { readonly state: "unknown" };

/**
 * Provider capabilities. Unknown stays unknown: callers must take a
 * conservative path, never assume a zero or a free default.
 */
export type ProviderCapabilities = {
  readonly vision: CapabilityValue<boolean>;
  readonly maxImagesPerCall: CapabilityValue<number>;
  readonly contextTokens: CapabilityValue<number>;
  readonly maxOutputTokens: CapabilityValue<number>;
  readonly streaming: CapabilityValue<boolean>;
};

/**
 * Minimal provider adapter surface. Adapters resolve their credential via a
 * `CredentialHandle` through the vault; `complete` receives only id
 * references (never image bytes or keys) inside `NormalizedRequest`.
 */
export type ProviderAdapter = {
  readonly id: ProviderId;
  capabilities(): ProviderCapabilities;
  listModels?(signal?: AbortSignal): Promise<readonly ModelRecord[]>;
  complete(request: NormalizedRequest): AsyncIterable<StreamEvent>;
};

/** Current per-chat checkpoint schema version. */
export const CHAT_CHECKPOINT_SCHEMA_VERSION = 1 as const;

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

/** True for canonical non-negative decimal strings (`0`, `0.00`, `1.25`). */
export function isDecimalAmount(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

function isZeroDecimal(value: string): boolean {
  for (const ch of value) {
    if (ch !== "0" && ch !== ".") return false;
  }
  return value.length > 0;
}

/** True only for the `free` price class. */
export function isFreeClass(priceClass: PriceClass): boolean {
  return priceClass === "free";
}

/**
 * Derive a price class from raw price lines:
 * empty or malformed input is `unknown`; any pricing condition is
 * `variable`; all-explicit-zero is `free`; otherwise `paid`.
 */
export function priceClassFromLines(lines: readonly PriceLine[]): PriceClass {
  if (lines.length === 0) return "unknown";
  for (const entry of lines) {
    if (!isDecimalAmount(entry.amountDecimal)) return "unknown";
  }
  for (const entry of lines) {
    if (entry.conditions !== undefined && entry.conditions.trim() !== "") return "variable";
  }
  let allZero = true;
  for (const entry of lines) {
    if (!isZeroDecimal(entry.amountDecimal)) {
      allZero = false;
      break;
    }
  }
  return allZero ? "free" : "paid";
}

/**
 * Resolve the verified context window. Missing, non-finite, or non-positive
 * values stay `undefined` (unknown) and are never coerced to zero.
 */
export function resolveContextTokens(record: ModelRecord): number | undefined {
  const raw = record.contextTokens;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.floor(raw);
}

/**
 * Authorize a selection against a resolved model record and the current price
 * fingerprint for the requested task. Anything other than `free` requires
 * `paid-explicit` mode plus a consent that matches provider, model,
 * fingerprint, and task scope. Selection/record mismatches are rejected.
 */
export function isSelectionAuthorized(
  selection: AiSelection,
  record: ModelRecord,
  priceFingerprint: string,
  task: TaskScope,
): boolean {
  if (selection.provider !== record.provider || selection.modelId !== record.id) return false;
  if (record.priceClass === "free") return true;
  if (selection.mode !== "paid-explicit") return false;
  const consent = selection.paidConsent;
  if (consent === undefined) return false;
  if (consent.provider !== selection.provider || consent.modelId !== selection.modelId) return false;
  if (consent.fingerprint !== priceFingerprint) return false;
  if (consent.acceptedAt.trim() === "") return false;
  return consent.taskScopes.includes(task);
}

/** Validate the runtime shape of a per-chat compaction checkpoint. */
export function isChatCheckpoint(value: unknown): value is ChatCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate["schemaVersion"] !== CHAT_CHECKPOINT_SCHEMA_VERSION) return false;
  const covered = candidate["coveredThroughTurnId"];
  if (typeof covered !== "string" || covered.trim() === "") return false;
  const sources = candidate["sourceTurnIds"];
  if (!Array.isArray(sources) || sources.length === 0) return false;
  for (const entry of sources) {
    if (typeof entry !== "string" || entry.trim() === "") return false;
  }
  if (!sources.includes(covered)) return false;
  if (typeof candidate["summaryText"] !== "string" || candidate["summaryText"].trim() === "")
    return false;
  const generatedBy = candidate["generatedBy"];
  if (generatedBy !== "local-extractive" && generatedBy !== "consented-provider") return false;
  const estimated = candidate["estimatedTokens"];
  if (typeof estimated !== "number" || !Number.isFinite(estimated) || estimated < 0) return false;
  return typeof candidate["updatedAt"] === "string" && candidate["updatedAt"].trim() !== "";
}

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  "selection",
  "task",
  "policyVersion",
  "knowledgeVersion",
  "summary",
  "recentTurns",
  "currentText",
  "approvedImageIds",
  "authorizedResultIds",
  "maxOutputTokens",
  "signal",
]);

const SELECTION_KEYS: ReadonlySet<string> = new Set([
  "accountId",
  "provider",
  "modelId",
  "mode",
  "paidConsent",
]);

function isReferenceId(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("data:")) return false;
  if (lower.includes("base64,")) return false;
  return !/\s/.test(trimmed);
}

/**
 * Confirm a request carries only id references: no extra top-level or
 * selection keys (where smuggled credential fields would hide) and no inline
 * data-URL payloads in any id list. Returns false for anything suspicious.
 */
export function hasNoInlineImageBytesOrKeys(request: NormalizedRequest): boolean {
  const topKeys = Object.keys(request as unknown as Record<string, unknown>);
  for (const key of topKeys) {
    if (!REQUEST_KEYS.has(key)) return false;
  }
  const selectionKeys = Object.keys(request.selection as unknown as Record<string, unknown>);
  for (const key of selectionKeys) {
    if (!SELECTION_KEYS.has(key)) return false;
  }
  for (const id of request.approvedImageIds) {
    if (!isReferenceId(id)) return false;
  }
  for (const id of request.authorizedResultIds) {
    if (!isReferenceId(id)) return false;
  }
  for (const turn of request.recentTurns) {
    for (const id of turn.attachmentIds) {
      if (!isReferenceId(id)) return false;
    }
  }
  return true;
}
