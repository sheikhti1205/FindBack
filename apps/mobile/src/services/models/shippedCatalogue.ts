/**
 * Shipped model catalogue for the Offline AI library UI.
 *
 * The app ships `docs/specs/model-library/catalogue.v1.json` in-app, pinned
 * to one immutable release tag — it never consults a mutable remote list at
 * runtime (supply-chain pinning + unauthenticated API rate limits, see
 * `docs/specs/model-library/releases-distribution.md` §4). This module
 * imports that JSON, validates its shape once, and exposes the entries with
 * the runtime/download mappings the UI needs:
 *
 * - `bridgeModelIdForEntry`: catalogue entries with a wired native runtime
 *   map to a bridge model id (today only the SmolVLM2 500M entry). Every
 *   other entry — including the LFM2.5-VL eval-only slot, whose fixB bytes
 *   are evaluation-only and never distributable — maps to null and is never
 *   offered as a download.
 * - `LEGACY_BRIDGE_MODELS`: bridge model ids present on device that have no
 *   catalogue entry (storage management only, never downloadable). Rows for
 *   these ids render only when the bridge reports them.
 */

import catalogueJson from "../../../../../docs/specs/model-library/catalogue.v1.json";
import type { ModelCatalogueEntry, ModelDistribution } from "./catalogueTypes";
import type { VlmModelId } from "../vlmPlugin";

/** Catalogue version the UI was built against. */
export const SHIPPED_CATALOGUE_VERSION = "1" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDistribution(value: unknown): value is ModelDistribution {
  if (value === null || value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value["repo"] === "string" &&
    typeof value["tag"] === "string" &&
    typeof value["asset"] === "string" &&
    typeof value["bytes"] === "number" &&
    typeof value["sha256"] === "string" &&
    (value["parts"] === null ||
      value["parts"] === undefined ||
      Array.isArray(value["parts"]))
  );
}

function isCatalogueEntry(value: unknown): value is ModelCatalogueEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string" &&
    typeof value["displayName"] === "string" &&
    typeof value["category"] === "string" &&
    typeof value["role"] === "string" &&
    typeof value["runtime"] === "string" &&
    typeof value["format"] === "string" &&
    typeof value["revision"] === "string" &&
    typeof value["license"] === "string" &&
    (typeof value["downloadBytes"] === "number" || value["downloadBytes"] === null) &&
    (typeof value["installedBytes"] === "number" || value["installedBytes"] === null) &&
    (typeof value["sha256"] === "string" || value["sha256"] === null) &&
    typeof value["minFreeRamMb"] === "number" &&
    typeof value["recommendedFreeRamMb"] === "number" &&
    typeof value["ramRequirementSource"] === "string" &&
    typeof value["verificationStatus"] === "string" &&
    typeof value["description"] === "string" &&
    Array.isArray(value["supportedCapabilities"]) &&
    typeof value["upstreamRepo"] === "string" &&
    Array.isArray(value["provenance"]) &&
    (value["distribution"] === undefined || isDistribution(value["distribution"]))
  );
}

function loadShippedEntries(): readonly ModelCatalogueEntry[] {
  const root = catalogueJson as unknown as Record<string, unknown>;
  if (root["catalogueVersion"] !== SHIPPED_CATALOGUE_VERSION) {
    throw new Error(
      "Shipped catalogue version mismatch: expected catalogueVersion \"1\".",
    );
  }
  const entries = root["entries"];
  if (!Array.isArray(entries) || !entries.every(isCatalogueEntry)) {
    throw new Error("Shipped catalogue entries failed shape validation.");
  }
  return entries;
}

/** Pinned catalogue entries, in file order (display ordering via `listByCategory`). */
export const SHIPPED_CATALOGUE_ENTRIES: readonly ModelCatalogueEntry[] =
  loadShippedEntries();

/**
 * Catalogue entry id → wired native runtime model id. Only entries with a
 * proven complete on-device path are mapped; everything else (Qwen text
 * candidates, LFM eval slots, Gemma reference) returns null: visible as
 * catalogue information, never as a download.
 */
export function bridgeModelIdForEntry(entryId: string): VlmModelId | null {
  if (entryId === "smolvlm2-500m-litert-int4") return "smolvlm2-500m";
  return null;
}

/**
 * Pinned release-asset download URL for a catalogue entry, or null when
 * the entry carries no distribution pin. Built from the shipped
 * repo/tag/asset only — never a mutable remote list, never latest/main,
 * never an API lookup.
 */
export function distributionUrlForEntry(
  entry: ModelCatalogueEntry,
): string | null {
  const distribution = entry.distribution ?? null;
  if (distribution == null) return null;
  return `https://github.com/${distribution.repo}/releases/download/${distribution.tag}/${distribution.asset}`;
}

/**
 * Bridge-reported models with no catalogue entry. Device-state-driven rows
 * (storage management only, never downloadable): a row renders only when
 * the bridge reports that id. Kept minimal until the model is catalogued
 * or retired.
 */
export interface LegacyBridgeModel {
  readonly label: string;
  readonly kindNote: string;
  readonly sourceRepo: string;
  readonly revision: string;
  readonly runtime: string;
  readonly probeNote: string;
}

export const LEGACY_BRIDGE_MODELS: Readonly<Record<string, LegacyBridgeModel>> = {
  "smolvlm-256m": {
    label: "SmolVLM 256M",
    kindNote: "Fast-model candidate",
    sourceRepo: "litert-community/SmolVLM-256M-Instruct",
    revision: "dc16f6046d86c646bcc5dfe249c879d028f8b2f2",
    runtime: "com.google.ai.edge.litert:litert:1.4.2+litert-gpu:1.4.2",
    probeNote:
      "FAIL — unsupported RSQRT/REDUCE_SUM ops; KV-cache allocation failure during Neuron compilation.",
  },
};
