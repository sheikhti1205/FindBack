/**
 * Model Library RAM policy.
 *
 * Pure presentation rules from `docs/specs/model-library/ram-ui.md`. No
 * enforcement, no native wiring, no allocation probes: callers pass a
 * passively observed `availableFreeRamMb` reading (or null when unknown) and
 * these helpers derive labels, bands, and gate triggers only.
 */

import type { ModelCatalogueEntry, RamRequirementSource } from "./catalogueTypes";

/** Passively observed free RAM in MiB, or null when not yet read. */
export type AvailableFreeRamMb = number | null;

/** Source-chip label for the RAM requirement provenance. */
export function ramSourceChip(source: RamRequirementSource): string {
  switch (source) {
    case "MEASURED":
      return "Measured on-device";
    case "VENDOR":
      return "Vendor figure";
    case "CONSERVATIVE_ESTIMATE":
      return "Conservative estimate";
  }
}

/**
 * Formats a RAM figure as `~X GB` (MiB / 1024, one decimal), e.g. 1536 →
 * "~1.5 GB". Matches the ram-ui.md formatting rule.
 */
export function formatRamGb(ramMb: number): string {
  return `~${(ramMb / 1024).toFixed(1)} GB`;
}

/** Presentation band for an entry at the current available reading. */
export type RamBand = "OK" | "TIGHT" | "BELOW_MIN" | "UNKNOWN";

export function getRamBand(
  entry: ModelCatalogueEntry,
  availableFreeRamMb: AvailableFreeRamMb,
): RamBand {
  if (availableFreeRamMb == null) return "UNKNOWN";
  if (availableFreeRamMb < entry.minFreeRamMb) return "BELOW_MIN";
  if (availableFreeRamMb < entry.recommendedFreeRamMb) return "TIGHT";
  return "OK";
}

/** Short human note for a band (presentation only, no enforcement). */
export function ramBandNote(band: RamBand): string | null {
  switch (band) {
    case "TIGHT":
      return "Below recommended — may be slow or evicted under memory pressure.";
    case "BELOW_MIN":
      return "Below minimum free RAM — advanced confirmation is required.";
    case "OK":
    case "UNKNOWN":
      return null;
  }
}

/**
 * Whether attempting install/run must go through the below-minimum
 * advanced-confirmation gate (ram-ui.md §3, DESIGNED here — enforcement and
 * persistence are later tasks). True when the reading is below minimum, or
 * for any run of a `catalogOnly` large entry. Unknown readings never trigger
 * the gate on their own.
 */
export function needsAdvancedConfirm(
  entry: ModelCatalogueEntry,
  availableFreeRamMb: AvailableFreeRamMb,
): boolean {
  if (entry.catalogOnly === true) return true;
  if (availableFreeRamMb == null) return false;
  return availableFreeRamMb < entry.minFreeRamMb;
}

/** The three figures the UI shows per entry, in display order. */
export interface RamFigures {
  minimumLabel: string;
  recommendedLabel: string;
  deviceNowLabel: string;
}

export function describeRamFigures(
  entry: ModelCatalogueEntry,
  availableFreeRamMb: AvailableFreeRamMb,
): RamFigures {
  return {
    minimumLabel: `Minimum free RAM ${formatRamGb(entry.minFreeRamMb)}`,
    recommendedLabel: `Recommended ${formatRamGb(entry.recommendedFreeRamMb)}`,
    deviceNowLabel:
      availableFreeRamMb == null
        ? "Your device now: unknown"
        : `Your device now: ${formatRamGb(availableFreeRamMb)} available`,
  };
}
