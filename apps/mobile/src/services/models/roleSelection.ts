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
import { SHIPPED_CATALOGUE_ENTRIES, isExperimentalCandidateEntryId } from "./shippedCatalogue";
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

/** Drops the resident record. Called only by the native-truth reconcile pass. */
export function clearResidentEntryId(): void {
  try {
    localStorage.removeItem(RESIDENT_ENTRY_KEY);
  } catch {
    /* private mode / storage disabled */
  }
}

/**
 * Genuine native residency truth (entry-id space) for reconciling the stored
 * web resident record. Built by callers from `getCandidateActive` and
 * `getTextRuntimeStatus`; the `*Known` flags distinguish "read and empty"
 * (honest clear) from "unreadable" (keep — an older native or web build can
 * never disprove the stored claim).
 */
export interface NativeResidentTruth {
  /** Persisted native candidate selection pointer, or null. */
  readonly candidateSelected: string | null;
  /** Genuinely resident initialized candidate engine, or null. */
  readonly candidateResident: string | null;
  /** Whether that candidate engine is genuinely initialized. */
  readonly candidateInitialized: boolean;
  /** Genuine native text resident as an entry id (Qwen or candidate), or null. */
  readonly textResidentEntryId: string | null;
  /** The native text-status read succeeded. */
  readonly textStatusKnown: boolean;
  /** The native candidate-active read succeeded. */
  readonly candidateStatusKnown: boolean;
}

export interface ResidentReconcileDecision {
  /** The honest resident after reconciliation: native truth, never a stale pointer. */
  readonly effectiveResidentId: string | null;
  /** Whether the stored web record must be cleared. */
  readonly clearStored: boolean;
}

/**
 * Reconciles a stored web resident claim against genuine native residency.
 * Pure: no storage access, so callers apply the decision with a re-read
 * guard (see `syncStoredResidentId`).
 *
 * - Unknown truth (both reads failed): keep — nothing is disproved.
 * - Stored equals the single genuine native resident: keep.
 * - Stored candidate without genuine candidate residence: clear (pointer is
 *   never proof — cold restart, delete, release, verify-evict).
 * - Stored entry replaced by another genuine resident: adopt the native
 *   resident and clear (single-resident invariant evicted the stored entry).
 * - Stored dedicated entry with no genuine resident anywhere: keep (restart
 *   transient; consumers fail closed on readiness separately).
 */
export function reconcileStoredResidentId(
  storedId: string | null,
  truth: NativeResidentTruth,
): ResidentReconcileDecision {
  if (storedId == null) return { effectiveResidentId: null, clearStored: false };
  const candidateGenuine =
    truth.candidateStatusKnown &&
    truth.candidateInitialized &&
    truth.candidateResident != null
      ? truth.candidateResident
      : null;
  const textGenuine = truth.textStatusKnown ? truth.textResidentEntryId : null;
  if (!truth.candidateStatusKnown && !truth.textStatusKnown) {
    return { effectiveResidentId: storedId, clearStored: false };
  }
  const genuine = candidateGenuine ?? textGenuine;
  if (genuine === storedId) return { effectiveResidentId: storedId, clearStored: false };
  if (genuine != null) return { effectiveResidentId: genuine, clearStored: true };
  if (isExperimentalCandidateEntryId(storedId) && truth.candidateStatusKnown) {
    return { effectiveResidentId: null, clearStored: true };
  }
  return { effectiveResidentId: storedId, clearStored: false };
}

export interface ResidentStoreSeam {
  load(): string | null;
  clear(): void;
}

/**
 * Applies the reconcile decision to storage with compare-and-clear: the
 * stored value is re-read and cleared only when it still equals the decided
 * value, so a newer choice written concurrently is never clobbered. Returns
 * the honest effective resident (the newer choice when one won the race).
 */
export function syncStoredResidentId(
  truth: NativeResidentTruth,
  store: ResidentStoreSeam = { load: loadResidentEntryId, clear: clearResidentEntryId },
): string | null {
  const stored = store.load();
  const decision = reconcileStoredResidentId(stored, truth);
  if (!decision.clearStored) return decision.effectiveResidentId;
  const reread = store.load();
  if (reread !== stored) return reread;
  store.clear();
  return decision.effectiveResidentId;
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
