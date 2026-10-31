/**
 * Lane A: single account-scoped AI preference source of truth.
 *
 * Legacy stored fields retained for upgrade compatibility:
 * - `assistantMode`: legacy persisted transport preference, not an active local assistant.
 * - `preferredAssistantModel`: cloud model id, or null for Automatic (the
 *   safe `openrouter/free` free-only default — never a paid row).
 * - `photoEngine`: legacy persisted preference, not an active photo tool.
 * - `matchesEngine`: `use` by default; `needle` only when installed and
 *   verified by the application model lifecycle before use.
 *
 * Persistence is per account via `localStorage` (JSON, one key per
 * account): switching accounts never inherits another account's choices.
 * Unknown or corrupt stored values fall back to the safe defaults and are
 * never thrown, never guessed, never crossed between accounts. No key
 * material or secrets live here — preference ids only.
 *
 * Legacy preference compatibility and retained matching choices live here.
 * Consumer cloud Chat/provider defaults are owned by cloudModelPreferences;
 * the retired local assistant UI must not be imported to read old choices.
 */

/** Legacy serialized transport value; never an executable routing policy. */
export type AssistantModePreference = "automatic" | "on-device-only" | "cloud-only";

/** Legacy serialized photo preference; no active photo engine consumes it. */
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
 * Original migration-source key. No production writer: the seeded read below
 * adopts it once into the account preference store without importing UI.
 */
export function legacyAssistantModeKey(accountId: string): string {
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
