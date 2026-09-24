/**
 * Compact six-model manager screen (Phase A revision 04).
 *
 * Mounted at `/offline-ai`. Renders the green presentational
 * `ModelManagerView` with real native state:
 * - SmolVLM2 500M through the image `VlmBridge`;
 * - Qwen3 0.6B Dynamic INT4 through the qualified text lifecycle;
 * - four pinned raw candidates through `getCandidateHost()`;
 * - global Import/Export through `getTransferHost()`.
 *
 * All entry actions route through one explicit dispatcher
 * (`executeManagerAction`, keyed by catalogue entry identity via
 * `actionOwnerFor`): Smol hits the image lifecycle, Qwen the text
 * lifecycle, experimental candidates the candidate host, imported rows the
 * transfer host. No per-button bridge guessing.
 *
 * Known release-package downloads derive from the catalogue release
 * record: UNPUBLISHED stays honestly Unavailable, and a future PUBLISHED
 * flip enables the buttons with no UI change. Readiness renders only from
 * verified installation/readiness evidence — never from optimistic local
 * overrides. Only entries with a wired role-safe runtime path offer Use.
 * New flows use dialogs, never window.prompt/confirm.
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
  actionOwnerFor,
  applyLiveState,
  compactDescriptors,
  importedToManagerModels,
  QWEN_ENTRY_ID,
  SMOL_ENTRY_ID,
} from "../services/models/compactManager";
import { bridgeModelIdForEntry, hasUnpublishedDistribution, isExperimentalCandidateEntryId, SHIPPED_CATALOGUE_ENTRIES, UNPUBLISHED_DISTRIBUTION_MESSAGE } from "../services/models/shippedCatalogue";
import { activateQwenText, isTextReadySelfTest, shellTextSeamsFromBridgeStatus, type QwenLifecycleBridge } from "../services/models/qwenLifecycle";
import { activateModel } from "../services/models/modelActivation";
import { isTextRuntimePresent, QWEN_TEXT_BRIDGE_MODEL_ID } from "../services/models/textRuntime";
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
  cancelInference?(): Promise<void>;
  release?(): Promise<void>;
  /**
   * Qualified text download/delete lifecycle (see `QwenLifecycleBridge`).
   * Optional: present only on native builds that wire the text transfer
   * path. Absent methods fail closed with an honest unavailable error —
   * never invent a native call, never fall through to another lifecycle.
   */
  downloadTextModel?: QwenLifecycleBridge["downloadTextModel"];
  pauseTextDownload?: QwenLifecycleBridge["pauseTextDownload"];
  resumeTextDownload?: QwenLifecycleBridge["resumeTextDownload"];
  cancelTextDownload?: QwenLifecycleBridge["cancelTextDownload"];
  deleteTextModel?: QwenLifecycleBridge["deleteTextModel"];
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

/** Bridge-level image model id backing the recommended SmolVLM2 entry. */
export const SMOL_BRIDGE_ID = "smolvlm2-500m" as const;

const LARGE_DOWNLOAD_BYTES = 500 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function entryById(id: string) {
  return SHIPPED_CATALOGUE_ENTRIES.find((entry) => entry.id === id) ?? null;
}

export interface ManagerActionContext {
  model: ManagerModel;
  vlm: CompactVlmSeam | null;
  candidates: CandidateHost | null;
  transfers: TransferHost | null;
  vlmStates: ReadonlyArray<{ id: string; state: string }>;
  textStatus: { textInstalled: boolean; textReady: boolean } | null;
  activeId: string | null;
  ramMb: number | null;
  pickTestImage: () => Promise<string | null>;
  onBecameActive: (entryId: string) => void;
  onImportedDeleted: (entryId: string) => void;
  refresh: () => Promise<void>;
}

function requireVlm(ctx: ManagerActionContext) {
  if (!ctx.vlm) throw new Error("The image runtime is missing in this build. Nothing changed.");
  return ctx.vlm;
}

function requireCandidates(ctx: ManagerActionContext) {
  if (!ctx.candidates) throw new Error("Candidate downloads are unavailable in this build. Nothing changed.");
  return ctx.candidates;
}

async function executeImageAction(entryId: string, action: ManagerAction, ctx: ManagerActionContext): Promise<void> {
  const vlm = requireVlm(ctx);
  switch (action) {
    case "download": {
      const entry = entryById(entryId);
      if (entry && hasUnpublishedDistribution(entry)) throw new Error(UNPUBLISHED_DISTRIBUTION_MESSAGE + " Download is unavailable.");
      await vlm.downloadModel(SMOL_BRIDGE_ID);
      await ctx.refresh();
      return;
    }
    case "pause":
      await vlm.pauseDownload(SMOL_BRIDGE_ID);
      break;
    case "resume":
      await vlm.resumeDownload(SMOL_BRIDGE_ID);
      break;
    case "cancel":
      await vlm.cancelDownload(SMOL_BRIDGE_ID);
      break;
    case "verify": {
      const uri = await ctx.pickTestImage();
      if (!uri) throw new Error("Choose a test photo to verify this vision model. Nothing changed.");
      const result = await vlm.runGpuSelfTest(SMOL_BRIDGE_ID, uri);
      if (result?.state !== "GPU_AVAILABLE") {
        throw new Error("This model cannot run with this FindBack build. See Details for the reason.");
      }
      // Readiness renders from the refreshed authoritative native state only.
      await ctx.refresh();
      return;
    }
    case "use": {
      const entry = entryById(entryId);
      if (!entry) throw new Error("No executable runtime is wired for this entry in this build.");
      if (typeof vlm.cancelInference !== "function" || typeof vlm.release !== "function") {
        throw new Error("No executable image runtime is wired for this entry in this build.");
      }
      const result = await activateModel(vlm as never, entry, {
        currentResidentId: ctx.activeId,
        availableFreeRamMb: ctx.ramMb,
        advancedConfirmed: true,
        runtimeCapability: "RUNTIME_AVAILABLE",
      });
      if (!result.ok) throw new Error(result.reason);
      if (!result.alreadyActive) ctx.onBecameActive(entryId);
      return;
    }
    case "delete":
      await vlm.deleteModel(SMOL_BRIDGE_ID);
      await ctx.refresh();
      return;
    case "tryAgain":
      await ctx.refresh();
      return;
  }
  await ctx.refresh();
}

async function executeTextAction(entryId: string, action: ManagerAction, ctx: ManagerActionContext): Promise<void> {
  const vlm = requireVlm(ctx);
  switch (action) {
    case "download": {
      const entry = entryById(entryId);
      if (!entry) throw new Error("No executable text runtime is wired for this entry in this build.");
      if (hasUnpublishedDistribution(entry)) throw new Error(UNPUBLISHED_DISTRIBUTION_MESSAGE + " Download is unavailable.");
      if (typeof vlm.downloadTextModel !== "function") {
        throw new Error("No executable text download is wired for this entry in this build. Nothing changed.");
      }
      await vlm.downloadTextModel({ modelId: QWEN_TEXT_BRIDGE_MODEL_ID });
      await ctx.refresh();
      return;
    }
    case "pause":
      if (typeof vlm.pauseTextDownload !== "function") {
        throw new Error("Pause is unavailable for the text runtime in this build. Nothing changed.");
      }
      await vlm.pauseTextDownload({ modelId: QWEN_TEXT_BRIDGE_MODEL_ID });
      break;
    case "resume":
      if (typeof vlm.resumeTextDownload !== "function") {
        throw new Error("Resume is unavailable for the text runtime in this build. Nothing changed.");
      }
      await vlm.resumeTextDownload({ modelId: QWEN_TEXT_BRIDGE_MODEL_ID });
      break;
    case "cancel":
      if (typeof vlm.cancelTextDownload !== "function") {
        throw new Error("Cancel is unavailable for the text runtime in this build. Nothing changed.");
      }
      await vlm.cancelTextDownload({ modelId: QWEN_TEXT_BRIDGE_MODEL_ID });
      break;
    case "verify": {
      if (typeof vlm.runTextSelfTest !== "function") {
        throw new Error("No executable text runtime is wired for this entry in this build, so it cannot be verified here.");
      }
      const result = await vlm.runTextSelfTest(QWEN_TEXT_BRIDGE_MODEL_ID);
      if (!isTextReadySelfTest({ ready: result?.ready === true, state: result?.state ?? "" })) {
        throw new Error("This model cannot run with this FindBack build. See Details for the reason.");
      }
      // Readiness renders from the refreshed authoritative native state only.
      await ctx.refresh();
      return;
    }
    case "use": {
      const entry = entryById(entryId);
      if (!entry) throw new Error("No executable runtime is wired for this entry in this build.");
      if (!isTextRuntimePresent(vlm) || typeof vlm.cancelInference !== "function" || typeof vlm.release !== "function") {
        throw new Error("Cannot activate: no executable text runtime for this entry in this build.");
      }
      const result = await activateQwenText(vlm as never, entry, {
        currentResidentId: ctx.activeId,
        availableFreeRamMb: ctx.ramMb,
        advancedConfirmed: true,
        textRuntimePresent: true,
        runtimeReady: ctx.textStatus?.textReady === true,
      });
      if (!result.ok) throw new Error(result.reason);
      if (!result.alreadyActive) ctx.onBecameActive(entryId);
      return;
    }
    case "delete":
      if (typeof vlm.deleteTextModel !== "function") {
        throw new Error("Delete is unavailable for the text runtime in this build. Nothing changed.");
      }
      await vlm.deleteTextModel({ modelId: QWEN_TEXT_BRIDGE_MODEL_ID });
      await ctx.refresh();
      return;
    case "tryAgain":
      await ctx.refresh();
      return;
  }
  await ctx.refresh();
}

async function executeCandidateAction(entryId: string, action: ManagerAction, ctx: ManagerActionContext): Promise<void> {
  const candidates = requireCandidates(ctx);
  switch (action) {
    case "download":
    case "resume":
      // The candidate host has no separate resume op: re-issuing download
      // resumes staged bytes.
      await candidates.download(entryId);
      await ctx.refresh();
      return;
    case "pause":
      await candidates.pause(entryId);
      break;
    case "cancel":
      await candidates.cancel(entryId);
      break;
    case "verify": {
      const needsImage = entryId === "lfm2.5-vl-450m";
      const uri = needsImage ? await ctx.pickTestImage() : undefined;
      if (needsImage && !uri) throw new Error("Choose a test photo to verify this vision model. Nothing changed.");
      const probe = await candidates.verify(entryId, uri ?? undefined);
      if (!probe?.ready) {
        throw new Error("This model cannot run with this FindBack build. See Details for the reason.");
      }
      // Readiness renders from the refreshed authoritative native state only.
      await ctx.refresh();
      return;
    }
    case "delete":
      await candidates.delete(entryId);
      await ctx.refresh();
      return;
    case "use": {
      // Verified candidate Use: native installs the resident engine for the
      // entry's role (vision or text) and later inference routes to it.
      const proof = await candidates.use(entryId);
      if (!proof?.ready) {
        throw new Error("This model could not be activated in this build. Nothing changed.");
      }
      ctx.onBecameActive(entryId);
      await ctx.refresh();
      return;
    }
    case "tryAgain":
      await ctx.refresh();
      return;
  }
  await ctx.refresh();
}

/**
 * Single entry-id action dispatcher. Every manager action routes by
 * catalogue entry identity (`actionOwnerFor`) to exactly one lifecycle —
 * image, text, candidate, or transfer — and finishes with an authoritative
 * native refresh. Throws honest unavailable errors; never guesses a bridge.
 */
export async function executeManagerAction(entryId: string, action: ManagerAction, ctx: ManagerActionContext): Promise<void> {
  const owner = actionOwnerFor(entryId, action, ctx.model.category);
  switch (owner) {
    case "image":
      return executeImageAction(entryId, action, ctx);
    case "text":
      return executeTextAction(entryId, action, ctx);
    case "candidate":
      return executeCandidateAction(entryId, action, ctx);
    case "transfer": {
      if (!ctx.transfers) throw new Error("Delete is unavailable in this build.");
      await ctx.transfers.deleteImported(entryId);
      ctx.onImportedDeleted(entryId);
      return;
    }
    case "none":
      if (action === "tryAgain") {
        await ctx.refresh();
        return;
      }
      if (action === "use") {
        throw new Error("Verified only — no executable runtime is wired for this entry in this build, so it cannot run analysis here.");
      }
      if (ctx.model.category === "IMPORTED") {
        throw new Error("Imported models verify during import. Delete and re-import to test again.");
      }
      throw new Error("This action is unavailable for this entry in this build.");
  }
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
      textEntryId: QWEN_ENTRY_ID,
      candidateStates,
      candidateProgress,
      downloadedBytesByBridgeId: vlmProgress,
      availableFreeRamMb: ramMb,
      canDownloadFor: (entryId) => {
        const entry = entryById(entryId);
        if (!entry) return false;
        // Release-record-driven enablement: UNPUBLISHED stays honestly
        // disabled; a future PUBLISHED flip enables with no UI change.
        // Release packages bind their image/text lifecycle via the vlm
        // seam; raw candidates bind the candidate host.
        if (hasUnpublishedDistribution(entry)) return false;
        if (entry.distribution != null) return vlm != null;
        return candidates != null;
      },
    }).map((model) => {
      const entry = entryById(model.entryId);
      let next = model;
      if (entry && hasUnpublishedDistribution(entry) && model.state === "NOT_INSTALLED") {
        next = { ...next, state: "UNAVAILABLE" as ManagerStatus, canDownload: false, error: UNPUBLISHED_DISTRIBUTION_MESSAGE };
      }
      // Honest Use: only wired role-safe runtime paths (Smol image, Qwen
      // text with a present runtime) may offer Use, and only once the
      // runtime reports runnable state (READY). Probe-only entries stay
      // Use-free with Details/retest.
      const canUse =
        model.entryId === SMOL_ENTRY_ID ? vlm != null
        : model.entryId === QWEN_ENTRY_ID ? isTextRuntimePresent(vlm)
        : isExperimentalCandidateEntryId(model.entryId) ? candidates != null && next.state === "READY"
        : false;
      return { ...next, canUse };
    });
    return [...live, ...importedToManagerModels(imported)];
  }, [base, vlmStates, textStatus, candidateStates, candidateProgress, vlmProgress, ramMb, candidates, vlm, imported]);

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

  const buildActionContext = useCallback((entryId: string): ManagerActionContext | null => {
    const model = models.find((m) => m.entryId === entryId) ?? null;
    if (!model) return null;
    return {
      model,
      vlm,
      candidates,
      transfers,
      vlmStates,
      textStatus,
      activeId,
      ramMb,
      pickTestImage: async () => (await pickTestImage?.()) ?? null,
      onBecameActive: (id) => {
        setActiveId(id);
        saveResidentEntryId(id);
      },
      onImportedDeleted: (id) => {
        if (mountedRef.current) setImported((prev) => prev.filter((m) => m.entryId !== id));
      },
      refresh,
    };
  }, [models, vlm, candidates, transfers, vlmStates, textStatus, activeId, ramMb, pickTestImage, refresh]);

  const confirmDownloadNow = useCallback(async () => {
    if (!confirm) return;
    const { entryId } = confirm;
    setConfirm(null);
    const ctx = buildActionContext(entryId);
    if (!ctx) {
      fail("Unknown model entry. Nothing changed.");
      return;
    }
    // The confirmation dialog gates the download; the single dispatcher
    // owns the lifecycle routing from here.
    await runGuarded(async () => {
      await executeManagerAction(entryId, "download", ctx);
    });
  }, [confirm, buildActionContext, refresh, runGuarded, fail]);

  const handleAction = useCallback((entryId: string, action: ManagerAction) => {
    if (action === "download") {
      void startDownload(entryId);
      return;
    }
    const ctx = buildActionContext(entryId);
    if (!ctx) {
      fail("Unknown model entry. Nothing changed.");
      return;
    }
    void runGuarded(async () => {
      await executeManagerAction(entryId, action, ctx);
    });
  }, [buildActionContext, fail, runGuarded, startDownload]);

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
  const knownMatch = inspection && !inspection.unknown ? entryById(inspection.entryId) : null;
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
        models={models}
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
                <p className="mt-1 text-sm" aria-label="Matched catalogue entry">
                  {knownMatch?.displayName ?? inspection.entryId} · {inspection.entryId}
                </p>
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
