/**
 * Role-based model selection: preferred TEXT vs preferred IMAGE entries.
 *
 * The two preferences name catalogue entries; they are never resident
 * engines. Guard G7 still holds exactly one resident generative model at a
 * time: serving a role means switching residence through the shared
 * `planModelSwitch` sequence (cancel → release → verify-memory → init), so
 * needing text releases the image engine to load Qwen, and needing image
 * releases Qwen to load SmolVLM2. Cross-role routing (an image job sent to
 * the text entry, or a text job sent to the image entry) is refused here
 * with an explicit reason — never silently re-routed, never executed.
 *
 * Persistence is two `localStorage` preference keys plus the single
 * resident record shared with the library screen (`OfflineAi` reads and
 * writes the same key through the helpers below, so the value stays
 * identical). Every resolver fails closed: unknown ids, role mismatches,
 * catalogue-only, experimental, and incompatible entries all resolve to a
 * blocked reason and the caller keeps the deterministic grounded fallback.
 */

import type { ModelCatalogueEntry } from "./catalogueTypes";
import type { AvailableFreeRamMb } from "./ramPolicy";
import { planModelSwitch, type ModelSwitchStep } from "./modelSession";
import {
  runtimeCapabilityForEntry,
  type RuntimeCapability,
} from "./runtimeCapability";
import { SHIPPED_CATALOGUE_ENTRIES } from "./shippedCatalogue";
import {
  QWEN_TEXT_ENTRY_ID,
  runtimeCapabilityForTextEntry,
} from "./textRuntime";

/** Work role a caller needs served: on-device text answers or image analysis. */
export type ModelRole = "text" | "image";

/** Catalogue role string carried by text entries (today the Qwen candidates). */
export const TEXT_CATALOGUE_ROLE = "chat-text" as const;

/** Catalogue role string carried by image entries (today SmolVLM2). */
export const IMAGE_CATALOGUE_ROLE = "report-from-photo" as const;

/** Catalogue id of the default preferred TEXT entry (qualified Qwen pin). */
export const DEFAULT_TEXT_ENTRY_ID = QWEN_TEXT_ENTRY_ID;

/** Catalogue id of the default preferred IMAGE entry (SmolVLM2). */
export const DEFAULT_IMAGE_ENTRY_ID = "smolvlm2-500m-litert-int4" as const;

/** Preference key for the TEXT entry. Names an entry; never a resident engine. */
export const PREFERRED_TEXT_KEY = "findback:models:preferred-text-entry" as const;

/** Preference key for the IMAGE entry. Names an entry; never a resident engine. */
export const PREFERRED_IMAGE_KEY = "findback:models:preferred-image-entry" as const;

/**
 * Single resident record: the catalogue id of the resident generative
 * model, or null when idle. Same key the library screen persists on
 * verified activation; shared here so the assistant resolves the same
 * resident the library reports (never a second, silent "active" record).
 */
export const RESIDENT_ENTRY_KEY = "findback:offline-ai:active-model" as const;

/** Role an entry can serve, derived from its catalogue role string. */
export type EntryRole = "text" | "image" | "other";

/** Maps a catalogue entry to the role it can serve. Unknown roles serve neither. */
export function entryRole(entry: ModelCatalogueEntry): EntryRole {
  if (entry.role === TEXT_CATALOGUE_ROLE) return "text";
  if (entry.role === IMAGE_CATALOGUE_ROLE) return "image";
  return "other";
}

/** Default preferred entry id for a role. */
export function defaultEntryIdForRole(role: ModelRole): string {
  return role === "text" ? DEFAULT_TEXT_ENTRY_ID : DEFAULT_IMAGE_ENTRY_ID;
}

function preferenceKeyForRole(role: ModelRole): string {
  return role === "text" ? PREFERRED_TEXT_KEY : PREFERRED_IMAGE_KEY;
}

/** Stored preferred entry id for a role, or null when never chosen. */
export function loadPreferredEntryId(role: ModelRole): string | null {
  try {
    return localStorage.getItem(preferenceKeyForRole(role));
  } catch {
    return null;
  }
}

/** Preferred entry id with the built-in default when nothing is stored. */
export function resolvePreferredEntryId(role: ModelRole): string {
  return loadPreferredEntryId(role) ?? defaultEntryIdForRole(role);
}

/** Resident catalogue entry id, or null when idle or unreadable. */
export function loadResidentEntryId(): string | null {
  try {
    return localStorage.getItem(RESIDENT_ENTRY_KEY);
  } catch {
    return null;
  }
}

/** Records residence. Called only after verified runtime proof. */
export function saveResidentEntryId(id: string): void {
  try {
    localStorage.setItem(RESIDENT_ENTRY_KEY, id);
  } catch {
    /* private mode / storage disabled */
  }
}

export type RoleAssignmentResult =
  | { readonly ok: true; readonly entry: ModelCatalogueEntry }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates that `entryId` names an entry that may serve `role`.
 * Cross-role ids are refused explicitly; catalogue-only, experimental,
 * and incompatible entries can serve neither role.
 */
export function validateRoleAssignment(
  role: ModelRole,
  entryId: string,
  entries: readonly ModelCatalogueEntry[] = SHIPPED_CATALOGUE_ENTRIES,
): RoleAssignmentResult {
  const entry = entries.find((candidate) => candidate.id === entryId) ?? null;
  if (entry === null) {
    return {
      ok: false,
      reason: `No catalogue entry "${entryId}" is known here, so it cannot serve the ${role} role.`,
    };
  }
  const serves = entryRole(entry);
  if (serves !== role) {
    return {
      ok: false,
      reason:
        `Cross-role routing refused: "${entryId}" is an ${serves === "other" ? "unrouted" : serves} entry ` +
        `and cannot serve the ${role} role.`,
    };
  }
  if (entry.catalogOnly === true) {
    return {
      ok: false,
      reason: `Catalog reference only: "${entryId}" is not distributed via FindBack releases and cannot serve the ${role} role.`,
    };
  }
  if (entry.verificationStatus === "EXPERIMENTAL") {
    return {
      ok: false,
      reason: `Experimental eval-only entry: "${entryId}" is not offered for the ${role} role.`,
    };
  }
  if (entry.verificationStatus === "INCOMPATIBLE") {
    return {
      ok: false,
      reason: `Incompatible entry: "${entryId}" has no on-device runtime for the ${role} role.`,
    };
  }
  return { ok: true, entry };
}

export type SavePreferenceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Stores the preferred entry for a role. Cross-role and unrunnable ids
 * are refused and nothing is persisted on refusal.
 */
export function savePreferredEntryId(
  role: ModelRole,
  entryId: string,
  entries: readonly ModelCatalogueEntry[] = SHIPPED_CATALOGUE_ENTRIES,
): SavePreferenceResult {
  const assignment = validateRoleAssignment(role, entryId, entries);
  if (!assignment.ok) return { ok: false, reason: assignment.reason };
  try {
    localStorage.setItem(preferenceKeyForRole(role), entryId);
  } catch {
    return {
      ok: false,
      reason: "The preference could not be stored on this device. Nothing changed.",
    };
  }
  return { ok: true };
}

/**
 * Resolves the runnable entry for a role: stored preference, else the
 * built-in default. Fails closed — an invalid stored value blocks with a
 * reason (the caller keeps the grounded fallback) rather than silently
 * substituting another model.
 */
export function resolveEntryForRole(
  role: ModelRole,
  entries: readonly ModelCatalogueEntry[] = SHIPPED_CATALOGUE_ENTRIES,
  storedId: string | null = loadPreferredEntryId(role),
): RoleAssignmentResult {
  return validateRoleAssignment(role, storedId ?? defaultEntryIdForRole(role), entries);
}

export type RouteRoleResult =
  | { readonly ok: true; readonly entry: ModelCatalogueEntry }
  | { readonly ok: false; readonly reason: string };

/**
 * Refuses cross-role dispatch: `entry` serves `role` only when its
 * catalogue role matches. Image work sent to the text entry (and text
 * work sent to the image entry) is rejected, never executed.
 */
export function routeRoleRequest(
  role: ModelRole,
  entry: ModelCatalogueEntry,
): RouteRoleResult {
  if (entryRole(entry) !== role) {
    return {
      ok: false,
      reason:
        `Cross-role routing refused: "${entry.id}" cannot serve the ${role} role. ` +
        `Text stays on the preferred text entry; image work stays on the preferred image entry.`,
    };
  }
  return { ok: true, entry };
}

export interface RoleSwitchRequest {
  /** Role the caller needs served next. */
  role: ModelRole;
  /** Currently resident entry id, or null when idle. */
  currentResidentId: string | null;
  entries?: readonly ModelCatalogueEntry[];
  /** Stored preference override (tests/seams); defaults to the persisted preference. */
  preferredEntryId?: string | null;
  /** Passively observed free RAM (never an allocation probe). */
  availableFreeRamMb: AvailableFreeRamMb;
  /** Whether the advanced-confirmation gate was explicitly accepted. */
  advancedConfirmed: boolean;
  /** Real text-bridge probe; absent text runtime keeps text targets blocked. */
  textRuntimePresent: boolean;
}

export type RoleSwitchPlan =
  | {
      readonly blocked: false;
      readonly targetEntryId: string;
      readonly steps: readonly ModelSwitchStep[];
    }
  | { readonly blocked: true; readonly reason: string };

/**
 * Plans serving `role` under the single-resident invariant: resolves the
 * preferred entry, refuses cross-role targets, then delegates to the
 * shared switch planner (cancel → release → verify-memory → init). A text
 * need while the image model is resident plans a release-then-load of
 * Qwen; an image need while Qwen is resident plans the reverse. The plan
 * is data only — activation and its runtime-ready proof stay with the
 * existing activation layer.
 */
export function planRoleSwitch(request: RoleSwitchRequest): RoleSwitchPlan {
  const entries = request.entries ?? SHIPPED_CATALOGUE_ENTRIES;
  const storedId = request.preferredEntryId ?? loadPreferredEntryId(request.role);
  const resolved = resolveEntryForRole(request.role, entries, storedId);
  if (!resolved.ok) return { blocked: true, reason: resolved.reason };
  const routed = routeRoleRequest(request.role, resolved.entry);
  if (!routed.ok) return { blocked: true, reason: routed.reason };
  const capability: RuntimeCapability =
    request.role === "text"
      ? runtimeCapabilityForTextEntry(resolved.entry, request.textRuntimePresent)
      : runtimeCapabilityForEntry(resolved.entry.id);
  const plan = planModelSwitch({
    currentResidentId: request.currentResidentId,
    target: resolved.entry,
    availableFreeRamMb: request.availableFreeRamMb,
    advancedConfirmed: request.advancedConfirmed,
    runtimeCapability: capability,
  });
  if (plan.blocked) return { blocked: true, reason: plan.reason };
  return {
    blocked: false,
    targetEntryId: resolved.entry.id,
    steps: plan.steps,
  };
}
