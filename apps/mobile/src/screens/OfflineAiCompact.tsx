/**
 * Compact six-model manager screen (Phase A revision 03).
 *
 * Mounted at `/offline-ai`. Renders the green presentational
 * `ModelManagerView` with real native state:
 * - SmolVLM2 500M through the image `VlmBridge`;
 * - Qwen3 0.6B Dynamic INT4 through the text-bridge status;
 * - four pinned raw candidates through `getCandidateHost()`;
 * - global Import/Export through `getTransferHost()`.
 *
 * Known release-package downloads stay blocked while UNPUBLISHED (honest
 * Unavailable, never a bypass). Experimental `Use` never claims activation:
 * only entries with a wired role-safe runtime path can activate, the rest
 * report verified-only. New flows use dialogs, never window.prompt/confirm.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { ModelManagerView, type ManagerAction, type ManagerModel, type ManagerStatus } from "../components/ModelManagerView";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useModalBack } from "../hooks/useModalBack";
import { getVlmBridge, isTextBridge } from "../services/vlmPlugin";
import { getCandidateHost, type CandidateHost } from "../services/models/candidateHost";
import { getTransferHost, type ImportedModelRecord, type InspectedImport, type ProbeInspectedResult, type TransferHost } from "../services/models/packageTransferHost";
import {
  applyLiveState,
  compactDescriptors,
  importedToManagerModels,
  managerStatusFrom,
} from "../services/models/compactManager";
import { bridgeModelIdForEntry, hasUnpublishedDistribution, SHIPPED_CATALOGUE_ENTRIES } from "../services/models/shippedCatalogue";
import { shellTextSeamsFromBridgeStatus } from "../services/models/qwenLifecycle";
import { activateModel } from "../services/models/modelActivation";
import { activateTextModel, isTextRuntimePresent, QWEN_TEXT_BRIDGE_MODEL_ID } from "../services/models/textRuntime";
import { loadResidentEntryId, saveResidentEntryId } from "../services/models/roleSelection";
import { chooseFromGallery, toNativeImageUri } from "../services/photo";

export interface CompactVlmSeam {
  getCapabilities(): Promise<{ availableRamMb?: number | null }>;
  getModelStates(): Promise<Array<{ id: string; state: string }>>;
  downloadModel(id: string, opts?: { allowCellular?: boolean }): Promise<void>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  deleteModel(id: string): Promise<void>;
  runGpuSelfTest(id: string, imageUri?: string): Promise<{ state: string }>;
  runTextSelfTest?(id: string): Promise<{ ready?: boolean; state?: string }>;
  getTextRuntimeStatus?(): Promise<{ textInstalled?: boolean; textReady?: boolean; installed?: boolean; ready?: boolean }>;
  generateText?: (request: unknown) => Promise<unknown>;
  onDownloadProgress?(listener: (event: { modelId: string; downloadedBytes: number; totalBytes: number }) => void): Promise<() => void>;
  onModelStateChange?(listener: (info: { id: string; state: string }) => void): Promise<() => void>;
}

export interface CompactSeams {
  vlm?: CompactVlmSeam | null;
  candidates?: CandidateHost | null;
  transfers?: TransferHost | null;
  ramOverrideMb?: number | null;
  pickTestImage?: () => Promise<string | null>;
}

const SMOL_ENTRY = "smolvlm2-500m-litert-int4";
const QWEN_ENTRY = "qwen3-0.6b-litert-dynamic-int4";
const LARGE_DOWNLOAD_BYTES = 500 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function entryById(id: string) {
  return SHIPPED_CATALOGUE_ENTRIES.find((entry) => entry.id === id) ?? null;
}

export function OfflineAiCompact(seams?: CompactSeams) {
  const vlm = useMemo<CompactVlmSeam | null>(() => {
    if (seams && "vlm" in seams) return seams.vlm ?? null;
    try {
      return getVlmBridge() as unknown as CompactVlmSeam;
    } catch {
      return null;
    }
  }, [seams]);
  const candidates = useMemo<CandidateHost | null>(() => {
    if (seams && "candidates" in seams) return seams.candidates ?? null;
    try {
      return getCandidateHost();
    } catch {
      return null;
    }
  }, [seams]);
  const transfers = useMemo<TransferHost | null>(() => {
    if (seams && "transfers" in seams) return seams.transfers ?? null;
    try {
      return getTransferHost();
    } catch {
      return null;
    }
  }, [seams]);
  const pickTestImage = useMemo(() => seams?.pickTestImage ?? (async () =>
    toNativeImageUri(await chooseFromGallery())), [seams?.pickTestImage]);

  const [ramMb, setRamMb] = useState<number | null>(seams?.ramOverrideMb ?? null);
  const [vlmStates, setVlmStates] = useState<Array<{ id: string; state: string }>>([]);
  const [textStatus, setTextStatus] = useState<{ textInstalled: boolean; textReady: boolean } | null>(null);
  const [candidateStates, setCandidateStates] = useState<Array<{ entryId: string; state: string; sizeBytes?: number; downloadedBytes?: number; error?: string }>>([]);
  const [candidateProgress, setCandidateProgress] = useState<Record<string, { downloadedBytes: number; totalBytes: number }>>({});
  const [vlmProgress, setVlmProgress] = useState<Record<string, number>>({});
  const [imported, setImported] = useState<ImportedModelRecord[]>([]);
  const [overrides, setOverrides] = useState<Record<string, { state: ManagerStatus; error?: string }>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const [confirm, setConfirm] = useState<{ entryId: string; bytes: number; acknowledged: boolean; seconded: boolean } | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(confirmRef, () => setConfirm(null));
  useModalBack(confirm !== null, () => setConfirm(null));

  const [exportOpen, setExportOpen] = useState(false);
  const [exportSelected, setExportSelected] = useState<string[]>([]);
  const [exportResults, setExportResults] = useState<Array<{ entryId: string; fileName: string; ok: boolean; reason?: string }> | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  useFocusTrap(exportRef, () => setExportOpen(false));
  useModalBack(exportOpen, () => setExportOpen(false));

  const [importBusy, setImportBusy] = useState(false);
  const [inspection, setInspection] = useState<InspectedImport | null>(null);
  const [importName, setImportName] = useState("");
  const [importRole, setImportRole] = useState<"Text" | "Vision">("Text");
  const [importDescription, setImportDescription] = useState("");
  const [probeResult, setProbeResult] = useState<ProbeInspectedResult | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const importRef = useRef<HTMLDivElement>(null);
  const importOpen = inspection !== null;
  useFocusTrap(importRef, () => {
    if (!importBusy && !probeBusy) void discardInspection();
  });
  useModalBack(importOpen, () => {
    if (!importBusy && !probeBusy) void discardInspection();
  });

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const tasks: Array<Promise<void>> = [];
    if (vlm) {
      tasks.push(
        vlm.getCapabilities().then((caps) => {
          if (!mountedRef.current) return;
          if (seams?.ramOverrideMb == null && caps?.availableRamMb != null && Number.isFinite(caps.availableRamMb)) {
            setRamMb(Math.max(0, Math.floor(caps.availableRamMb)));
          }
        }).catch(() => undefined),
        vlm.getModelStates().then((states) => {
          if (mountedRef.current) setVlmStates(states);
        }).catch(() => undefined),
      );
      const statusPromise = (async () => {
        try {
          if (typeof vlm.getTextRuntimeStatus === "function") {
            const status = await vlm.getTextRuntimeStatus();
            if (!mountedRef.current) return;
            if (status && ("textInstalled" in status || "installed" in status)) {
              const installed = (status.textInstalled ?? status.installed ?? false) === true;
              const ready = (status.textReady ?? status.ready ?? false) === true;
              setTextStatus({ textInstalled: installed, textReady: ready });
              return;
            }
          }
        } catch {
          /* fall through to bridge-status seam below */
        }
        try {
          const bridge = getVlmBridge();
          if (isTextBridge(bridge)) {
            const status = await bridge.getTextRuntimeStatus();
            if (mountedRef.current) setTextStatus(shellTextSeamsFromBridgeStatus(status));
          }
        } catch {
          /* text status stays null: Qwen row shows Not installed honestly */
        }
      })();
      tasks.push(statusPromise);
    }
    const candidateHost = candidates;
    if (candidateHost) {
      tasks.push(
        candidateHost.getStates().then((states) => {
          if (mountedRef.current) {
            setCandidateStates(states.map((s) => ({ entryId: s.entryId, state: s.state, sizeBytes: s.sizeBytes, downloadedBytes: s.downloadedBytes, error: s.error })));
          }
        }).catch(() => undefined),
      );
    }
    if (transfers) {
      tasks.push(
        transfers.getImported().then((models) => {
          if (mountedRef.current) setImported(models);
        }).catch(() => undefined),
      );
    }
    await Promise.all(tasks);
  }, [vlm, candidates, transfers, seams?.ramOverrideMb]);

  // Native event listeners belong to the screen lifetime, never to a state
  // refresh. Registering during refresh leaked a listener after every action.
  useEffect(() => {
    let closed = false;
    const removers: Array<() => void> = [];
    const track = (subscription: Promise<() => void>) => {
      void subscription.then((remove) => {
        if (closed) remove();
        else removers.push(remove);
      }).catch(() => undefined);
    };
    if (vlm?.onDownloadProgress) track(vlm.onDownloadProgress((event) => {
      if (!closed) setVlmProgress((prev) => ({ ...prev, [event.modelId]: event.downloadedBytes }));
    }));
    if (vlm?.onModelStateChange) track(vlm.onModelStateChange((info) => {
      if (!closed) setVlmStates((prev) => [...prev.filter((item) => item.id !== info.id), info]);
    }));
    if (candidates) {
      track(candidates.onProgress((event) => {
        if (!closed) setCandidateProgress((prev) => ({ ...prev, [event.entryId]: event }));
      }));
      track(candidates.onState((info) => {
        if (!closed) setCandidateStates((prev) => [...prev.filter((item) => item.entryId !== info.entryId), info]);
      }));
    }
    return () => {
      closed = true;
      removers.forEach((remove) => remove());
    };
  }, [vlm, candidates]);

  useEffect(() => {
    setActiveId(loadResidentEntryId());
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (seams?.ramOverrideMb != null) setRamMb(seams.ramOverrideMb);
  }, [seams?.ramOverrideMb]);

  const base = useMemo(() => {
    try {
      return compactDescriptors();
    } catch {
      return [] as ManagerModel[];
    }
  }, []);

  const models: ManagerModel[] = useMemo(() => {
    const live = applyLiveState(base, {
      vlmStates,
      bridgeIdFor: (entryId) => bridgeModelIdForEntry(entryId),
      textStatus,
      textEntryId: QWEN_ENTRY,
      candidateStates,
      candidateProgress,
      downloadedBytesByBridgeId: vlmProgress,
      availableFreeRamMb: ramMb,
      canDownloadFor: (entryId) => {
        if (entryId === SMOL_ENTRY || entryId === QWEN_ENTRY) return false;
        return candidates != null;
      },
    }).map((model) => {
      const override = overrides[model.entryId];
      if (!override) {
        if ((model.entryId === SMOL_ENTRY || model.entryId === QWEN_ENTRY) && model.state === "NOT_INSTALLED") {
          return { ...model, state: "UNAVAILABLE" as ManagerStatus, canDownload: false };
        }
        return model;
      }
      return { ...model, state: override.state, error: override.error ?? model.error };
    });
    return [...live, ...importedToManagerModels(imported)];
  }, [base, vlmStates, textStatus, candidateStates, candidateProgress, vlmProgress, ramMb, candidates, overrides, imported]);

  const fail = useCallback((message: string) => {
    if (mountedRef.current) setActionError(message);
  }, []);

  const runGuarded = useCallback(async (fn: () => Promise<void>) => {
    if (!mountedRef.current) return;
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      fail(err instanceof Error ? err.message : "The action failed. Nothing changed.");
    }
  }, [fail]);

  const startDownload = useCallback(async (entryId: string) => {
    const model = models.find((m) => m.entryId === entryId);
    const bytes = model?.bytes ?? entryById(entryId)?.installedBytes ?? 0;
    setConfirm({ entryId, bytes, acknowledged: false, seconded: false });
  }, [models]);

  const confirmDownloadNow = useCallback(async () => {
    if (!confirm) return;
    const { entryId } = confirm;
    setConfirm(null);
    await runGuarded(async () => {
      if (entryId !== SMOL_ENTRY && entryId !== QWEN_ENTRY) {
        if (!candidates) throw new Error("Candidate downloads are unavailable in this build.");
        await candidates.download(entryId);
      } else {
        const bridgeId = bridgeModelIdForEntry(entryId);
        if (!bridgeId || !vlm) throw new Error("Package prepared but not published in this build. Download is unavailable.");
        await vlm.downloadModel(bridgeId);
      }
      await refresh();
    });
  }, [confirm, candidates, vlm, refresh, runGuarded]);

  const handleAction = useCallback((entryId: string, action: ManagerAction) => {
    void runGuarded(async () => {
      const model = models.find((m) => m.entryId === entryId);
      const isImported = model?.category === "IMPORTED";
      const bridgeId = bridgeModelIdForEntry(entryId);
      switch (action) {
        case "download":
          await startDownload(entryId);
          return;
        case "pause":
          if (bridgeId && vlm && vlmStates.some((s) => s.id === bridgeId)) await vlm.pauseDownload(bridgeId);
          else if (candidates) await candidates.pause(entryId);
          break;
        case "resume":
          if (bridgeId && vlm && vlmStates.some((s) => s.id === bridgeId)) await vlm.resumeDownload(bridgeId);
          else if (candidates) await candidates.download(entryId);
          break;
        case "cancel":
          if (bridgeId && vlm && vlmStates.some((s) => s.id === bridgeId)) await vlm.cancelDownload(bridgeId);
          else if (candidates) await candidates.cancel(entryId);
          break;
        case "verify": {
          if (entryId === SMOL_ENTRY) {
            if (!vlm) throw new Error("Verification is unavailable: the image runtime is missing in this build.");
            const uri = await pickTestImage?.() ?? null;
            if (!uri) throw new Error("Choose a test photo to verify this vision model. Nothing changed.");
            const result = await vlm.runGpuSelfTest("smolvlm2-500m", uri);
            if (result?.state === "GPU_AVAILABLE") {
              setOverrides((prev) => ({ ...prev, [entryId]: { state: "READY" } }));
            } else {
              throw new Error("This model cannot run with this FindBack build. See Details for the reason.");
            }
          } else if (entryId === QWEN_ENTRY) {
            if (typeof vlm?.runTextSelfTest !== "function") {
              throw new Error("No executable text runtime is wired for this entry in this build, so it cannot be verified here.");
            }
            const result = await vlm.runTextSelfTest(QWEN_TEXT_BRIDGE_MODEL_ID);
            if (result && (result.ready === true || result.state === "TEXT_READY")) {
              setOverrides((prev) => ({ ...prev, [entryId]: { state: "READY" } }));
            } else {
              throw new Error("This model cannot run with this FindBack build. See Details for the reason.");
            }
          } else if (!isImported && candidates) {
            const needsImage = entryId === "lfm2.5-vl-450m";
            const uri = needsImage ? await pickTestImage?.() ?? null : undefined;
            if (needsImage && !uri) throw new Error("Choose a test photo to verify this vision model. Nothing changed.");
            const probe = await candidates.verify(entryId, uri ?? undefined);
            if (probe?.ready) {
              setOverrides((prev) => ({ ...prev, [entryId]: { state: "READY" } }));
            } else {
              throw new Error("This model cannot run with this FindBack build. See Details for the reason.");
            }
          } else if (isImported && transfers) {
            throw new Error("Imported models verify during import. Delete and re-import to test again.");
          } else {
            throw new Error("Verification is unavailable for this entry in this build.");
          }
          break;
        }
        case "use": {
          if (entryId === SMOL_ENTRY) {
            const entry = entryById(entryId);
            if (!entry || !vlm) throw new Error("No executable runtime is wired for this entry in this build.");
            const result = await activateModel(vlm as never, entry, {
              currentResidentId: activeId,
              availableFreeRamMb: ramMb,
              advancedConfirmed: true,
              runtimeCapability: "RUNTIME_AVAILABLE",
            });
            if (!result.ok) throw new Error(result.reason);
            if (!result.alreadyActive) {
              setActiveId(entryId);
              saveResidentEntryId(entryId);
            }
          } else if (entryId === QWEN_ENTRY) {
            const entry = entryById(entryId);
            if (!entry) throw new Error("No executable runtime is wired for this entry in this build.");
            const runtimePresent = isTextRuntimePresent(vlm);
            const result = await activateTextModel(
              vlm as never,
              entry,
              { currentResidentId: activeId, availableFreeRamMb: ramMb, advancedConfirmed: true, textRuntimePresent: runtimePresent, runtimeReady: textStatus?.textReady === true },
            );
            if (!result.ok) throw new Error(result.reason);
            if (!result.alreadyActive) {
              setActiveId(entryId);
              saveResidentEntryId(entryId);
            }
          } else {
            throw new Error("Verified only — no executable runtime is wired for this entry in this build, so it cannot run analysis here.");
          }
          break;
        }
        case "tryAgain": {
          setOverrides((prev) => {
            const next = { ...prev };
            delete next[entryId];
            return next;
          });
          await refresh();
          break;
        }
        case "delete": {
          if (isImported) {
            if (!transfers) throw new Error("Delete is unavailable in this build.");
            await transfers.deleteImported(entryId);
            if (mountedRef.current) setImported((prev) => prev.filter((m) => m.entryId !== entryId));
          } else if (bridgeId && vlm && vlmStates.some((s) => s.id === bridgeId)) {
            await vlm.deleteModel(bridgeId);
          } else if (candidates) {
            await candidates.delete(entryId);
          } else {
            throw new Error("Delete is unavailable for this entry in this build.");
          }
          setOverrides((prev) => {
            const next = { ...prev };
            delete next[entryId];
            return next;
          });
          await refresh();
          break;
        }
      }
      await refresh();
    });
  }, [models, vlmStates, vlm, candidates, transfers, pickTestImage, activeId, ramMb, textStatus, refresh, runGuarded, startDownload]);

  const discardInspection = useCallback(async () => {
    if (!inspection || !transfers) {
      if (mountedRef.current) {
        setInspection(null);
        setProbeResult(null);
      }
      return;
    }
    const id = inspection.inspectionId;
    try {
      await transfers.discard(id);
    } catch {
      /* staged cleanup is best-effort; the dialog still closes */
    }
    if (mountedRef.current) {
      setInspection(null);
      setProbeResult(null);
      setImportName("");
      setImportRole("Text");
      setImportDescription("");
    }
  }, [inspection, transfers]);

  const handleImport = useCallback(() => {
    void runGuarded(async () => {
      if (!transfers) throw new Error("Import runs in the platform installer, which is unavailable in this build.");
      setImportBusy(true);
      try {
        const pick = await transfers.pickImport();
        if (!pick || pick.cancelled || !pick.uri) return;
        const inspected = await transfers.inspect(pick.uri);
        if (!mountedRef.current) return;
        setInspection(inspected);
        setProbeResult(null);
        setImportName("");
        setImportRole("Text");
        setImportDescription("");
      } finally {
        if (mountedRef.current) setImportBusy(false);
      }
    });
  }, [transfers, runGuarded]);

  const handleCommitKnown = useCallback(() => {
    void runGuarded(async () => {
      if (!inspection || !transfers) return;
      await transfers.commitDetailed({ inspectionId: inspection.inspectionId });
      if (mountedRef.current) {
        setInspection(null);
        setProbeResult(null);
      }
      await refresh();
    });
  }, [inspection, transfers, refresh, runGuarded]);

  const handleProbe = useCallback(() => {
    void runGuarded(async () => {
      if (!inspection || !transfers) return;
      const name = importName.trim();
      if (name.length === 0) throw new Error("Enter a name for this model. Nothing installed.");
      if (name.length > 64) throw new Error("Keep the name to 64 characters or fewer. Nothing installed.");
      setProbeBusy(true);
      try {
        const imageUri = importRole === "Vision" ? await pickTestImage?.() ?? null : null;
        if (importRole === "Vision" && !imageUri) throw new Error("Choose a test photo to probe this vision model. Nothing installed.");
        const result = await transfers.probe({ inspectionId: inspection.inspectionId, role: importRole, imageUri: imageUri ?? undefined });
        if (mountedRef.current) setProbeResult(result);
      } finally {
        if (mountedRef.current) setProbeBusy(false);
      }
    });
  }, [inspection, transfers, importName, importRole, pickTestImage, runGuarded]);

  const handleAddImported = useCallback((keepUnverified: boolean) => {
    void runGuarded(async () => {
      if (!inspection || !transfers) return;
      const name = importName.trim();
      if (name.length === 0) throw new Error("Enter a name for this model. Nothing installed.");
      await transfers.commitDetailed({
        inspectionId: inspection.inspectionId,
        name,
        description: importDescription.trim() ? importDescription.trim().slice(0, 280) : undefined,
        role: importRole,
        keepUnverified: keepUnverified || undefined,
      });
      if (mountedRef.current) {
        setInspection(null);
        setProbeResult(null);
        setImportName("");
        setImportRole("Text");
        setImportDescription("");
      }
      await refresh();
    });
  }, [inspection, transfers, importName, importDescription, importRole, refresh, runGuarded]);

  const installableForExport = useMemo(
    () => models.filter((m) => m.state === "READY" || m.state === "INSTALLED_UNVERIFIED" || m.state === "LOW_MEMORY"),
    [models],
  );
  const exportTotal = useMemo(
    () => installableForExport.filter((m) => exportSelected.includes(m.entryId)).reduce((sum, m) => sum + m.bytes, 0),
    [installableForExport, exportSelected],
  );

  const handleExportOpen = useCallback(() => {
    setExportResults(null);
    setExportSelected([]);
    setExportBusy(false);
    setExportOpen(true);
  }, []);

  const handleExportNow = useCallback(() => {
    void runGuarded(async () => {
      if (!transfers) throw new Error("Export packaging runs in the platform installer, which is unavailable in this build.");
      if (exportSelected.length === 0) throw new Error("Select at least one installed model to export.");
      setExportBusy(true);
      try {
        const results = await transfers.exportAll(exportSelected);
        if (mountedRef.current) setExportResults(results);
      } finally {
        if (mountedRef.current) setExportBusy(false);
      }
    });
  }, [transfers, exportSelected, runGuarded]);

  const confirmModel = confirm ? models.find((m) => m.entryId === confirm.entryId) ?? null : null;
  const confirmEntry = confirm ? entryById(confirm.entryId) : null;
  const confirmNeedsAck =
    confirmEntry != null &&
    (confirmEntry.verificationStatus === "EXPERIMENTAL" ||
      confirmEntry.verificationStatus === "SUPPORTED_UNVERIFIED" ||
      (ramMb != null && ramMb < confirmEntry.minFreeRamMb));
  const confirmLarge = (confirm?.bytes ?? 0) >= LARGE_DOWNLOAD_BYTES;
  const confirmReady =
    (!confirmNeedsAck || (confirm?.acknowledged === true)) && (!confirmLarge || confirm?.seconded === true);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-8">
      {actionError && (
        <div role="alert" className="mt-4 flex flex-col gap-2 rounded-lg border border-error px-3 py-2">
          <span className="break-words text-sm text-error">{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="min-h-[48px] w-full px-2 text-xs text-error underline sm:w-auto sm:self-end">
            Dismiss
          </button>
        </div>
      )}
      <ModelManagerView
        models={models.map((m) => (managerStatusFrom(m.state) === "UNAVAILABLE" && m.state === "NOT_INSTALLED" ? { ...m, state: "UNAVAILABLE" as ManagerStatus } : m))}
        availableRamMb={ramMb}
        onAction={handleAction}
        onImport={handleImport}
        onExport={handleExportOpen}
      />
      {importBusy && <p role="status" className="mt-2 text-sm text-on-surface-variant">Inspecting model…</p>}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
          <div ref={confirmRef} role="dialog" aria-modal="true" aria-label={`Confirm download of ${confirmModel?.label ?? confirm.entryId}`} tabIndex={-1} className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-m3-lg bg-surface p-5">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold">Confirm download</h2>
              <button type="button" onClick={() => setConfirm(null)} aria-label="Cancel download confirmation" className="flex min-h-[48px] min-w-[48px] items-center justify-center"><X aria-hidden size={20} /></button>
            </div>
            <p className="mt-2 text-sm">Download size: {formatBytes(confirm.bytes)}.</p>
            {confirmEntry && hasUnpublishedDistribution(confirmEntry) && (
              <p className="mt-1 text-sm text-error">Package prepared but not published in this build. Download is unavailable.</p>
            )}
            {confirmNeedsAck && (
              <label className="mt-3 flex min-h-[48px] cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirm.acknowledged}
                  onChange={(event) => setConfirm({ ...confirm, acknowledged: event.target.checked })}
                  className="mt-1 h-5 w-5"
                />
                <span>I understand this model is {confirmEntry?.verificationStatus === "EXPERIMENTAL" ? "experimental and " : ""}not verified on this device. Large downloads may take a while.</span>
              </label>
            )}
            {confirmLarge && (
              <label className="mt-2 flex min-h-[48px] cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirm.seconded}
                  onChange={(event) => setConfirm({ ...confirm, seconded: event.target.checked })}
                  className="mt-1 h-5 w-5"
                />
                <span>I understand this download is about {formatBytes(confirm.bytes)}.</span>
              </label>
            )}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setConfirm(null)} className="min-h-[48px] w-full rounded-m3-xs border border-outline-variant px-4 sm:w-auto">Cancel</button>
              <button type="button" onClick={() => void confirmDownloadNow()} disabled={!confirmReady} className="min-h-[48px] w-full rounded-m3-xs bg-on-surface px-4 text-surface disabled:opacity-40 sm:w-auto">
                Confirm download
              </button>
            </div>
            {!confirmReady && <p className="mt-2 text-xs text-on-surface-variant">Confirm remains disabled until the acknowledgement is recorded.</p>}
          </div>
        </div>
      )}

      {exportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
          <div ref={exportRef} role="dialog" aria-modal="true" aria-label="Export models" tabIndex={-1} className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-m3-lg bg-surface p-5">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold">Export models</h2>
              <button type="button" onClick={() => setExportOpen(false)} aria-label="Close export" className="flex min-h-[48px] min-w-[48px] items-center justify-center"><X aria-hidden size={20} /></button>
            </div>
            {installableForExport.length === 0 ? (
              <p className="mt-2 text-sm text-on-surface-variant">No installed models are available to export yet.</p>
            ) : (
              <>
                <ul className="mt-3 space-y-1">
                  {installableForExport.map((model) => (
                    <li key={model.entryId}>
                      <label className="flex min-h-[48px] cursor-pointer items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={exportSelected.includes(model.entryId)}
                          onChange={(event) => setExportSelected((prev) => event.target.checked ? [...prev, model.entryId] : prev.filter((id) => id !== model.entryId))}
                          className="h-5 w-5"
                        />
                        <span>{model.label} · {formatBytes(model.bytes)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-sm text-on-surface-variant">
                  {exportSelected.length} model{exportSelected.length === 1 ? "" : "s"} · {formatBytes(exportTotal)}
                </p>
                <button type="button" onClick={handleExportNow} disabled={exportBusy || exportSelected.length === 0} className="mt-3 min-h-[48px] w-full rounded-m3-xs bg-on-surface px-4 text-surface disabled:opacity-40">
                  {exportBusy ? "Exporting…" : "Choose destination & export"}
                </button>
              </>
            )}
            {exportResults && (
              <ul className="mt-3 space-y-1 text-sm" aria-label="Export results">
                {exportResults.map((result) => (
                  <li key={result.entryId}>{result.ok ? `✓ ${result.fileName}` : `✕ ${result.fileName} — ${result.reason ?? "Export failed"}`}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {inspection && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
          <div ref={importRef} role="dialog" aria-modal="true" aria-label="Import model" tabIndex={-1} className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-m3-lg bg-surface p-5">
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold">Import model</h2>
              <button type="button" onClick={() => void discardInspection()} aria-label="Close import" className="flex min-h-[48px] min-w-[48px] items-center justify-center"><X aria-hidden size={20} /></button>
            </div>
            {!inspection.unknown ? (
              <>
                <p className="mt-2 text-sm font-medium">Model recognized</p>
                <p className="mt-1 text-sm text-on-surface-variant">✓ Matches FindBack catalogue · ✓ Package integrity verified</p>
                <button type="button" onClick={handleCommitKnown} className="mt-4 min-h-[48px] w-full rounded-m3-xs bg-on-surface px-4 text-surface">Install</button>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm font-medium">New model</p>
                <p className="mt-1 text-sm text-on-surface-variant">Detected format LiteRT-LM</p>
                <label className="mt-3 block text-sm">
                  <span>Name *</span>
                  <input
                    type="text"
                    value={importName}
                    onChange={(event) => setImportName(event.target.value)}
                    maxLength={64}
                    aria-label="Model name"
                    className="mt-1 min-h-[48px] w-full rounded-m3-xs border border-outline-variant bg-surface px-3"
                  />
                </label>
                <fieldset className="mt-3">
                  <legend className="text-sm">Use for *</legend>
                  <div className="mt-1 flex gap-2" role="radiogroup" aria-label="Model role">
                    {(["Text", "Vision"] as const).map((role) => (
                      <button
                        key={role}
                        type="button"
                        role="radio"
                        aria-checked={importRole === role}
                        disabled={probeBusy}
                        onClick={() => { setImportRole(role); setProbeResult(null); }}
                        className={`min-h-[48px] flex-1 rounded-m3-xs border px-3 text-sm ${importRole === role ? "border-on-surface bg-on-surface text-surface" : "border-outline-variant"}`}
                      >
                        {role === "Text" ? "Text" : "Images"}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="mt-3 block text-sm">
                  <span>Description</span>
                  <textarea
                    value={importDescription}
                    onChange={(event) => setImportDescription(event.target.value)}
                    maxLength={280}
                    aria-label="Model description"
                    rows={2}
                    className="mt-1 w-full rounded-m3-xs border border-outline-variant bg-surface px-3 py-2"
                  />
                </label>
                {!probeResult && (
                  <button type="button" onClick={handleProbe} disabled={probeBusy} className="mt-4 min-h-[48px] w-full rounded-m3-xs bg-on-surface px-4 text-surface disabled:opacity-40">
                    {probeBusy ? "Testing compatibility…" : "Test compatibility"}
                  </button>
                )}
                {probeResult?.ready && (
                  <>
                    <p role="status" className="mt-3 text-sm">Compatibility test passed · Measured on this device{probeResult.loadMs != null ? ` · load ${probeResult.loadMs} ms` : ""}{probeResult.inferenceMs != null ? ` · inference ${probeResult.inferenceMs} ms` : ""}</p>
                    <button type="button" onClick={() => handleAddImported(false)} className="mt-3 min-h-[48px] w-full rounded-m3-xs bg-on-surface px-4 text-surface">Add to model library</button>
                  </>
                )}
                {probeResult && !probeResult.ready && probeResult.lowMemory && (
                  <>
                    <p role="status" className="mt-3 text-sm">Model appears valid. There wasn&apos;t enough available memory to complete the compatibility test.</p>
                    <div className="mt-3 flex flex-col gap-2">
                      <button type="button" onClick={() => handleAddImported(true)} className="min-h-[48px] w-full rounded-m3-xs bg-on-surface px-4 text-surface">Keep anyway</button>
                      <button type="button" onClick={handleProbe} className="min-h-[48px] w-full rounded-m3-xs border border-outline-variant px-4">Try again</button>
                      <button type="button" onClick={() => void discardInspection()} className="min-h-[48px] w-full rounded-m3-xs border border-outline-variant px-4 text-error">Remove</button>
                    </div>
                  </>
                )}
                {probeResult && !probeResult.ready && !probeResult.lowMemory && (
                  <>
                    <p role="alert" className="mt-3 text-sm text-error">This model cannot run with this FindBack build{probeResult.reason ? ` — ${probeResult.reason}` : ""}. Nothing was added.</p>
                    <button type="button" onClick={() => void discardInspection()} className="mt-3 min-h-[48px] w-full rounded-m3-xs border border-outline-variant px-4 text-error">Remove staged model</button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
