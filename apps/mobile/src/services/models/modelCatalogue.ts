/**
 * Curated Model Library catalogue helpers.
 *
 * Pure selection/label logic over {@link ModelCatalogueEntry}. No fetching,
 * no downloading, no runtime integration — the downloader/importer and the
 * native runtime wiring are explicitly later tasks. The app ships a pinned
 * `catalogue.v1.json` build; this module never consults a mutable remote list.
 */

import {
  CATEGORY_ORDER,
  type ModelCatalogueEntry,
  type VerificationStatus,
} from "./catalogueTypes";

/**
 * Display label for a catalogue license id, recorded as published by the
 * rights holder (never normalized: LFM entries are NOT Apache).
 */
export function licenseLabel(license: string): string {
  switch (license) {
    case "apache-2.0":
      return "Apache License 2.0";
    case "lfm-open-1.0":
      return "LFM Open License v1.0";
    case "gemma":
      return "Gemma Terms of Use (gated)";
    default:
      return license;
  }
}

/** Display label for a verification status. */
export function verificationLabel(status: VerificationStatus): string {
  switch (status) {
    case "VERIFIED":
      return "Verified";
    case "SUPPORTED_UNVERIFIED":
      return "Supported (unverified)";
    case "EXPERIMENTAL":
      return "Experimental";
    case "INCOMPATIBLE":
      return "Incompatible";
  }
}

/**
 * Whether the library may offer an install affordance for the entry.
 *
 * A catalogue entry may be offered for installation when it has exact sizes.
 * The transfer gate independently requires a source-specific trusted hash and
 * refuses an unpublished release. Installability does not imply device support.
 */
export function isInstallable(entry: ModelCatalogueEntry): boolean {
  if (entry.catalogOnly === true) return false;
  if (entry.verificationStatus === "INCOMPATIBLE") return false;
  if (entry.downloadBytes == null || entry.installedBytes == null) return false;
  return true;
}

/**
 * Human-readable warnings derived from entry flags (presentation only).
 * The entry `description` carries the evidence detail; these are the banners.
 */
export function catalogueWarnings(entry: ModelCatalogueEntry): string[] {
  const warnings: string[] = [];
  if (entry.catalogOnly === true) {
    warnings.push(
      "Catalog reference only — not distributed via FindBack releases in v1.",
    );
  }
  if (entry.verificationStatus === "EXPERIMENTAL") {
    warnings.push(
      "Not verified on FindBack. Listed for reference or evaluation only.",
    );
  } else if (entry.verificationStatus === "SUPPORTED_UNVERIFIED") {
    warnings.push(
      "Supported but unverified: bytes and revision are pinned from lab evidence, not from a release checksum.",
    );
  }
  if (entry.category === "experimental-large") {
    warnings.push(
      "Large-model minimum free RAM figure is a conservative estimate, not a measurement.",
    );
  }
  return warnings;
}

/**
 * Exact on-device warning for entries without on-device verification.
 * Shown on large untested models (and any entry whose verification was not
 * established on this device); proceeding requires explicit confirmation.
 */
export const NOT_VERIFIED_ON_DEVICE_WARNING =
  "Not verified on this device. May fail on devices with limited free memory." as const;

/**
 * Whether the entry must carry the on-device warning: every entry whose
 * verification status is anything other than VERIFIED (lab-pinned,
 * experimental, or large reference entries). VERIFIED entries were measured
 * against the shipped pin and need no device caveat.
 */
export function needsOnDeviceWarning(entry: ModelCatalogueEntry): boolean {
  if (entry.category === "experimental-large") return true;
  return (
    entry.verificationStatus === "SUPPORTED_UNVERIFIED" ||
    entry.verificationStatus === "EXPERIMENTAL"
  );
}

/** Finds an entry by id, or null when absent. */
export function getEntryById(
  entries: readonly ModelCatalogueEntry[],
  id: string,
): ModelCatalogueEntry | null {
  const found = entries.find((entry) => entry.id === id);
  return found ?? null;
}

/**
 * Entries ordered for library display: `CATEGORY_ORDER`, then display name.
 * Returns a new array; the input is never mutated.
 */
export function listByCategory(
  entries: readonly ModelCatalogueEntry[],
): ModelCatalogueEntry[] {
  const rank = new Map(CATEGORY_ORDER.map((category, index) => [category, index]));
  return [...entries].sort((a, b) => {
    const categoryRank =
      (rank.get(a.category) ?? CATEGORY_ORDER.length) -
      (rank.get(b.category) ?? CATEGORY_ORDER.length);
    if (categoryRank !== 0) return categoryRank;
    return a.displayName.localeCompare(b.displayName);
  });
}
