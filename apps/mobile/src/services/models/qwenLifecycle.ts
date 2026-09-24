/**
 * Qwen text-model lifecycle semantics (Y owner).
 *
 * The complete library-citizen path for the qualified Qwen text entry
 * keyed by the frozen text identity — catalogue entry id plus
 * `TextBridgeModelId` — never by `VlmModelId`, which stays exactly the
 * two image models. Covers: gated download, pause/resume/cancel
 * orchestration, lifecycle-validated installed status, TEXT_READY
 * verification, TEXT-role activation, delete-exactness, and the
 * import/export hook arguments. No fetching, no storage side effects, no
 * UI: transfers run over the injected `modelTransfers` seams and the
 * native text-lifecycle bridge, exactly like the image path runs over
 * `VlmBridge`.
 *
 * Status contract (frozen, shared with Z/AA): `installed` is
 * lifecycle-validated (transfer verification + file facts, never mere
 * file presence), `modelFilePresent` is diagnostic only, `textReady` is
 * the observed TEXT_READY proof, `residentModelId` names the resident
 * text model or null.
 */

import type { ModelCatalogueEntry } from "./catalogueTypes";
import {
  QWEN_TEXT_BRIDGE_MODEL_ID,
  QWEN_TEXT_ENTRY_ID,
  activateTextModel,
  isCandidateTextEntryId,
  type ActivateTextModelOptions,
  type TextActivationResult,
  type TextBridgeModelId,
  type TextGenerationBridge,
} from "./textRuntime";
import {
  distributionUrlForEntry,
  hasUnpublishedDistribution,
  SHIPPED_CATALOGUE_ENTRIES,
  UNPUBLISHED_DISTRIBUTION_MESSAGE,
} from "./shippedCatalogue";
import {
  downloadModelToStore,
  type DownloadGateInput,
  type DownloadToStoreInput,
  type DownloadToStoreResult,
  type DownloadTransport,
} from "./modelTransfers";
import { getEntryById } from "./modelCatalogue";
import type { ModelTransferStore } from "./transferStore";

/** TEXT_READY state wire string (mirrors the native self-test taxonomy). */
export const TEXT_READY_STATE = "TEXT_READY" as const;

/** Lifecycle-validated install state wire (transfer-verified, not probed). */
export const QWEN_INSTALLED_STATE = "INSTALLED_UNVERIFIED" as const;

/**
 * Frozen lifecycle status for the Qwen text entry. `installed` is true
 * only when transfer verification and file facts both hold; a merely
 * present file reports `modelFilePresent` without `installed`.
 */
export interface QwenLifecycleStatus {
  readonly entryId: string;
  readonly modelId: TextBridgeModelId;
  readonly installed: boolean;
  readonly modelFilePresent: boolean;
  readonly textReady: boolean;
  readonly residentModelId: TextBridgeModelId | null;
}

export interface QwenLifecycleSignals {
  /** Transfer-verified install recorded by the lifecycle (never file presence). */
  readonly transferValidated: boolean;
  /** Diagnostic file-presence probe only. */
  readonly modelFilePresent: boolean;
  /** Observed TEXT_READY proof (see `isTextReadySelfTest`). */
  readonly textReady: boolean;
  /** Resident text model id, or null when no text engine is resident. */
  readonly residentModelId: TextBridgeModelId | null;
}

/**
 * Derives the frozen status. `installed` requires both the
 * transfer-validated record and the file probe — either alone stays
 * uninstalled, so a stray file can never read as installed.
 */
export function deriveQwenLifecycleStatus(
  signals: QwenLifecycleSignals,
): QwenLifecycleStatus {
  return {
    entryId: QWEN_TEXT_ENTRY_ID,
    modelId: QWEN_TEXT_BRIDGE_MODEL_ID,
    installed: signals.transferValidated && signals.modelFilePresent,
    modelFilePresent: signals.modelFilePresent,
    textReady: signals.textReady,
    residentModelId: signals.residentModelId,
  };
}

/** True only when the model may serve text: validated install plus TEXT_READY proof. */
export function isQwenReadyForText(status: QwenLifecycleStatus): boolean {
  return status.installed && status.textReady;
}

export interface TextSelfTestObservation {
  readonly ready: boolean;
  readonly state: string;
}

/**
 * TEXT_READY verification: a self-test observation counts as ready only
 * when the runtime reports success AND the canonical TEXT_READY state.
 * Any other state (including bare `ready` without the state) stays
 * not-ready — activation requires this proof.
 */
export function isTextReadySelfTest(
  observation: TextSelfTestObservation,
): boolean {
  return observation.ready === true && observation.state === TEXT_READY_STATE;
}

/** True only when the persisted active entry is the qualified Qwen text entry. */
export function isQwenTextRoleActive(activeEntryId: string | null): boolean {
  return activeEntryId === QWEN_TEXT_ENTRY_ID;
}

/**
 * TEXT-role activation for the qualified entry: pin + presence checks,
 * the shared single-resident switch plan, and the observed ready proof
 * (see `activateTextModel`). Persists nothing; the caller records the
 * active id only when `ok` is true.
 */
export function activateQwenText(
  bridge: TextGenerationBridge,
  entry: ModelCatalogueEntry,
  options: ActivateTextModelOptions,
): Promise<TextActivationResult> {
  return activateTextModel(bridge, entry, options);
}

/** Pinned release-asset download URL for a Qwen entry, or null when unpinned or unpublished. */
export function qwenDownloadUrl(entry: ModelCatalogueEntry): string | null {
  if (entry.id !== QWEN_TEXT_ENTRY_ID) return null;
  return distributionUrlForEntry(entry);
}

export interface QwenDownloadInput extends DownloadGateInput {
  /** Discard the staged temp prefix and restart from byte zero. */
  restart?: boolean;
  /** Previously observed total for resume-drift detection (else unknown). */
  expectedTotalBytes?: number | null;
  /** Cooperative cancellation; the staged prefix is kept for resume. */
  control?: DownloadToStoreInput["control"];
  onProgress?: DownloadToStoreInput["onProgress"];
}

/**
 * Gated, resumable, hash-verified Qwen download over the shared transfer
 * seam. The URL is built from the shipped catalogue pin only; chunks
 * stream into the transfer store and commit atomically on verified
 * success. Partial bytes stay staged for resume and are never reported
 * as installed (see `deriveQwenLifecycleStatus`).
 */
export async function downloadQwenToStore(
  entry: ModelCatalogueEntry,
  transport: DownloadTransport,
  store: ModelTransferStore,
  input: QwenDownloadInput,
): Promise<DownloadToStoreResult> {
  const url = qwenDownloadUrl(entry);
  if (url == null) {
    if (hasUnpublishedDistribution(entry)) {
      return {
        ok: false,
        code: "NOT_PUBLISHED",
        reason: UNPUBLISHED_DISTRIBUTION_MESSAGE,
        receivedBytes: 0,
      };
    }
    return {
      ok: false,
      code: "MISSING_PIN",
      reason:
        "No pinned release-asset download for this entry: the package cannot be verified, so download is refused.",
      receivedBytes: 0,
    };
  }
  return downloadModelToStore(entry, url, transport, store, input);
}

export type QwenImportArgsResult =
  | {
      readonly ok: true;
      readonly args: {
        readonly entryId: string;
        readonly sourceUri: string;
        readonly expectedSha256: string;
      };
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Import hook arguments for the qualified entry. The expected pin is the
 * shipped catalogue distribution hash — never a value from inside the
 * package under test. Entries without a shipped package pin are refused
 * fail-closed.
 */
export function qwenImportArgs(
  entry: ModelCatalogueEntry,
  sourceUri: string,
): QwenImportArgsResult {
  if (entry.id !== QWEN_TEXT_ENTRY_ID) {
    return {
      ok: false,
      reason: `Package entry ${entry.id} is not the qualified text entry. Nothing installed.`,
    };
  }
  if (sourceUri.length === 0) {
    return { ok: false, reason: "Missing package document. Nothing installed." };
  }
  const expectedSha256 = entry.distribution?.sha256 ?? entry.sha256;
  if (expectedSha256 == null) {
    return {
      ok: false,
      reason:
        "No shipped hash pin: the package cannot be verified, so import is refused. Nothing installed.",
    };
  }
  return {
    ok: true,
    args: { entryId: entry.id, sourceUri, expectedSha256 },
  };
}

/** Export hook arguments for the qualified entry (reads authoritative installed files). */
export function qwenExportArgs(destUri: string): {
  readonly entryId: string;
  readonly destUri: string;
} {
  return { entryId: QWEN_TEXT_ENTRY_ID, destUri };
}

/**
 * Exact interior relative paths owned by the Qwen text entry. Delete and
 * export-exactness are asserted against this list: removing the model
 * removes exactly these paths, and sibling entries are never matched.
 */
export function qwenOwnedRelativePaths(entry: ModelCatalogueEntry): readonly string[] {
  const file = entry.upstreamFile;
  if (entry.id !== QWEN_TEXT_ENTRY_ID || file == null || file.length === 0) {
    return [];
  }
  return [file];
}

/** True only for interior paths owned by the qualified Qwen entry. */
export function isQwenOwnedRelativePath(
  entry: ModelCatalogueEntry,
  path: string,
): boolean {
  return qwenOwnedRelativePaths(entry).includes(path);
}

/**
 * Partitions interior paths into Qwen-owned vs foreign. Delete-exactness:
 * the owned set is removed, the foreign set (sibling models, sidecars)
 * must be left untouched.
 */
export function partitionQwenOwned(
  entry: ModelCatalogueEntry,
  paths: readonly string[],
): { readonly owned: readonly string[]; readonly foreign: readonly string[] } {
  const owned = paths.filter((path) => isQwenOwnedRelativePath(entry, path));
  const foreign = paths.filter((path) => !isQwenOwnedRelativePath(entry, path));
  return { owned, foreign };
}

/** Shipped qualified Qwen text entry, or null when the pin drifted. */
export function shippedQwenEntry(): ModelCatalogueEntry | null {
  return getEntryById(SHIPPED_CATALOGUE_ENTRIES, QWEN_TEXT_ENTRY_ID);
}

/** Minimal native surface the Qwen lifecycle needs (text-keyed; image bridge untouched). */
export interface QwenLifecycleBridge {
  downloadTextModel(options: { modelId: TextBridgeModelId }): Promise<void>;
  pauseTextDownload(options: { modelId: TextBridgeModelId }): Promise<void>;
  resumeTextDownload(options: { modelId: TextBridgeModelId }): Promise<void>;
  cancelTextDownload(options: {
    modelId: TextBridgeModelId;
    removePartial?: boolean;
  }): Promise<void>;
  deleteTextModel(options: { modelId: TextBridgeModelId }): Promise<void>;
  getTextRuntimeStatus(): Promise<QwenBridgeStatus>;
}

/** Native text-runtime status read (additive over the Z bridge shape). */
export interface QwenBridgeStatus {
  readonly modelId: string;
  readonly ready: boolean;
  readonly nativeRunning: boolean;
  readonly backend: string;
  readonly modelFilePresent: boolean;
  /** Lifecycle-validated install; absent (older native) reads fail-closed as false. */
  readonly installed?: boolean;
  /** Last TEXT_READY proof; absent reads fail-closed as false. */
  readonly textReady?: boolean;
  readonly residentModelId?: string | null;
  /**
   * Candidate text payload extras (additive AI-03 native follow-up): the
   * persisted selection pointer plus its verified/initialized facts. Absent
   * on the dedicated Qwen path; never residency proof on their own.
   */
  readonly selectedEntryId?: string | null;
  readonly installedVerified?: boolean;
  readonly initialized?: boolean;
}

/**
 * Maps a native text-runtime status read onto lifecycle signals.
 * Missing lifecycle fields fail closed (uninstalled / not ready) so an
 * older native build can never inflate install or readiness. A genuinely
 * resident experimental text candidate keeps its entry id as the resident
 * (AI-03/AI-07); foreign ids still map to null.
 */
export function signalsFromBridgeStatus(
  status: QwenBridgeStatus,
): QwenLifecycleSignals {
  const rawResident = status.residentModelId ?? null;
  const residentModelId =
    rawResident === QWEN_TEXT_BRIDGE_MODEL_ID
      ? QWEN_TEXT_BRIDGE_MODEL_ID
      : isCandidateTextEntryId(rawResident)
        ? rawResident
        : null;
  return {
    transferValidated: status.installed ?? false,
    modelFilePresent: status.modelFilePresent,
    textReady: status.textReady ?? false,
    residentModelId,
  };
}

/**
 * Native resident as a catalogue entry id, or null when nothing is genuinely
 * resident. Maps the qualified Qwen bridge id to its entry id and keeps
 * resident experimental text-candidate ids verbatim; a selection pointer
 * alone (no `residentModelId`) never counts — cold restart reads null until
 * the first genuine activation. Shared by the Shell gate and the library
 * reconcile pass so both match the actual native resident.
 */
export function residentEntryIdFromBridgeStatus(
  status: { readonly residentModelId?: string | null } | null | undefined,
): string | null {
  if (status == null) return null;
  if (status.residentModelId === QWEN_TEXT_BRIDGE_MODEL_ID) return QWEN_TEXT_ENTRY_ID;
  const resident = status.residentModelId ?? null;
  if (isCandidateTextEntryId(resident)) return resident;
  return null;
}

/**
 * Shell assistant seams from a native status read. Fail closed: a missing
 * or unreadable status yields installed=false and ready=false, keeping the
 * assistant on the grounded fallback. Single mapping seam shared with the
 * lifecycle signals above.
 */
export function shellTextSeamsFromBridgeStatus(
  status: QwenBridgeStatus | null | undefined,
): { textInstalled: boolean; textReady: boolean } {
  if (status == null) return { textInstalled: false, textReady: false };
  const signals = signalsFromBridgeStatus(status);
  return { textInstalled: signals.transferValidated, textReady: signals.textReady };
}
