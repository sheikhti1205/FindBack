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
 * - `distributionUrlForEntry`: pinned release-asset URL, or null when the
 *   entry has no distribution pin or its distribution state is not
 *   PUBLISHED (fail closed while UNPUBLISHED — no network probing).
 * - `LEGACY_BRIDGE_MODELS`: bridge model ids present on device that have no
 *   catalogue entry (storage management only, never downloadable). Rows for
 *   these ids render only when the bridge reports them.
 */

import catalogueJson from "../../../../../docs/specs/model-library/catalogue.v1.json";
import type {
  DistributionState,
  ModelCatalogueEntry,
  ModelDistribution,
} from "./catalogueTypes";
import type { VlmModelId } from "../vlmPlugin";

/** Catalogue version the UI was built against. */
export const SHIPPED_CATALOGUE_VERSION = "1" as const;

/**
 * The four experimental raw-weight candidate entry ids. Each owns a wired
 * runtime path (a verified, resident engine) even though it carries no
 * release distribution record: the three text candidates share the generic
 * text host, and the LFM2.5 VL 450M fixB entry drives the vision host.
 */
export const EXPERIMENTAL_CANDIDATE_ENTRY_IDS: readonly string[] = [
  "qwen3-0.6b-litert-mixed-int4",
  "qwen3-0.6b-litert-int8",
  "lfm2.5-1.2b-instruct-litert-int4-gpu",
  "lfm2.5-vl-450m",
] as const;

/** Catalogue id of the single experimental vision candidate. */
export const CANDIDATE_VISION_ENTRY_ID = "lfm2.5-vl-450m" as const;

/** True only for one of the four wired experimental candidate entry ids. */
export function isExperimentalCandidateEntryId(id: string): boolean {
  return EXPERIMENTAL_CANDIDATE_ENTRY_IDS.includes(id);
}

/**
 * User-facing copy for entries whose distribution is prepared but not
 * published in this build. Network download stays disabled for them.
 */
export const UNPUBLISHED_DISTRIBUTION_MESSAGE =
  "Package prepared but not published in this build." as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDistributionState(value: unknown): value is DistributionState {
  return value === "UNPUBLISHED" || value === "PUBLISHED";
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
    isDistributionState(value["state"]) &&
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
    (value["distribution"] === undefined || isDistribution(value["distribution"])) &&
    (value["pinnedRawSource"] === undefined || value["pinnedRawSource"] === null || (
      isRecord(value["pinnedRawSource"]) &&
      typeof value["pinnedRawSource"]["repo"] === "string" &&
      typeof value["pinnedRawSource"]["revision"] === "string" &&
      typeof value["pinnedRawSource"]["file"] === "string" &&
      typeof value["pinnedRawSource"]["bytes"] === "number" &&
      typeof value["pinnedRawSource"]["sha256"] === "string"
    ))
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
 * candidates and LFM experimental slots) returns null: visible as
 * catalogue information, never as a download.
 */
export function bridgeModelIdForEntry(entryId: string): VlmModelId | null {
  if (entryId === "smolvlm2-500m-litert-int4") return "smolvlm2-500m";
  return null;
}

/**
 * True only when the entry carries a distribution record pinned to a
 * PUBLISHED release asset. Entries without a distribution record (reference
 * listings, eval-only slots) report false here — they are covered by the
 * installability gate, not the publication gate.
 */
export function isDistributionPublished(entry: ModelCatalogueEntry): boolean {
  return entry.distribution?.state === "PUBLISHED";
}

/**
 * True when the entry carries a distribution record that is not published.
 * The catalogue stays authoritative: callers fail closed on this signal and
 * never probe the network to decide.
 */
export function hasUnpublishedDistribution(
  entry: ModelCatalogueEntry,
): boolean {
  return entry.distribution != null && !isDistributionPublished(entry);
}

/**
 * Pinned release-asset download URL for a catalogue entry, or null when
 * the entry carries no distribution pin OR its distribution is not
 * published. Fail closed while UNPUBLISHED: the URL string is never handed
 * out, so no consumer can start a network fetch from it — built from the
 * shipped repo/tag/asset only, never a mutable remote list, never
 * latest/main, never an API lookup.
 */
export function distributionUrlForEntry(
  entry: ModelCatalogueEntry,
): string | null {
  if (!isDistributionPublished(entry)) return null;
  const distribution = entry.distribution ?? null;
  if (distribution == null) return null;
  return `https://github.com/${distribution.repo}/releases/download/${distribution.tag}/${distribution.asset}`;
}

/** A raw .litertlm URL is never interchangeable with a release .fbmodel URL. */
export function rawWeightUrlForEntry(entry: ModelCatalogueEntry): string | null {
  const shipped = SHIPPED_CATALOGUE_ENTRIES.find((candidate) => candidate.id === entry.id);
  const source = entry.pinnedRawSource;
  if (!shipped?.pinnedRawSource || !source || entry.distribution != null) return null;
  if (JSON.stringify(source) !== JSON.stringify(shipped.pinnedRawSource)) return null;
  if (source.revision !== entry.revision || source.repo !== entry.upstreamRepo ||
    source.file !== entry.upstreamFile || source.bytes !== entry.installedBytes ||
    source.sha256 !== entry.installedSha256 ||
    !/^[\w.-]+\/[\w.-]+$/.test(source.repo) ||
    !/^[0-9a-f]{40}$/.test(source.revision) ||
    !/^[\w.-]+\.litertlm$/.test(source.file) ||
    !Number.isSafeInteger(source.bytes) || source.bytes <= 0 ||
    !/^[0-9a-f]{64}$/.test(source.sha256)) return null;
  return `https://huggingface.co/${source.repo}/resolve/${source.revision}/${source.file}`;
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
