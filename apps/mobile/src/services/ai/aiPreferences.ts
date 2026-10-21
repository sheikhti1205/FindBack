/**
 * Lane A: single account-scoped AI preference source of truth.
 *
 * Settings OWNS these four fields; every other surface borrows them:
 * - `assistantMode`: which transports the assistant may use.
 * - `preferredAssistantModel`: cloud model id, or null for Automatic (the
 *   safe `openrouter/free` free-only default — never a paid row).
 * - `photoEngine`: SmolVLM2 local-first with cloud fallback under
 *   `automatic`; hard transport pins under the `-only` values.
 * - `matchesEngine`: `use` by default; `needle` only when installed and
 *   verified (see `isNeedleSelectable`).
 *
 * Persistence is per account via `localStorage` (JSON, one key per
 * account): switching accounts never inherits another account's choices.
 * Unknown or corrupt stored values fall back to the safe defaults and are
 * never thrown, never guessed, never crossed between accounts. No key
 * material or secrets live here — preference ids only.
 *
 * Ownership contract:
 * - Settings (AiModels) reads AND writes this store.
 * - AiConnection accepts a persistent `selectedId` / `onSelectModel`
 *   binding built from this store (see `createAssistantModelBinding`), so a
 *   permitted choice genuinely changes that account's Assistant default.
 *   Paid-model consent + price-fingerprint gates still live in AiConnection
 *   and are never bypassed by this binding.
 * - Help keeps a session-only temporary override: it READS the persisted
 *   default (via `resolvePreferredModelId`) on load and never owns it.
 */

import { DEFAULT_MODEL_ID } from "./modelPolicy";
import type { NeedleEvidence } from "./uiGates";

/** Which transports the assistant may use for this account. */
export type AssistantModePreference = "automatic" | "on-device-only" | "cloud-only";

/** Which engine answers photo questions for this account. */
export type PhotoEnginePreference = "automatic" | "on-device-only" | "cloud-only";

/** Which engine powers structured matches for this account. */
export type MatchesEnginePreference = "use" | "needle";

export type AiPreferences = {
  readonly assistantMode: AssistantModePreference;
  /** Cloud model id, or null for Automatic (safe free-only default). */
  readonly preferredAssistantModel: string | null;
  readonly photoEngine: PhotoEnginePreference;
  readonly matchesEngine: MatchesEnginePreference;
};

/** Safe defaults: automatic engines, no pinned model (Automatic → free-only). */
export const AI_PREFERENCES_DEFAULTS: AiPreferences = {
  assistantMode: "automatic",
  preferredAssistantModel: null,
  photoEngine: "automatic",
  matchesEngine: "use",
} as const;

/**
 * Null `preferredAssistantModel` resolves here: the frozen free-only route.
 * Paid rows are never a fallback — they need explicit per-model consent.
 */
export const ASSISTANT_FALLBACK_MODEL_ID = DEFAULT_MODEL_ID;

export function aiPreferencesKey(accountId: string): string {
  const trimmed = (accountId ?? "").trim();
  return `findback.ai.preferences.v1.${trimmed === "" ? "local" : trimmed}`;
}

function isAssistantModePreference(value: unknown): value is AssistantModePreference {
  return value === "automatic" || value === "on-device-only" || value === "cloud-only";
}

function isPhotoEnginePreference(value: unknown): value is PhotoEnginePreference {
  return value === "automatic" || value === "on-device-only" || value === "cloud-only";
}

function isMatchesEnginePreference(value: unknown): value is MatchesEnginePreference {
  return value === "use" || value === "needle";
}

function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function sanitize(raw: unknown): AiPreferences {
  if (typeof raw !== "object" || raw === null) return { ...AI_PREFERENCES_DEFAULTS };
  const candidate = raw as Record<string, unknown>;
  return {
    assistantMode: isAssistantModePreference(candidate["assistantMode"])
      ? candidate["assistantMode"]
      : AI_PREFERENCES_DEFAULTS.assistantMode,
    preferredAssistantModel: isModelId(candidate["preferredAssistantModel"])
      ? (candidate["preferredAssistantModel"] as string)
      : null,
    photoEngine: isPhotoEnginePreference(candidate["photoEngine"])
      ? candidate["photoEngine"]
      : AI_PREFERENCES_DEFAULTS.photoEngine,
    matchesEngine: isMatchesEnginePreference(candidate["matchesEngine"])
      ? candidate["matchesEngine"]
      : AI_PREFERENCES_DEFAULTS.matchesEngine,
  };
}

/**
 * Map the legacy AiModels assistant-mode vocabulary onto the preference
 * vocabulary for first-run seeding: Auto → automatic, Cloud-only →
 * cloud-only, Offline-first/Offline-only → on-device-only. Unknown values
 * stay on the safe `automatic` default.
 */
export function legacyAssistantModeToPreference(mode: unknown): AssistantModePreference {
  if (mode === "cloud-only") return "cloud-only";
  if (mode === "offline-first" || mode === "offline-only") return "on-device-only";
  return "automatic";
}

/**
 * Reverse map: preference vocabulary back onto the legacy assistant-mode
 * vocabulary that the retired local assistant gate used to switch on.
 * `on-device-only` maps to `offline-only` (fail closed: cloud sends stay
 * blocked); `automatic`/`cloud-only` map to `auto`/`cloud-only`.
 *
 * The consumer Chat surface is cloud-only and no longer reads a mode; the
 * mapping survives only for the legacy local-assistant paths that still
 * consult the store.
 */
export function preferenceToAssistantMode(
  mode: AssistantModePreference,
): "auto" | "offline-only" | "cloud-only" {
  if (mode === "cloud-only") return "cloud-only";
  if (mode === "on-device-only") return "offline-only";
  return "auto";
}

/**
 * Legacy key format (mirrors `assistantModeKey` in screens/AiModels, which
 * stays the migration-source reader). Kept here so the seeded read below
 * never imports the screens layer (no UI ↔ store cycle).
 */
function legacyAssistantModeKey(accountId: string): string {
  return `findback.ai.assistantMode.v1.${accountId}`;
}

/**
 * Single authoritative read: this account's preferences, with a one-time
 * migration that adopts the legacy assistant-mode key when the new store
 * has never been written for this account. After that first adoption the
 * legacy key is never consulted again for this account (the new store is
 * present), and production code must never write the legacy key.
 */
export function loadSeededAiPreferences(accountId: string): AiPreferences {
  const current = loadAiPreferences(accountId);
  try {
    if (globalThis.localStorage?.getItem(aiPreferencesKey(accountId)) !== null) {
      return current;
    }
    const legacyRaw = globalThis.localStorage?.getItem(legacyAssistantModeKey(accountId)) ?? null;
    if (legacyRaw === null) return current;
    return saveAiPreferences(accountId, {
      ...current,
      assistantMode: legacyAssistantModeToPreference(legacyRaw),
    });
  } catch {
    return current;
  }
}

/**
 * The mode value the retired local-assistant gate switched on: the seeded
 * authoritative preference mapped back onto the gate vocabulary. Safe by
 * construction — unknown/corrupt storage reads as `auto` (local-first
 * default), cloud-only consent semantics unchanged.
 */
export function loadEffectiveAssistantMode(
  accountId: string,
): "auto" | "offline-only" | "cloud-only" {
  return preferenceToAssistantMode(loadSeededAiPreferences(accountId).assistantMode);
}

/** Read this account's preferences; unknown/corrupt storage yields safe defaults. */
export function loadAiPreferences(accountId: string): AiPreferences {  try {
    const raw = globalThis.localStorage?.getItem(aiPreferencesKey(accountId)) ?? null;
    if (raw === null) return { ...AI_PREFERENCES_DEFAULTS };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...AI_PREFERENCES_DEFAULTS };
  }
}

/** Persist this account's full preferences; returns what was stored. */
export function saveAiPreferences(accountId: string, prefs: AiPreferences): AiPreferences {
  const next = sanitize(prefs);
  try {
    globalThis.localStorage?.setItem(aiPreferencesKey(accountId), JSON.stringify(next));
  } catch {
    // Persistence is best effort; the in-memory choice still applies.
  }
  return next;
}

/** Merge a partial update into this account's preferences and persist it. */
export function updateAiPreferences(
  accountId: string,
  patch: Partial<AiPreferences>,
): AiPreferences {
  return saveAiPreferences(accountId, { ...loadSeededAiPreferences(accountId), ...patch });
}

/** Clear this account's preferences back to the safe defaults. */
export function resetAiPreferences(accountId: string): AiPreferences {
  return saveAiPreferences(accountId, { ...AI_PREFERENCES_DEFAULTS });
}

/**
 * The photo engine a send must actually honor for this account: the
 * assistant mode is authoritative, so `on-device-only` forbids the photo
 * cloud fallback and `cloud-only` skips local inference. Under `automatic`
 * the account's own `photoEngine` choice applies (local-first with consented
 * fallback). Keeps UI consent copy and the real transport in agreement.
 */
export function effectivePhotoEngine(accountId: string): PhotoEnginePreference {
  const prefs = loadSeededAiPreferences(accountId);
  if (prefs.assistantMode === "on-device-only") return "on-device-only";
  if (prefs.assistantMode === "cloud-only") return "cloud-only";
  return prefs.photoEngine;
}

/**
 * Resolve the effective Assistant model id: the persisted choice, or null
 * (Automatic) → the safe free-only route. Help reads this for its
 * session-only override seed; Settings writes the underlying choice.
 */
export function resolvePreferredModelId(prefs: AiPreferences): string {
  const id = prefs.preferredAssistantModel;
  return id !== null && id.trim() !== "" ? id : ASSISTANT_FALLBACK_MODEL_ID;
}

/**
 * True only when Needle output was really measured, correctness-passing,
 * and fresh. Settings enables the `needle` matches-engine option only then;
 * anything less keeps the safe `use` default.
 */
export function isNeedleSelectable(evidence: NeedleEvidence | null | undefined): boolean {
  return (
    evidence !== null &&
    evidence !== undefined &&
    evidence.measured === true &&
    evidence.correctnessPass === true &&
    evidence.fresh === true
  );
}

export type AssistantModelBinding = {
  /** The persisted default for this account (null = Automatic). */
  readonly selectedId: string | null;
  /** Persist a permitted model choice for this account. Never crosses accounts. */
  readonly onSelectModel: (modelId: string) => void;
};

/**
 * Settings-owned AiConnection binding: `selectedId` reads this account's
 * persisted Assistant default and `onSelectModel` writes it. Wire both
 * straight into AiConnection's `selectedId` / `onSelectModel` props — the
 * consent/entitlement gates inside AiConnection still decide whether a tap
 * reaches this writer, so paid-model consent + price-fingerprint rules are
 * preserved.
 */
export function createAssistantModelBinding(accountId: string): AssistantModelBinding {
  return {
    selectedId: loadSeededAiPreferences(accountId).preferredAssistantModel,
    onSelectModel: (modelId: string) => {
      if (!isModelId(modelId)) return;
      updateAiPreferences(accountId, { preferredAssistantModel: modelId });
    },
  };
}
