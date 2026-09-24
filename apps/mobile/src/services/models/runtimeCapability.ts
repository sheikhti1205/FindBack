/**
 * Runtime truthfulness for the model library.
 *
 * Catalogue membership, on-device installation, and executable runtime
 * support are three separate facts, and the library UI must never conflate
 * them: a listed entry is not necessarily downloadable, and a downloaded
 * entry is not necessarily runnable. This module derives both facts from
 * the shipped catalogue wiring without touching the native bridge:
 *
 * - `runtimeCapabilityForEntry`: whether this build has a wired executable
 *   runtime path for the entry — the SmolVLM2 500M entry via its dedicated
 *   `bridgeModelIdForEntry` mapping, plus the four experimental candidates
 *   via the candidate runtime (`CandidateRuntimeController`, once verified
 *   and made resident). Shipped entries with neither path are
 *   RUNTIME_UNAVAILABLE; ids outside the shipped catalogue are UNKNOWN
 *   (unverifiable from this layer, never assumed runnable).
 * - `availabilityForEntry`: the single display status for a card —
 *   CATALOG_ONLY, DOWNLOADABLE, UNPUBLISHED, INSTALLED, ACTIVE, or
 *   RUNTIME_UNAVAILABLE.
 */

import type { ModelCatalogueEntry } from "./catalogueTypes";
import type { VlmModelId } from "../vlmPlugin";
import {
  bridgeModelIdForEntry,
  hasUnpublishedDistribution,
  isExperimentalCandidateEntryId,
  SHIPPED_CATALOGUE_ENTRIES,
} from "./shippedCatalogue";

/** Whether this build can execute the entry. */
export type RuntimeCapability =
  | "RUNTIME_AVAILABLE"
  | "RUNTIME_UNAVAILABLE"
  | "UNKNOWN";

/**
 * Display status of a library entry. CATALOG_ONLY entries are reference
 * listings and never distributed; UNPUBLISHED entries are prepared but not
 * published in this build, so network download stays disabled;
 * RUNTIME_UNAVAILABLE entries are listed for reference but cannot run or be
 * activated in this build.
 */
export type ModelAvailability =
  | "CATALOG_ONLY"
  | "DOWNLOADABLE"
  | "UNPUBLISHED"
  | "INSTALLED"
  | "RUNTIME_UNAVAILABLE"
  | "ACTIVE";

/** Plain-language message for entries with no executable runtime. */
export const NO_RUNTIME_MESSAGE =
  "No executable runtime for this entry in this build. Listed for reference — it cannot run or be activated here." as const;

export interface AvailabilitySignals {
  /** Wired native runtime model id, or null when no runtime path exists. */
  bridgeId: VlmModelId | null;
  /** Whether the entry's model data is on device in an installed state. */
  installed: boolean;
  /** Whether the entry is the persisted active model. */
  isActive: boolean;
}

/**
 * Runtime capability for a catalogue entry id. RUNTIME_AVAILABLE covers the
 * dedicated SmolVLM2 image path and the four experimental candidates (each
 * owns a wired candidate runtime once verified and made resident); shipped
 * entries with neither path report RUNTIME_UNAVAILABLE, and unlisted ids
 * report UNKNOWN.
 */
export function runtimeCapabilityForEntry(entryId: string): RuntimeCapability {
  if (bridgeModelIdForEntry(entryId) != null) return "RUNTIME_AVAILABLE";
  // Experimental candidates own a wired candidate runtime once verified and
  // made resident; they are runnable in this build.
  if (isExperimentalCandidateEntryId(entryId)) return "RUNTIME_AVAILABLE";
  if (SHIPPED_CATALOGUE_ENTRIES.some((entry) => entry.id === entryId)) {
    return "RUNTIME_UNAVAILABLE";
  }
  return "UNKNOWN";
}

/**
 * Single display status for a library card. Catalogue reference comes
 * first (never distributed), then runtime absence (never runnable), then
 * the installed/active ladder for runtime-backed entries. A runtime-backed
 * entry whose distribution is not published reports UNPUBLISHED instead of
 * DOWNLOADABLE — installed/active entries keep their ladder status, since
 * the publication gate covers network download only, never install state.
 */
export function availabilityForEntry(
  entry: ModelCatalogueEntry,
  signals: AvailabilitySignals,
): ModelAvailability {
  if (entry.catalogOnly === true) return "CATALOG_ONLY";
  if (signals.bridgeId == null && !isExperimentalCandidateEntryId(entry.id)) {
    return "RUNTIME_UNAVAILABLE";
  }
  if (signals.isActive) return "ACTIVE";
  if (signals.installed) return "INSTALLED";
  if (hasUnpublishedDistribution(entry)) return "UNPUBLISHED";
  return "DOWNLOADABLE";
}

/** Display label for an availability status. */
export function availabilityLabel(status: ModelAvailability): string {
  switch (status) {
    case "CATALOG_ONLY":
      return "Catalog reference only";
    case "DOWNLOADABLE":
      return "Available to download";
    case "UNPUBLISHED":
      return "Unpublished";
    case "INSTALLED":
      return "Installed";
    case "RUNTIME_UNAVAILABLE":
      return "No executable runtime in this build";
    case "ACTIVE":
      return "Active";
  }
}

/** Whether the library may offer activation for the capability. */
export function canOfferActivation(capability: RuntimeCapability): boolean {
  return capability === "RUNTIME_AVAILABLE";
}
