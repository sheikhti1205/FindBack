import { useEffect, useState, useSyncExternalStore } from "react";
import type { ApplicationAiService } from "./applicationAi";
import { LLAMA_CPP_RUNTIME_ID, QWEN_TEXT_RUNTIME_ID, SMOL_VLM_RUNTIME_ID, type ModelDescriptor } from "./modelDescriptors";
import { NEEDLE_MODEL_ID } from "./needle/embedder";
import type { OfflineModelStatus } from "./offlineModelManager";
import { acquisitionBytes } from "./modelSupply";

/** Presentation seam only. Files, transfer state and compatibility stay canonical. */
export type LocalIntelligenceService = Pick<ApplicationAiService,
  "android" | "ready" | "registry" | "manager" | "subscribe" | "snapshot" |
  "compatibility" | "ensureCompatibility" | "notice" | "busy" |
  "download" | "pause" | "verify" | "remove"
>;
export type LocalAssetAction = "download" | "pause" | "verify";

/**
 * THE ONE consumer owner of the local search helper.
 *
 * Local intelligence owns the helper lifecycle; older generative downloads
 * are shown only for cleanup, never as another acquisition catalogue.
 */
export const LOCAL_SEARCH_HELPER_MODEL_ID = NEEDLE_MODEL_ID;

/** True when the local intelligence surface owns this model's lifecycle. */
export function isLocalIntelligenceOwnedModel(modelId: string | undefined | null): boolean {
  return modelId === LOCAL_SEARCH_HELPER_MODEL_ID;
}

/** Cleanup only. Future narrow-tool runtimes are not retired merely for being
 * different from the search helper. File operations remain service-owned. */
export function olderGenerativeDownloads(service: LocalIntelligenceService): readonly ModelDescriptor[] {
  if (!service.android) return [];
  return service.registry.descriptors.filter((d) => {
    if (d.runtimeId !== LLAMA_CPP_RUNTIME_ID && d.runtimeId !== QWEN_TEXT_RUNTIME_ID && d.runtimeId !== SMOL_VLM_RUNTIME_ID) return false;
    const status = service.manager.statusOf(d.modelId);
    // An imported record is evidence of an earlier acquisition. Retain its
    // cleanup after a restart if bytes were deleted but metadata saving failed.
    return status !== undefined && (d.trust === "imported" || status.download !== "not-installed" || status.downloadedBytes > 0);
  });
}

export type LocalIntelligencePhase = "checking" | "ready" | "storage-unverified" | "failed";

export function useLocalIntelligenceService(service: LocalIntelligenceService) {
  useSyncExternalStore(service.subscribe, service.snapshot);
  const [checked, setChecked] = useState<{ service: LocalIntelligenceService; ok: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([service.ready, service.ensureCompatibility()]).then(
      () => { if (live) setChecked({ service, ok: true }); },
      () => { if (live) setChecked({ service, ok: false }); },
    );
    return () => { live = false; };
  }, [service]);
  const helper = service.registry.descriptorFor(LOCAL_SEARCH_HELPER_MODEL_ID);
  const notice = service.notice(LOCAL_SEARCH_HELPER_MODEL_ID);
  const phase: LocalIntelligencePhase = checked?.service !== service
    ? "checking"
    : !checked.ok
      ? "failed"
      : isStorageUnverifiedNotice(notice)
        ? "storage-unverified"
        : "ready";
  return { helper, phase, notice } as const;
}

function megabytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1_000_000).toFixed(1)} MB`;
}

/** The canonical "the model store could not be read" notice (not a free-space problem). */
function isStorageUnverifiedNotice(notice: string | null): boolean {
  return notice !== null && /storage could not be verified/i.test(notice);
}

/** Allowlisted copy: unknown native errors must not leak paths or internal IDs. */
export function localOperationNotice(notice: string | null): string | null {
  if (!notice || notice === "Installed and checksum verified.") return null;
  if (/storage could not be verified/i.test(notice)) {
    return "Couldn't check the downloaded files on this device. Try again.";
  }
  if (/not enough free storage|free space|free_bytes|out of space/i.test(notice)) {
    return "Free some space on this device, then try again.";
  }
  if (/busy|in use/i.test(notice)) return "This tool is in use. Try again when it has finished.";
  if (/unavailable on this device|incompatible/i.test(notice)) return "Unavailable on this device.";
  if (/checksum|verification|installed file.*missing/i.test(notice)) return "The downloaded file couldn't be checked. Download it again.";
  if (/transfer|download failed|interrupted/i.test(notice)) return "The download was interrupted. Retry to continue.";
  return "Couldn't finish. Please try again.";
}

export function localSearchHelperView(descriptor: ModelDescriptor, status: OfflineModelStatus | undefined, notice: string | null) {
  const total = acquisitionBytes(descriptor);
  const bytes = Math.max(0, status?.downloadedBytes ?? 0);
  const progress = total > 0 ? Math.min(100, Math.max(0, Math.round(bytes / total * 100))) : null;
  const downloadSize = total > 0 ? megabytes(total) : "Size unavailable";
  const download = status?.download ?? "not-installed";
  const installed = download === "installed" && status?.checksumVerified === true;
  const problem = status?.lastError ?? notice;
  // Integrity failure (a checksum mismatch on a finished transfer) and an
  // installed-but-unverified file are DIFFERENT recoveries, so they get
  // different states: packet `07` §7 pairs "Needs repair" with
  // "Download again"; a file that is present but unverified is only
  // unproven, and the honest action is to check it.
  const integrityFailed = /checksum|verification/i.test(problem ?? "");
  // A file that vanished or failed its check is a REPAIR, not a fresh
  // download: the user is told to fetch it again.
  const missingFile = /installed file.*missing|file is missing/i.test(problem ?? "");
  const repair = !installed && (integrityFailed || missingFile || download === "installed");
  let state: string;
  let primary: { action: LocalAssetAction; label: string } | null;
  switch (download) {
    case "installed":
      state = installed ? "Installed" : "Downloaded file needs checking";
      primary = installed ? null : { action: "verify", label: "Check downloaded file" };
      break;
    case "queued": state = "Preparing download…"; primary = null; break;
    case "verifying": state = "Checking downloaded file…"; primary = null; break;
    case "downloading":
      state = progress === null ? "Downloading…" : `Downloading ${progress}%`;
      primary = { action: "pause", label: "Pause" };
      break;
    case "paused":
      state = progress === null ? "Paused" : `Paused at ${progress}%`;
      primary = { action: "download", label: "Resume" };
      break;
    case "failed":
      state = problem === "removal failed" ? "Removal didn't finish"
        : /not enough free storage|free space|free_bytes|out of space/i.test(problem ?? "")
        ? "Needs more storage"
        : integrityFailed
          ? "Needs repair"
          : "Download interrupted";
      primary = problem === "removal failed" ? null : { action: "download", label: integrityFailed ? "Download again" : "Retry" };
      break;
    default:
      state = repair ? "Needs repair" : "Not downloaded";
      primary = { action: "download", label: repair ? "Download again" : `Download · ${downloadSize}` };
  }
  return {
    state, installed, primary, downloadSize, progress,
    // The size is stated once: when the action label already carries it
    // ("Download · 35.3 MB"), the separate size line would repeat it.
    sizeInAction: primary !== null && primary.label.includes(downloadSize),
    // Removal is only offered when the canonical path can actually run it:
    // a queued or verifying transfer is still being written.
    removable: download !== "not-installed" && download !== "queued" && download !== "verifying",
    transferDetail: bytes > 0 && (download === "downloading" || download === "paused" || download === "failed")
      ? `${megabytes(bytes)} of ${downloadSize} downloaded` : null,
    notice: installed ? null : localOperationNotice(problem),
  };
}
