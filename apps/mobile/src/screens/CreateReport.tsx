import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { extractYouTubeId, isReleasedCategory, type Category, type PostType } from "@findback/shared";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { Segmented } from "../components/Segmented";
import { CategoryField } from "../components/CategoryField";
import { RichTextEditor, tiptapToMarkdown } from "../components/RichTextEditor";
import { measureDescription } from "../services/richText";
import type { Editor } from "@tiptap/react";
import { LocationPicker, type LocationValue } from "../components/LocationPicker";
import { YouTubeEmbed } from "../components/YouTubeEmbed";
import { announce } from "../components/LiveRegion";
import { MAX_REPORT_PHOTOS, publishReport, publishReportWithPhotos } from "../services/posts";
import { clearDraft, draftGeneration, draftIsMeaningful, loadDraft, saveDraft } from "../services/reportDraft";
import type { ReportDraft, ReportPhotoRef } from "../services/reportDraft";
import { friendlyError } from "../utils/friendlyErrors";
import { isNativeCameraAvailable, normalizeForUpload, type PickedPhoto } from "../services/photo";
import { chooseNativeImage, chooseNativeImages, importNativeImageUri, importedImageToFile } from "../services/media/nativeMedia";
import { ACCEPTED_STILL_FORMATS_LABEL, ACCEPTED_STILL_MIME_TYPES, isAcceptedStillMime, UPLOAD_MAX_BYTES } from "../services/media/mediaPolicy";
import { ReportDatePicker } from "../components/ReportDatePicker";
import { AnimatePresence, motion } from "framer-motion";
import { ReportMediaPicker } from "../components/ReportMediaPicker";
import { PhotoLightbox } from "../components/PhotoLightbox";
import type { PhotoLightboxOriginRect } from "../components/PhotoLightbox";
import { fadeVariants, motionDurations, motionEasings } from "../components/uiMotion";
import { createHashRegistry, formatBatchNotice, processReportBatch } from "../services/media/reportBatch";
import { computeSha256Hex } from "../services/media/dedupe";
import {
  dropStashedPhoto,
  clearPhotoStore,
  getStashedPhoto,
  getStashedPhotoMeta,
  persistStashedPhotos,
  reviveNativePhotos,
  restoreStashedPhotos,
  stashPhotoFile,
} from "../services/photoStore";
import { todayInputValue, isFutureDate } from "../utils/dates";
import { profileFor } from "../services/ai/modelProfiles";
import type { GenerateFn } from "../services/ai/types";
import {
  NARROW_TASK_PROFILE_ID,
  generateForCategoryLive,
  generateForFieldsLive,
} from "../services/liveNarrowTasks";
import {
  DROPPED_CATEGORY_NOTE,
  suggestReportFields,
  type ReportFieldSuggestion,
} from "../services/reportFieldSuggestions";
import {
  DROPPED_CATEGORY_SUGGESTION_NOTE,
  suggestCategoryForText,
  type CategorySuggestion,
} from "../services/categorySuggestion";
import { diag, startActionTrace, clearAmbientTrace } from "../services/diag";
import { PublishOutcomeUncertainError } from "../services/publishOutcome";


const inputCls =
  "w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none";

/** Batch status notice crossfade (queued -> processing -> ready/failed). */
const statusCrossfade = {
  type: "tween",
  duration: motionDurations.fast,
  ease: motionEasings.inOut,
} as const;

/** Upload progress bar interpolates only as far as real observed progress. */
const uploadBarTransition = {
  type: "tween",
  duration: motionDurations.standard,
  ease: motionEasings.out,
} as const;

/** Upload transport ceiling (canonical UPLOAD_MAX_BYTES — mirrors the bucket
 * safety bound) applied to the normalized derivative, never to the user's
 * source. The accepted set is the canonical ACCEPTED_STILL_MIME_TYPES and
 * the gate is isAcceptedStillMime (L-CONSOLIDATE: no local list — the
 * picker, the gates below, and the advertised sentence all read one
 * source). Sources up to 100 MB in JPEG/PNG/WebP/GIF/HEIC/HEIF/AVIF/BMP
 * are accepted when platform-readable; normalization downsamples to a
 * bounded derivative first. */
const ACCEPTED_IMAGE_TYPES: readonly string[] = ACCEPTED_STILL_MIME_TYPES;
const MAX_IMAGE_BYTES = UPLOAD_MAX_BYTES;

/**
 * FBX-001: one native selection item. Preparation is deferred to `resolve` so
 * the batch can convert items one at a time (order, per-item failure, progress,
 * cancel) through the canonical native processor — never through a File/HTML
 * bridge fallback. A camera capture resolves its already-bounded derivative; a
 * gallery item imports its granted `content://` URI.
 */
interface NativePick {
  picked: PickedPhoto;
  resolve: (opts?: { signal?: AbortSignal }) => Promise<File>;
}

/** Client-side validation mirrors server (W6 #17). */
const TITLE_MIN = 3;
const TITLE_MAX = 120;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 3000;
const LOCATION_LABEL_MAX = 200;

/**
 * Cooperative publish cancel: thrown from the upload onProgress callback when
 * the user cancels. uploadPhotos stages strictly in order and calls onProgress
 * after each staged file, so throwing here skips every remaining file while
 * uploadPhotos' own catch removes exactly this attempt's staged objects.
 */
class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled. Your photos are kept — try again.");
    this.name = "UploadCancelledError";
  }
}

/** Check if a date string is a valid calendar date in YYYY-MM-DD format. */
function isValidCalendarDate(isoDate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
  const parts = isoDate.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** A draft photo came from native capture but has no stashed File yet. */
function canCreateObjectUrl(): boolean {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

/**
 * Preview URL for a report photo. ALWAYS the validated File's object URL —
 * never the picker's original URI. Picker format metadata is unreliable (an
 * HEIC file mislabeled as JPG converts fine in the native processor but would
 * preview as a broken original), while the File bytes are exactly what was validated,
 * hashed and will be published. The original native URI is retained
 * separately on `picked` for recovery and provenance. Callers revoke blob
 * URLs on remove/clear/unmount.
 */
function previewUrlFor(file: File): string {
  return canCreateObjectUrl() ? URL.createObjectURL(file) : "";
}

/** Keeps only categories that are live for submission; staged/unknown ones are dropped. */
function releasedCategoryOrEmpty(value: string | null | undefined): Category | "" {
  return value && isReleasedCategory(value) ? (value as Category) : "";
}

/** Ordered photo ids for a draft: the durable list, else the legacy first-photo field. */
function draftPhotoIds(draft: ReportDraft | null): string[] {
  if (draft?.photoIds?.length) return draft.photoIds;
  return draft?.photoId ? [draft.photoId] : [];
}

/** Ref lookup for a photo id: the durable per-photo ref, else legacy first-photo fields. */
function draftPhotoRef(draft: ReportDraft | null, id: string): ReportPhotoRef | null {
  const ref = draft?.photoRefs?.find((r) => r.id === id);
  if (ref) return ref;
  if (draft?.photoId === id) {
    return {
      id,
      nativeUri: draft.photoNativeUri,
      webPath: draft.photoWebPath,
      format: draft.photoFormat,
    };
  }
  return null;
}

/** Native picked value for a durable ref (null when there is no native URI). */
function refToPicked(ref: ReportPhotoRef | null): PickedPhoto | null {
  const uri = ref?.nativeUri;
  if (!uri || uri.startsWith("blob:")) return null;
  const web = ref?.webPath;
  return {
    nativeUri: uri,
    webPath: web && !web.startsWith("blob:") ? web : uri,
    format: ref?.format ?? "jpg",
    id: crypto.randomUUID(),
    motionPhoto: ref?.motionPhoto,
  };
}

/** Draft photos with a native ref but no stashed File (revivable via importNativeImageUri). */
function findPendingNativeRestores(
  draft: ReportDraft | null,
): { id: string; picked: PickedPhoto }[] {
  const pending: { id: string; picked: PickedPhoto }[] = [];
  for (const id of draftPhotoIds(draft)) {
    if (getStashedPhoto(id)) continue;
    const ref = draftPhotoRef(draft, id);
    const uri = ref?.nativeUri;
    if (!uri || uri.startsWith("blob:")) continue;
    const web = ref?.webPath;
    pending.push({
      id,
      picked: {
        nativeUri: uri,
        webPath: web && !web.startsWith("blob:") ? web : uri,
        format: ref?.format ?? "jpg",
        id: crypto.randomUUID(),
      },
    });
  }
  return pending;
}

/**
 * Injectable AI transports for the suggestion panel below (Lane C).
 * Defaults are the live local-first composers (on-device route with
 * OpenRouter fallback); the seam stays overridable so tests can inject
 * fakes. Suggestions-only contract is unchanged (never publish, never
 * auto-apply).
 */
export const aiSuggestDeps: {
  generateForFields: GenerateFn;
  generateForCategory: GenerateFn;
} = {
  generateForFields: generateForFieldsLive,
  generateForCategory: generateForCategoryLive,
};

export function CreateReport() {
  const { user } = useAuth();
  // A mounted route can outlive an auth change. Unmount its entire form/editor
  // before the new account can see or autosave any of the previous owner's state.
  return <ReportForm key={user?.id ?? "signed-out"} />;
}

function ReportForm() {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Per-account draft: each signed-in account restores only its own report.
  const accountId = user?.id ?? null;
  const renderGeneration = draftGeneration(accountId);
  const [initialDraft] = useState(() => loadDraft(accountId));
  const [type, setType] = useState<PostType>(initialDraft?.type ?? "LOST");
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [category, setCategory] = useState<Category | "">(
    releasedCategoryOrEmpty(initialDraft?.category),
  );
  const [eventDate, setEventDate] = useState(initialDraft?.eventDate ?? todayInputValue());
  const [location, setLocation] = useState<LocationValue>(
    initialDraft?.location ?? {
      label: "",
      latitude: null,
      longitude: null,
    },
  );
  const [youtubeUrl, setYoutubeUrl] = useState(initialDraft?.youtubeUrl ?? "");
  /** Ordered report photos (0–5), restored from the durable per-account draft. */
  interface ReportPhoto {
    id: string;
    file: File;
    previewUrl: string;
    picked: PickedPhoto | null;
    /** SHA-256 of raw bytes, used for exact duplicate detection. */
    hash?: string;
  }
  function initialPhotos(draft: ReportDraft | null): ReportPhoto[] {
    const restored: ReportPhoto[] = [];
    for (const id of draftPhotoIds(draft).slice(0, MAX_REPORT_PHOTOS)) {
      const stashed = getStashedPhoto(id);
      if (!stashed || restored.some((p) => p.id === id)) continue;
      const ref = draftPhotoRef(draft, id);
      const nativeUri = ref?.nativeUri;
      const restoredPicked =
        nativeUri && !nativeUri.startsWith("blob:")
          ? {
              nativeUri,
              webPath: ref?.webPath && !ref.webPath.startsWith("blob:") ? ref.webPath : nativeUri,
              format: ref?.format ?? "jpg",
              id: crypto.randomUUID(),
            }
          : (getStashedPhotoMeta(id)?.picked ?? null);
      restored.push({
        id,
        file: stashed,
        previewUrl: previewUrlFor(stashed),
        picked: restoredPicked,
      });
    }
    return restored;
  }
  const [photos, setPhotos] = useState<ReportPhoto[]>(() => initialPhotos(initialDraft));
  const photosRef = useRef(photos);
  const [photoRecoveryReady, setPhotoRecoveryReady] = useState(() => draftPhotoIds(initialDraft).length === 0);
  const restorePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const [editorResetKey, setEditorResetKey] = useState(0);
  const [previewPhotoId, setPreviewPhotoId] = useState<string | null>(null);
  /** Viewport rect of the tile that opened the lightbox (FLIP origin). */
  const [previewOrigin, setPreviewOrigin] = useState<PhotoLightboxOriginRect | null>(null);
  const hashRegistryRef = useRef(createHashRegistry());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Serializes overlapping picker work (R-073): a second action queues behind
  // the first instead of racing the shared hash registry or the 5-photo cap.
  // Coalesced (Lane C): rapid gallery re-taps must not pile full batches, so
  // a still-queued gallery batch is superseded by the latest selection (drop
  // the obsolete queued batch, keep the latest). Camera shutter presses are
  // never coalescable — each is an irreplaceable capture that must be kept.
  // The backlog is surfaced in the status line (pickBacklog) instead of being
  // silently inherited at submit. pickQueueRef always drains to idle so
  // onSubmit still snapshots settled work.
  interface PendingPickBatch {
    kind: "native" | "web";
    /** A still-queued batch with coalescable=true is superseded by a newer one. */
    coalescable: boolean;
    nativeItems?: NativePick[];
    webItems?: File[];
  }
  const pickQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pickRunningRef = useRef(false);
  const pickPendingRef = useRef<PendingPickBatch[]>([]);
  const pickDrainResolveRef = useRef<(() => void) | null>(null);
  const [pickBacklog, setPickBacklog] = useState(0);
  async function drainPickQueue(): Promise<void> {
    for (;;) {
      const next = pickPendingRef.current.shift();
      setPickBacklog(pickPendingRef.current.length);
      if (!next) break;
      try {
        if (next.kind === "native") await runNativeBatch(next.nativeItems ?? []);
        else await runWebBatch(next.webItems ?? []);
      } catch {
        // Per-batch failures are reported via screen state, never via the queue.
      }
    }
    pickRunningRef.current = false;
    setPickBacklog(0);
    pickDrainResolveRef.current?.();
    pickDrainResolveRef.current = null;
  }
  const enqueuePending = (batch: PendingPickBatch): void => {
    const pending = pickPendingRef.current;
    const tail = pending[pending.length - 1];
    if (batch.coalescable && tail?.coalescable && tail.kind === batch.kind) {
      // Drop the obsolete queued batch; the latest selection supersedes it.
      pending[pending.length - 1] = batch;
    } else {
      pending.push(batch);
    }
    setPickBacklog(pending.length);
    if (!pickRunningRef.current) {
      pickRunningRef.current = true;
      pickQueueRef.current = new Promise<void>((resolve) => {
        pickDrainResolveRef.current = resolve;
      });
      void drainPickQueue();
    }
  };
  /** Per-batch photo conversion progress ("Processing N of M") + cancel. */
  const [pickProgress, setPickProgress] = useState<{ done: number; total: number } | null>(null);
  const pickAbortRef = useRef<AbortController | null>(null);
  function cancelPick(): void {
    pickAbortRef.current?.abort();
  }
  /** Multi-photo publish progress ("Uploading i/N") + cooperative cancel. */
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  function cancelUpload(): void {
    uploadAbortRef.current?.abort();
  }
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(initialDraft?.publishOutcome === "uncertain");
  const [error, setError] = useState<string | null>(null);
  const [photoSaveWarning, setPhotoSaveWarning] = useState(false);
  const [photoRestoreError, setPhotoRestoreError] = useState(false);
  const [photoLimitNotice, setPhotoLimitNotice] = useState<string | null>(null);
  // Per-file pick failures ("name: reason"), reset on every new pick. The old
  // single generic message could only describe the last failure when several
  // files failed for different reasons.
  const [photoFileErrors, setPhotoFileErrors] = useState<string[]>([]);
  // FBX-001: a native item that could not be prepared becomes a named, retryable
  // row (not a silent drop, not a File-bridge fallback). The row keeps the item's
  // own resolver so Retry re-runs the canonical native processor for just that
  // item; Remove discards it. Reset on every new pick.
  interface FailedPick {
    key: string;
    /** 1-based label within the selection that produced it. */
    position: number;
    reason: string;
    pick: NativePick;
  }
  const [failedPicks, setFailedPicks] = useState<FailedPick[]>([]);
  const [fieldErrors, setFieldErrors] = useState<{
    title?: string;
    description?: string;
    category?: string;
    eventDate?: string;
    locationLabel?: string;
    youtubeUrl?: string;
  }>({});
  const submitting = useRef(false);
  const traceIdRef = useRef<string | null>(null);
  const descriptionEditorRef = useRef<Editor | null>(null);
  const descriptionLiveRef = useRef(description);
  // --- AI field suggestions (Lane C, additive only) -----------------------
  // extract-report-fields + classify-category surface here as reviewable
  // per-field patches (source-labelled, Apply/Keep each). Suggestions only:
  // Apply writes exactly one field after an explicit confirm when it would
  // replace existing text; Keep sends nothing (no setter, no network).
  // Nothing here publishes, auto-applies, or touches draft/photo lifecycle.
  const [aiSuggestInput, setAiSuggestInput] = useState("");
  const [aiFieldPatches, setAiFieldPatches] = useState<ReportFieldSuggestion[]>([]);
  const [aiFieldDroppedCategory, setAiFieldDroppedCategory] = useState(false);
  const [aiCatSuggestion, setAiCatSuggestion] = useState<CategorySuggestion | null>(null);
  const [aiCatDropped, setAiCatDropped] = useState(false);
  const [aiSuggestBusy, setAiSuggestBusy] = useState(false);
  const [aiSuggestError, setAiSuggestError] = useState<string | null>(null);
  const [aiSuggestResolved, setAiSuggestResolved] = useState<Record<string, boolean>>({});
  // Generation token: a response that resolves after
  // a newer request started — or after unmount — is stale and dropped, never
  // rendered into another request's panel.
  const aiSuggestGen = useRef(0);
  const aiSuggestAbort = useRef<AbortController | null>(null);

  function aiSuggestResolve(key: string): void {
    setAiSuggestResolved((previous) => ({ ...previous, [key]: true }));
  }

  function aiSuggestApplyField(patch: ReportFieldSuggestion): void {
    if (patch.field === "title") {
      if (title.trim() && patch.suggestedValue !== title) {
        if (!window.confirm("Replace the existing title with this reviewed AI suggestion?")) return;
      }
      setTitle(patch.suggestedValue);
      aiSuggestResolve(`field:${patch.field}`);
    } else if (patch.field === "description") {
      if (description.trim() && patch.suggestedValue !== description) {
        if (!window.confirm("Replace the existing description with this reviewed AI suggestion?")) return;
      }
      descriptionLiveRef.current = patch.suggestedValue;
      setDescription(patch.suggestedValue);
      aiSuggestResolve(`field:${patch.field}`);
    } else if (patch.field === "date") {
      // Validation gates are preserved: only a real, non-future calendar date
      // may land in the form. Free-text date hints ("yesterday") stay manual.
      if (!isValidCalendarDate(patch.suggestedValue) || isFutureDate(patch.suggestedValue)) return;
      if (eventDate !== patch.suggestedValue) {
        if (!window.confirm("Replace the existing date with this reviewed AI suggestion?")) return;
      }
      setEventDate(patch.suggestedValue);
      aiSuggestResolve(`field:${patch.field}`);
    } else if (patch.field === "category") {
      // Double-guard: built patches are released, but the form never accepts
      // an unreleased value even if a service regresses.
      if (!isReleasedCategory(patch.suggestedValue)) return;
      if (category && patch.suggestedValue !== category) {
        if (!window.confirm("Replace the existing category with this reviewed AI suggestion?")) return;
      }
      setCategory(patch.suggestedValue as Category);
      aiSuggestResolve(`field:${patch.field}`);
    }
  }

  function aiSuggestApplyCategory(suggestion: CategorySuggestion): void {
    if (!isReleasedCategory(suggestion.suggestedCategory)) return;
    if (category && suggestion.suggestedCategory !== category) {
      if (!window.confirm("Replace the existing category with this reviewed AI suggestion?")) return;
    }
    setCategory(suggestion.suggestedCategory);
    aiSuggestResolve("categorySuggestion");
  }

  function aiSuggestStop(): void {
    aiSuggestAbort.current?.abort();
  }

  async function aiSuggestRequest(): Promise<void> {
    const text = aiSuggestInput.trim() || `${title} ${description}`.trim();
    if (!text) {
      setAiSuggestError("Describe the item first — in the box above or in your title and description.");
      return;
    }
    // IF-108: both ops are served by the same on-device structured (tool) model
    // as Smart Search, so they must be parsed with that model's profile. The
    // prose profile's `[thought]` envelope truncated tool output and silently
    // dropped the whole suggestion set.
    const profile = profileFor(NARROW_TASK_PROFILE_ID);
    if (!profile) {
      setAiSuggestError("AI suggestions are unavailable right now. Continue writing manually.");
      return;
    }
    aiSuggestAbort.current?.abort();
    const gen = ++aiSuggestGen.current;
    const controller = new AbortController();
    aiSuggestAbort.current = controller;
    setAiSuggestBusy(true);
    setAiSuggestError(null);
    setAiFieldPatches([]);
    setAiFieldDroppedCategory(false);
    setAiCatSuggestion(null);
    setAiCatDropped(false);
    setAiSuggestResolved({});
    try {
      const [fieldsResult, categoryResult] = await Promise.all([
        suggestReportFields(aiSuggestDeps.generateForFields, text, profile, {
          signal: controller.signal,
        }),
        suggestCategoryForText(aiSuggestDeps.generateForCategory, text.slice(0, 280), profile, {
          signal: controller.signal,
        }),
      ]);
      if (aiSuggestGen.current !== gen) return; // stale: drop, never render
      if (fieldsResult.ok) {
        setAiFieldPatches([...fieldsResult.value.suggestions]);
        setAiFieldDroppedCategory(fieldsResult.value.droppedCategory);
      } else if (fieldsResult.error.errorClass === "CANCELLED") {
        setAiSuggestError("AI request cancelled.");
      } else {
        setAiSuggestError("Couldn't draft suggestions from that text. You can retry or continue writing manually.");
      }
      if (categoryResult.ok) {
        setAiCatSuggestion(categoryResult.value.suggestion);
        setAiCatDropped(categoryResult.value.dropped);
      } else if (categoryResult.error.errorClass === "CANCELLED") {
        setAiSuggestError("AI request cancelled.");
      } else if (fieldsResult.ok) {
        // A failed category op never blocks field patches; the failure shows
        // only when there is nothing else to review.
        setAiCatDropped(false);
      } else {
        setAiSuggestError("Couldn't draft suggestions from that text. You can retry or continue writing manually.");
      }
    } catch {
      if (aiSuggestGen.current !== gen) return; // stale: drop
      setAiSuggestError("Couldn't draft suggestions from that text. You can retry or continue writing manually.");
    } finally {
      if (aiSuggestGen.current === gen) {
        setAiSuggestBusy(false);
        aiSuggestAbort.current = null;
      }
    }
  }

  // Unmount (or StrictMode remount) invalidates any in-flight suggestion
  // request: its late resolution is stale and must never populate the panel.
  useEffect(() => () => {
    aiSuggestGen.current++;
    aiSuggestAbort.current?.abort();
  }, []);

  // Durable mount restore: rehydrate persisted photo bytes,
  // then reopen native-ref slots through photoStore's canonical revive
  // (reviveNativePhotos → FindbackMedia importNativeImageUri),
  // then merge everything into state in draft order. Never touches the editor.
  // Unrecoverable slots are NAMED (failedPhotoIds) instead of a bare boolean:
  // publish stays blocked until the user retries or explicitly removes the
  // unavailable photos, so a report can never silently publish with missing
  // attachments and the screen can never wedge in a non-publishable state.
  const [failedPhotoIds, setFailedPhotoIds] = useState<string[]>([]);
  const recoveringRef = useRef(false);

  async function recoverPhotos(isCancelled: () => boolean): Promise<void> {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    const generation = renderGeneration;
    try {
      setPhotoRestoreError(false);
      setFailedPhotoIds([]);
      const draftIds = draftPhotoIds(initialDraft).slice(0, MAX_REPORT_PHOTOS);
      const missing = new Set<string>();
      try {
        await restoreStashedPhotos(accountId);
      } catch {
        for (const id of draftIds) missing.add(id);
      }
      if (isCancelled() || generation !== draftGeneration(accountId)) return;
      const pendings = findPendingNativeRestores(initialDraft);
      // FBX-030: revive through photoStore's canonical registry path only
      // (reviveNativePhotos → importNativeImageUri). A durable ref must be a
      // granted content URI; anything else (a blob:, a deleted capture with no
      // stashed File) and any unreachable/failed processor run is classified
      // into `failed` and named below. The old HTML/File revive (photoToFile)
      // is gone: it could not read a content URI and silently produced a dead
      // attachment — this screen never falls back to it.
      const revive = await reviveNativePhotos(pendings, {
        accountId,
        isCancelled: () => isCancelled() || generation !== draftGeneration(accountId),
      });
      if (isCancelled() || generation !== draftGeneration(accountId)) return;
      for (const id of revive.failed) missing.add(id);
      const revived = new Set(revive.restored);
      for (const id of draftIds) {
        if (photosRef.current.some((p) => p.id === id)) continue;
        if (revived.has(id)) continue;
        if (getStashedPhoto(id)) continue;
        missing.add(id);
      }
      // Mixed-success contract: every recovered slot is merged into state
      // FIRST (revived Files are restashed under their ORIGINAL ids so
      // draft references, ordering and persistence stay coherent), and only
      // then are the failed slots reported. Removing an unavailable photo can
      // therefore never drop a successfully converted sibling.
      const next = [...photosRef.current];
      for (const id of draftIds) {
        if (next.some((p) => p.id === id)) continue;
        const file = getStashedPhoto(id);
        if (!file) continue;
        const ref = draftPhotoRef(initialDraft, id);
        const picked = revived.has(id)
          ? getStashedPhotoMeta(id)?.picked ?? refToPicked(ref) ?? null
          : refToPicked(ref) ?? getStashedPhotoMeta(id)?.picked ?? null;
        next.push({
          id,
          file,
          previewUrl: previewUrlFor(file),
          picked,
        });
      }
      const registry = createHashRegistry();
      const unique: ReportPhoto[] = [];
      const duplicateIds: string[] = [];
      for (const item of next) {
        if (!draftIds.includes(item.id)) {
          unique.push(item);
          continue;
        }
        try {
          const hash = await computeSha256Hex(item.file);
          if (registry.has(hash)) {
            duplicateIds.push(item.id);
            continue;
          }
          registry.add(hash);
          unique.push({ ...item, hash });
        } catch {
          unique.push(item);
        }
      }
      if (isCancelled() || generation !== draftGeneration(accountId)) return;
      for (const id of duplicateIds) dropStashedPhoto(id, accountId);
      hashRegistryRef.current = registry;
      photosRef.current = unique;
      setPhotos(unique);
      const failed = draftIds.filter((id) => missing.has(id) && !unique.some((p) => p.id === id));
      if (failed.length > 0) {
        setFailedPhotoIds(failed);
        setPhotoRestoreError(true);
        return;
      }
      setPhotoRecoveryReady(true);
    } finally {
      recoveringRef.current = false;
    }
  }

  useEffect(() => {
    let cancelled = false;
    restorePromiseRef.current = recoverPhotos(() => cancelled);
    return () => {
      cancelled = true;
    };
    // Mount-only: accountId is fixed for the signed-in session mount.
  }, []);

  /** Manual retry after a failed recovery: re-gates publish until it settles. */
  function retryPhotoRecovery(): void {
    setPhotoRecoveryReady(false);
    restorePromiseRef.current = recoverPhotos(() => false);
  }

  /**
   * Explicit, confirmed prune of the named unrecoverable slots. Draft text and
   * recovered photos are untouched; the autosave effect then persists the
   * pruned photo list, so the dead-end can never recur for these ids.
   */
  function removeUnavailablePhotos(): void {
    if (failedPhotoIds.length === 0) return;
    const labels = failedPhotoLabels(failedPhotoIds);
    if (!window.confirm(`Remove ${labels} and continue with the recovered photos? Your title, description, date and location are kept.`)) return;
    for (const id of failedPhotoIds) dropStashedPhoto(id, accountId);
    setFailedPhotoIds([]);
    setPhotoRestoreError(false);
    setPhotoRecoveryReady(true);
    announce("Unavailable photos removed. Recovered photos kept.");
  }

  /** Human labels ("Photo 2") for failed slots in draft order. */
  function failedPhotoLabels(ids: string[]): string {
    const order = draftPhotoIds(initialDraft).slice(0, MAX_REPORT_PHOTOS);
    const labels = ids.map((id) => {
      const position = order.indexOf(id);
      return position === -1 ? "a photo" : `Photo ${position + 1}`;
    });
    return labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  }

  // Preserve the draft across in-app navigation (Help and map helper) AND
  // process death: cheap JSON metadata on every form/photo change (per
  // account), photo bytes via the separate photo effect below. Legacy
  // first-photo fields are still written for older readers.
  useEffect(() => {
    if (!photoRecoveryReady) return;
    const first = photos[0] ?? null;
    saveDraft(
      {
        publishOutcome: uncertain ? "uncertain" : undefined,
        type,
        title,
        description,
        category,
        eventDate,
        location,
        youtubeUrl,
        photoId: first?.id ?? null,
        photoNativeUri: first?.picked?.nativeUri ?? null,
        photoWebPath: first?.picked?.webPath ?? first?.previewUrl ?? null,
        photoFormat: first?.picked?.format ?? null,
        photoIds: photos.map((p) => p.id),
        photoRefs: photos.map((p) => ({
          id: p.id,
          name: p.file.name,
          type: p.file.type,
          size: p.file.size,
          nativeUri: p.picked?.nativeUri ?? null,
          webPath: p.picked?.webPath ?? null,
          format: p.picked?.format ?? null,
          motionPhoto: p.picked?.motionPhoto,
        })),
      },
      accountId,
      renderGeneration,
    );
  }, [type, title, description, category, eventDate, location, youtubeUrl, photos, accountId, renderGeneration, uncertain, photoRecoveryReady]);

  // Photo bytes follow the photo set only (not every keystroke): the registry
  // mirrors memory authoritatively, so removals are pruned on write.
  // Order-only changes (reorder) skip the byte snapshot: display order lives in
  // the JSON draft autosave below, and accepted Files are immutable, so an
  // unchanged id/size/name/type set means the bytes are already durable.
  //
  // Durability contract: persistedPhotoSigRef marks only the signature whose
  // write SUCCEEDED. A failed write leaves it untouched so the same photo set
  // is retried automatically (manual Retry button or the next effect run) —
  // a failed persist is never represented as a durable snapshot.
  const persistedPhotoSigRef = useRef<string | null>(null);
  const [photoSaveRetryKey, setPhotoSaveRetryKey] = useState(0);
  // True while a photo-byte write is in flight. The failure warning clears
  // only on a confirmed durable write — never optimistically when Retry is
  // pressed — and a "Saving photos…" status covers the in-flight window.
  const [photoSavePending, setPhotoSavePending] = useState(false);
  useEffect(() => {
    if (!photoRecoveryReady) return;
    const sig = photos
      .map((p) => `${p.id}:${p.file.size}:${p.file.name}:${p.file.type}`)
      .sort()
      .join("|");
    if (persistedPhotoSigRef.current === sig) return;
    let cancelled = false;
    setPhotoSavePending(true);
    // Warning-only persist: a resolved non-durable report (bytes that cannot
    // survive process death) warns just like a real storage failure, without
    // dropping the live session photos.
    void persistStashedPhotos(accountId).then(
      (report) => {
        if (cancelled) return;
        const durable = report ? report.durable : false;
        setPhotoSaveWarning(!durable);
        setPhotoSavePending(false);
        if (durable) persistedPhotoSigRef.current = sig;
      },
      () => { if (!cancelled) { setPhotoSaveWarning(true); setPhotoSavePending(false); } },
    );
    return () => { cancelled = true; };
  }, [photos, accountId, photoRecoveryReady, photoSaveRetryKey]);

  function retryPhotoSave(): void {
    // Deliberately NOT clearing the warning here: it clears only after the
    // retry's durable write confirms. The pending status covers the gap.
    setPhotoSaveRetryKey((key) => key + 1);
  }

  // Blob lifecycle (W6 #16): revoke preview URLs on unmount but KEEP stashed Files.
  // Remount recreates object URLs from the stashed Files (all 5 slots via the
  // durable draft + photo registry).
  const mediaPickerPhotos = useMemo(
    () =>
      photos.map((p) => ({
        id: p.id,
        webPath: p.previewUrl,
        format: p.picked?.format,
        motionPhoto: p.picked?.motionPhoto,
      })),
    [photos],
  );
  useEffect(() => {
    return () => {
      for (const p of photosRef.current) {
        if (p.previewUrl.startsWith("blob:")) URL.revokeObjectURL(p.previewUrl);
      }
    };
  }, []);

  function discardDraft() {
    const current = { type, title, description, category, eventDate, location, youtubeUrl };
    // draftIsMeaningful only inspects text: a photo-only draft (including one
    // whose photos failed recovery) is still a draft the user must be able to
    // discard, or the failed-recovery screen wedges with no way out. The live
    // persisted photo list is consulted so pruned removals are honored.
    const hasPhotos =
      photos.length > 0 ||
      failedPhotoIds.length > 0 ||
      draftPhotoIds(loadDraft(accountId)).length > 0;
    if (!draftIsMeaningful(current) && !hasPhotos) return;
    if (!window.confirm("Discard this report and clear the selected photo?")) return;
    clearDraft(accountId);
    setType("LOST");
    setTitle("");
    descriptionLiveRef.current = "";
    setDescription("");
    setCategory("");
    setEventDate(todayInputValue());
    setLocation({ label: "", latitude: null, longitude: null });
    setYoutubeUrl("");
    clearPhotos();
    // A failed recovery must never wedge the screen: discarding resolves the
    // recovery gate so a completely new report can be started immediately.
    setFailedPhotoIds([]);
    setPhotoRestoreError(false);
    setPhotoRecoveryReady(true);
    setUncertain(false);
    announce("Report draft discarded.");
  }

  function acceptPickedPhoto(file: File, photo: PickedPhoto | null, hash?: string): string {
    const id = stashPhotoFile(file, { picked: photo ?? null, accountId });
    const preview = previewUrlFor(file);
    const next = [...photosRef.current, { id, file, previewUrl: preview, picked: photo ?? null, hash }];
    // Update the ref synchronously too: queued async work and publish read the
    // ref, not the render-time state, so they must not observe a stale list.
    photosRef.current = next;
    setPhotos(next);
    return id;
  }

  /**
   * Add a whole gallery batch in selection order using exact-byte duplicate
   * detection. One unreadable item never discards the others (R-065, R-068,
   * R-071, R-081).
   */
  /**
   * Queue a native gallery/camera batch. Gallery re-taps are coalescable (a
   * still-queued selection is superseded by the latest); camera captures are
   * irreplaceable and always run.
   */
  function onPickBatch(picks: NativePick[], opts?: { coalescable?: boolean }): void {
    setError(null);
    setPhotoFileErrors([]);
    // Sibling failed rows are preserved: a retry removes only its own row
    // (retryFailedPick) and a new batch appends its failures at completion,
    // so re-picking while failures are pending never destroys them.
    enqueuePending({ kind: "native", coalescable: opts?.coalescable ?? false, nativeItems: picks });
  }

  /**
   * Convert one native batch in selection order with per-photo progress.
   * Each item is converted at CURRENT capacity (photosRef is updated
   * synchronously on accept): an invalid item never consumes a slot or
   * prevents later valid items in the same selection from arriving (R-065,
   * R-068, R-071, R-081). Cancelling aborts the remaining items;
   * already-accepted tiles stay. Failures are labeled by selection position
   * ("Photo 2") — never by native URIs, which must not leak into the
   * interface. FBX-001: preparation goes through the injected native
   * converter, so a failure becomes a retryable row instead of a File fallback.
   */
  async function runNativeBatch(picks: NativePick[]): Promise<void> {
    await restorePromiseRef.current;
    const remaining = MAX_REPORT_PHOTOS - photosRef.current.length;
    if (remaining <= 0) {
      setPhotoLimitNotice(
        `Reports hold up to ${MAX_REPORT_PHOTOS} photos in a fixed order. Remove one first.`,
      );
      return;
    }
    const controller = new AbortController();
    pickAbortRef.current = controller;
    setPickProgress({ done: 0, total: picks.length });
    let accepted = 0;
    let duplicates = 0;
    let unreadable = 0;
    let overflow = 0;
    // Policy rejections (a converted file that is still over the transport
    // ceiling or not a supported type) stay plain messages: retrying the same
    // bytes cannot help. Preparation failures become retryable rows instead.
    const policyFailures: string[] = [];
    const failedRows: FailedPick[] = [];
    let cancelled = false;
    try {
      for (const [selectionIndex, item] of picks.entries()) {
        if (controller.signal.aborted) {
          cancelled = true;
          break;
        }
        const position = selectionIndex + 1;
        const result = await processReportBatch(
          [item.picked],
          photosRef.current.length,
          hashRegistryRef.current,
          (photo, file, hash) => {
            if (!isAcceptedStillMime(file.type) || file.size > MAX_IMAGE_BYTES) {
              hashRegistryRef.current.delete(hash);
              unreadable += 1;
              policyFailures.push(`Photo ${position}: ${file.size > MAX_IMAGE_BYTES
                ? "that photo is still too large after preparing. Try a smaller image or re-save it as JPEG."
                : `that file isn't a supported photo. Choose a ${ACCEPTED_STILL_FORMATS_LABEL} photo.`}`);
              return;
            }
            acceptPickedPhoto(file, photo, hash);
            accepted += 1;
          },
          selectionIndex,
          {
            signal: controller.signal,
            // FBX-001: the canonical native processor (never photoToFile's fetch).
            // The batch signal reaches the native import so a cancel aborts
            // the in-flight item instead of waiting it out.
            convert: (_photo, opts) => item.resolve({ signal: opts?.signal }),
          },
        );
        duplicates += result.duplicates.length;
        unreadable += result.unreadable.length;
        overflow += result.overflow.length;
        for (const failed of result.unreadable) {
          failedRows.push({
            key: item.picked.id,
            position: failed.index + 1,
            reason: failed.reason,
            pick: item,
          });
        }
        setPickProgress({ done: selectionIndex + 1, total: picks.length });
        if (controller.signal.aborted || result.cancelled) {
          cancelled = true;
          break;
        }
      }
      setPhotoFileErrors(policyFailures);
      // Append: failures from an earlier batch (or a retried row's
      // siblings) stay until the user retries or dismisses them.
      setFailedPicks((current) => [...current, ...failedRows]);
      const notice = formatBatchNotice(accepted, duplicates, unreadable, overflow);
      setPhotoLimitNotice(
        cancelled
          ? [notice, "cancelled"].filter(Boolean).join(" · ") || "Photo processing cancelled."
          : notice || null,
      );
      diag("report.picker.batch", {
        picked: picks.length,
        accepted,
        duplicates,
        unreadable,
        overflow,
        cancelled,
      }, { traceId: traceIdRef.current ?? undefined });
    } finally {
      pickAbortRef.current = null;
      setPickProgress(null);
    }
  }

  /** FBX-001: re-run the canonical native processor for one failed item. */
  function retryFailedPick(key: string): void {
    const target = failedPicks.find((f) => f.key === key);
    if (!target) return;
    setFailedPicks((current) => current.filter((f) => f.key !== key));
    onPickBatch([{ picked: target.pick.picked, resolve: target.pick.resolve }]);
  }

  /** FBX-001: discard one failed item without touching the recovered photos. */
  function dismissFailedPick(key: string): void {
    setFailedPicks((current) => current.filter((f) => f.key !== key));
  }

  /**
   * Web file-input path: the SAME sequential contract as the native batch
   * (processReportBatch). Files are validated in selection order and only
   * successfully accepted files consume the five-photo capacity — an
   * unreadable first file never starves a valid second one. A digest failure
   * rejects the photo outright instead of accepting it hashless, which would
   * silently break the exact-duplicate guarantee.
   * Async-safe: the work runs on the pick queue, and publish awaits the queue
   * before snapshotting, so a fast "pick then publish" never drops a photo.
   */
  function onPickFiles(files: FileList | null): void {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setError(null);
    setPhotoFileErrors([]);
    enqueuePending({ kind: "web", coalescable: true, webItems: list });
  }

  async function runWebBatch(list: File[]): Promise<void> {
    await restorePromiseRef.current;
    let accepted = 0;
    let duplicates = 0;
    let unreadable = 0;
    let overflow = 0;
    // Per-file failures: when several files fail for different reasons the
    // user must see WHICH filename caused WHICH failure, not one generic
    // message that only describes the last error.
    const failures: string[] = [];
    for (const file of list) {
      if (MAX_REPORT_PHOTOS - photosRef.current.length <= 0) {
        overflow += 1;
        continue;
      }
      // Normalize-first: HEIC/HEIF/AVIF/BMP sources normalize to a bounded
      // JPEG/PNG/WebP derivative. The pre-gate only rejects empty files and
      // obvious non-images; anything image-like goes through preparation so a
      // readable source is never refused for its declared type.
      if (file.size === 0) {
        failures.push(`${file.name}: that file is empty. Choose a photo file and try again.`);
        unreadable += 1;
        continue;
      }
      let payload: File;
      try {
        payload = await normalizeForUpload(file);
      } catch (err) {
        failures.push(`${file.name}: ${friendlyError(err).message}`);
        unreadable += 1;
        continue;
      }
      // Transport ceiling applies to the normalized derivative only.
      if (!isAcceptedStillMime(payload.type) || payload.size > MAX_IMAGE_BYTES) {
        failures.push(`${file.name}: that photo is still too large after preparing. Try a smaller image or re-save it as JPEG.`);
        unreadable += 1;
        continue;
      }
      let digest: string;
      try {
        digest = await computeSha256Hex(payload);
      } catch {
        failures.push(`${file.name}: that photo could not be verified. Please try it again.`);
        unreadable += 1;
        continue;
      }
      if (hashRegistryRef.current.has(digest)) {
        duplicates += 1;
        continue;
      }
      hashRegistryRef.current.add(digest);
      acceptPickedPhoto(payload, null, digest);
      accepted += 1;
    }
    setPhotoFileErrors(failures);
    setPhotoLimitNotice(formatBatchNotice(accepted, duplicates, unreadable, overflow) || null);
    diag("report.picker.web", {
      picked: list.length,
      accepted,
      duplicates,
      unreadable,
      overflow,
    }, { traceId: traceIdRef.current ?? undefined });
  }

  async function onAddGallery(): Promise<void> {
    const remaining = MAX_REPORT_PHOTOS - photosRef.current.length;
    if (remaining <= 0) return;
    if (!isNativeCameraAvailable()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      // FBX-001: the canonical permissionless picker returns ordered granted
      // content URIs; each is imported one at a time by the batch so an
      // unreadable item fails alone, keeps its position, and is never read
      // through a File/HTML bridge fallback.
      const uris = await chooseNativeImages({ source: "photos", limit: remaining });
      if (!uris || uris.length === 0) return;
      const picks: NativePick[] = uris.map((uri) => {
        const picked: PickedPhoto = { nativeUri: uri, webPath: uri, format: "jpg", id: crypto.randomUUID() };
        return {
          picked,
          resolve: async (opts) => {
            const imported = await importNativeImageUri(uri, { signal: opts?.signal });
            picked.motionPhoto = imported.motionStillUsed;
            return importedImageToFile(imported);
          },
        };
      });
      onPickBatch(picks, { coalescable: true });
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }

  async function onAddCamera(): Promise<void> {
    if (!isNativeCameraAvailable()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      // FBX-001: the delegated camera capture returns its already-bounded
      // derivative (the private capture file is deleted at cleanup), so there is
      // no URI to revive later — the stashed File is the durable artifact.
      const imported = await chooseNativeImage({ source: "camera", highQuality: false });
      if (!imported) return; // cancelled
      const file = importedImageToFile(imported);
      const picked: PickedPhoto = {
        nativeUri: "",
        webPath: "",
        format: file.type === "image/png" ? "png" : "jpg",
        id: crypto.randomUUID(),
        motionPhoto: imported.motionStillUsed,
      };
      onPickBatch([{ picked, resolve: async () => file }]);
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }

  function removePhoto(id: string): void {
    const target = photosRef.current.find((p) => p.id === id);
    if (target?.hash) hashRegistryRef.current.delete(target.hash);
    if (target?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(target.previewUrl);
    dropStashedPhoto(id, accountId);
    photosRef.current = photosRef.current.filter((p) => p.id !== id);
    setPhotos(photosRef.current);
    setPreviewPhotoId((current) => (current === id ? null : current));
    setPhotoLimitNotice(null);
  }

  function movePhotoById(id: string, direction: "earlier" | "later"): void {
    const index = photosRef.current.findIndex((p) => p.id === id);
    if (index === -1) return;
    const swapWith = index + (direction === "earlier" ? -1 : 1);
    if (swapWith < 0 || swapWith >= photosRef.current.length) return;
    const next = [...photosRef.current];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(swapWith, 0, moved);
    photosRef.current = next;
    setPhotos(next);
  }

  function clearPhotos(): void {
    for (const p of photosRef.current) {
      if (p.previewUrl.startsWith("blob:")) URL.revokeObjectURL(p.previewUrl);
      dropStashedPhoto(p.id, accountId);
    }
    hashRegistryRef.current = createHashRegistry();
    photosRef.current = [];
    setPhotos([]);
    setPreviewPhotoId(null);
    setPhotoLimitNotice(null);
    setPhotoFileErrors([]);
    setFailedPicks([]);
  }

  async function onSubmit(e: React.FormEvent) {
    // Defense-in-depth against nested interactive sheets (location search,
    // link dialog): only a submit that originates from THIS form may publish.
    // A submit event bubbled from any other control is ignored outright.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (submitting.current || uncertain || !photoRecoveryReady) return;
    // Start a new trace for this publish action
    traceIdRef.current = startActionTrace();
    clearAmbientTrace();
    setError(null);
    const trimmedTitle = title.trim();
    const editorDescription =
      descriptionEditorRef.current !== null
        ? (() => {
            try {
              return tiptapToMarkdown(descriptionEditorRef.current.getJSON());
            } catch {
              return null;
            }
          })()
        : null;
    const liveDescription =
      descriptionLiveRef.current === description &&
      editorDescription !== null &&
      editorDescription !== description
        ? editorDescription
        : descriptionLiveRef.current;
    if (liveDescription !== description) {
      descriptionLiveRef.current = liveDescription;
      setDescription(liveDescription);
    }
    const trimmedDescription = measureDescription(liveDescription).trimmed;
    // ED-05 contract: the business rule stays stored-Markdown length
    // (DESCRIPTION_MAX against the submitted string), shared with the editor
    // counter through measureDescription so `**`, `##`, list prefixes, `>`
    // and link destinations never surprise the user at publish time.
    const trimmedYoutube = youtubeUrl.trim();
    const trimmedLocationLabel = location.label.trim();
    const errs = {
      title: !trimmedTitle
        ? "Enter a short title."
        : trimmedTitle.length < TITLE_MIN
          ? `Title must be at least ${TITLE_MIN} characters.`
          : trimmedTitle.length > TITLE_MAX
            ? `Title must be at most ${TITLE_MAX} characters.`
            : undefined,
      description: !trimmedDescription
        ? "Describe the item so it can be recognised."
        : trimmedDescription.length < DESCRIPTION_MIN
          ? `Description must be at least ${DESCRIPTION_MIN} characters.`
          : trimmedDescription.length > DESCRIPTION_MAX
            ? `Description must be at most ${DESCRIPTION_MAX} characters.`
            : undefined,
      category: !category
        ? "Choose a category."
        : !isReleasedCategory(category)
          ? "Choose one of the available categories."
          : undefined,
      eventDate: !eventDate
        ? "Choose a date."
        : !isValidCalendarDate(eventDate)
          ? "Choose a valid date."
          : isFutureDate(eventDate)
            ? "The date can't be in the future."
            : undefined,
      locationLabel: trimmedLocationLabel.length > LOCATION_LABEL_MAX
        ? "Location label is too long."
        : undefined,
      youtubeUrl:
        trimmedYoutube && !extractYouTubeId(trimmedYoutube)
          ? "That doesn't look like a YouTube link."
          : undefined,
    };
    setFieldErrors(errs);
    // `!category` also narrows the type for publishReport below.
    if (errs.title || errs.description || errs.category || errs.eventDate || errs.locationLabel || errs.youtubeUrl || !category) return;
    submitting.current = true;
    setBusy(true);
    // Let any queued duplicate-detection finish before we snapshot the files,
    // so identical bytes cannot slip into the same publish (R-068).
    await pickQueueRef.current.catch(() => {});
    await restorePromiseRef.current;
    const reportFiles = photosRef.current.map((p) => p.file);
    // Diag: publish start
    diag("report.publish.start", {
      type,
      hasPhoto: reportFiles.length > 0,
      photoBytes: reportFiles[0]?.size ?? 0,
      photoMime: reportFiles[0]?.type ?? null,
      photoCount: reportFiles.length,
      hasLocation: location.latitude !== null && location.longitude !== null,
      hasYoutube: !!trimmedYoutube,
    }, { traceId: traceIdRef.current ?? undefined });
    try {
      // Explicit user confirmation is this submit: nothing publishes without it.
      // 0–1 photos keep the legacy single-photo path; 2–5 use the ordered multi path.
      const reportInput = {
        type,
        title: trimmedTitle,
        description: trimmedDescription,
        category,
        eventDate,
        locationLabel: trimmedLocationLabel || undefined,
        latitude: location.latitude,
        longitude: location.longitude,
        youtubeUrl: trimmedYoutube || undefined,
      };
      // Multi-photo uploads report "Uploading i/N" with cancel. The cancel
      // is cooperative: uploadPhotos stages strictly in order and calls
      // onProgress after each file, so throwing there skips every remaining
      // file while its own catch removes exactly this attempt's staged
      // objects — no orphaned uploads, local Files untouched for retry.
      const uploadController = reportFiles.length > 1 ? new AbortController() : null;
      uploadAbortRef.current = uploadController;
      if (uploadController) setUploadProgress({ completed: 0, total: reportFiles.length });
      const postId =
        reportFiles.length <= 1
          ? await publishReport(reportInput, reportFiles[0] ?? null, traceIdRef.current ?? undefined)
          : await publishReportWithPhotos(reportInput, reportFiles, {
              traceId: traceIdRef.current ?? undefined,
              signal: uploadController?.signal,
              onProgress: ({ completed, total }) => {
                if (uploadController?.signal.aborted) throw new UploadCancelledError();
                setUploadProgress({ completed, total });
              },
            });
      // Diag: publish success
      diag("report.publish.success", {
        postId,
      }, { traceId: traceIdRef.current ?? undefined });
      clearDraft(accountId);
      clearPhotos();
      clearPhotoStore(accountId);
      setType("LOST");
      setTitle("");
      descriptionLiveRef.current = "";
      descriptionEditorRef.current = null;
      setDescription("");
      setCategory("");
      setEventDate(todayInputValue());
      setLocation({ label: "", latitude: null, longitude: null });
      setYoutubeUrl("");
      setFieldErrors({});
      setUncertain(false);
      setEditorResetKey((key) => key + 1);
      announce("Report published.");
      navigate(`/posts/${postId}`, { replace: true });
    } catch (err) {
      if (err instanceof UploadCancelledError || (err instanceof Error && err.name === "UploadCancelledError")) {
        // Cooperative cancel: staged objects for this attempt were already
        // removed by uploadPhotos; the draft and local photos stay for retry.
        diag("report.publish.cancelled", {
          photoCount: reportFiles.length,
        }, { traceId: traceIdRef.current ?? undefined });
        setError(err.message);
        announce("Upload cancelled. Your photos are kept.");
      } else {
        // Diag: publish error
        diag("report.publish.error", {
          message: friendlyError(err).message,
          code: err instanceof Error ? (err as { code?: string }).code ?? "unknown" : "unknown",
        }, { traceId: traceIdRef.current ?? undefined });
        if (err instanceof PublishOutcomeUncertainError) {
          setUncertain(true);
          setError(err.message);
        } else {
          setError(friendlyError(err).message);
        }
      }
    } finally {
      uploadAbortRef.current = null;
      setUploadProgress(null);
      submitting.current = false;
      setBusy(false);
    }
  }

  // Always-mounted lightbox helpers: current photo/index plus wrap-around
  // stepping for the prev/next controls and arrow keys. Stepping re-centers
  // (no shared-element rect for the next tile) while the first open grows
  // out of the tapped thumbnail.
  const previewIndex = previewPhotoId ? photos.findIndex((p) => p.id === previewPhotoId) : -1;
  const previewPhoto = previewIndex >= 0 ? photos[previewIndex]! : null;
  function stepPreview(delta: number): void {
    if (photos.length === 0 || previewIndex < 0) return;
    const next = (previewIndex + delta + photos.length) % photos.length;
    setPreviewOrigin(null);
    setPreviewPhotoId(photos[next]!.id);
  }

  // One crossfading slot for the batch pipeline: queued -> processing ->
  // ready/failed, keyed by kind so progress numbers tick in place and only a
  // state change crossfades. Opacity only — colour never animates.
  const pickStatus = pickProgress
    ? {
        kind: "processing" as const,
        text: `Processing ${pickProgress.done} of ${pickProgress.total}${
          pickBacklog > 0 ? ` · ${pickBacklog} batch queued` : ""
        }`,
        tone: "",
      }
    : pickBacklog > 0
      ? {
          kind: "queued" as const,
          text: `${pickBacklog} batch queued…`,
          tone: "text-on-surface-variant",
        }
      : photoLimitNotice
        ? { kind: "notice" as const, text: photoLimitNotice, tone: "text-error" }
        : null;

  // Real observed upload ratio — the bar never runs ahead of the counts.
  const uploadPercent =
    uploadProgress && uploadProgress.total > 0
      ? Math.min(100, Math.round((uploadProgress.completed / uploadProgress.total) * 100))
      : 0;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5 px-4 py-5" noValidate>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Report an item</h1>
        <p className="text-sm text-on-surface-variant">
          Posting as @{user?.username}. Be specific — details help reunions.
        </p>
      </header>

      {error && (
        <p className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error" role="alert">
          {error}
        </p>
      )}

      {photoSavePending && photos.length > 0 && (
        <p className="rounded-m3-sm border border-outline-variant px-3 py-2 text-sm" role="status">
          Saving photos…
        </p>
      )}
      {photoSaveWarning && !photoSavePending && photos.length > 0 && (
        <div className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error" role="alert">
          <p>
            Photos could not be saved for draft recovery. Your photos are still
            here for this session — retry saving without reselecting anything.
          </p>
          <div className="mt-2">
            <Button type="button" variant="outline" size="md" onClick={retryPhotoSave}>
              Retry saving photos
            </Button>
          </div>
        </div>
      )}

      {photoRestoreError && failedPhotoIds.length > 0 && (
        <div className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error" role="alert">
          <p>
            Saved photos could not be recovered ({failedPhotoLabels(failedPhotoIds)}). Your title,
            description, date, location and recovered photos are kept — nothing publishes until you
            retry or remove the unavailable photos.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="md" onClick={retryPhotoRecovery}>
              Retry recovery
            </Button>
            <Button type="button" variant="text" size="md" onClick={removeUnavailablePhotos}>
              Remove unavailable and continue
            </Button>
          </div>
        </div>
      )}

      {uncertain && (
        <div role="status" className="rounded-m3-sm border border-outline-variant px-3 py-2 text-sm">
          This report may already be published. Your draft is kept; publishing again is paused.
          <Button type="button" variant="text" size="md" onClick={() => navigate("/my")}>Check My Reports</Button>
        </div>
      )}

      <Segmented<PostType>
        ariaLabel="Lost or found"
        value={type}
        onChange={setType}
        options={[
          { value: "LOST", label: "I lost something" },
          { value: "FOUND", label: "I found something" },
        ]}
      />

      <TextField
        label={type === "LOST" ? "What did you lose?" : "What did you find?"}
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          if (fieldErrors.title) setFieldErrors((f) => ({ ...f, title: undefined }));
        }}
        placeholder="e.g. Scientific calculator near the Science Faculty"
        error={fieldErrors.title}
        required
        maxLength={TITLE_MAX}
      />

      <RichTextEditor
        key={editorResetKey}
        label="Description"
        value={description}
        onChange={(v) => {
          descriptionLiveRef.current = v;
          setDescription(v);
          if (fieldErrors.description) setFieldErrors((f) => ({ ...f, description: undefined }));
        }}
        placeholder="Colour, brand, markings, when and where it happened…"
        error={fieldErrors.description}
        required
        maxLength={DESCRIPTION_MAX}
        editorRef={descriptionEditorRef}
      />

      <CategoryField
        value={category}
        onChange={(c) => {
          setCategory(c);
          if (fieldErrors.category) setFieldErrors((f) => ({ ...f, category: undefined }));
        }}
        error={fieldErrors.category}
      />

      {/* AI field suggestions (Lane C, additive): extract-report-fields +
          classify-category as reviewable per-field patches. Suggestions only:
          each chip shows its source with Apply/Keep; applying one field keeps
          the others reviewable; Keep sends nothing. Never publishes,
          auto-applies, or touches draft/photo lifecycle. */}
      <section
        aria-label="AI field suggestions"
        className="flex flex-col gap-2 rounded-m3-md border border-outline-variant p-3"
      >
        <p className="text-sm font-medium">AI field suggestions</p>
        <p className="text-sm text-on-surface-variant">
          Draft title, description, date and category from your words. Review each one — nothing is
          applied or published automatically.
        </p>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Describe the item in your own words</span>
          <textarea
            aria-label="Describe the item for AI suggestions"
            value={aiSuggestInput}
            onChange={(e) => setAiSuggestInput(e.target.value)}
            placeholder="e.g. Black umbrella lost yesterday near the central market"
            className={`${inputCls} min-h-[60px]`}
            rows={2}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => void aiSuggestRequest()}
          >
            {aiSuggestBusy ? "Suggesting…" : "Suggest fields"}
          </Button>
          {aiSuggestBusy && (
            <Button type="button" variant="text" size="md" onClick={aiSuggestStop}>
              Stop
            </Button>
          )}
        </div>
        {aiSuggestError && (
          <p role="alert" className="text-sm text-error">
            {aiSuggestError}
          </p>
        )}
        {aiFieldDroppedCategory && (
          <p role="status" className="text-sm text-on-surface-variant">
            {DROPPED_CATEGORY_NOTE}
          </p>
        )}
        {aiCatDropped && !aiFieldDroppedCategory && (
          <p role="status" className="text-sm text-on-surface-variant">
            {DROPPED_CATEGORY_SUGGESTION_NOTE}
          </p>
        )}
        {aiFieldPatches
          .filter((patch) => !aiSuggestResolved[`field:${patch.field}`])
          .map((patch) => {
            const dateApplicable =
              patch.field !== "date" ||
              (isValidCalendarDate(patch.suggestedValue) && !isFutureDate(patch.suggestedValue));
            return (
              <div
                key={`ai-field-${patch.field}`}
                className="flex flex-col gap-1 rounded-m3-sm border border-outline-variant p-2"
              >
                <p className="text-xs text-on-surface-variant">
                  Suggested {patch.field} · via {patch.source}
                </p>
                <p className="text-sm">{patch.suggestedValue}</p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="md"
                    onClick={() => aiSuggestApplyField(patch)}
                    disabled={!dateApplicable}
                  >
                    Apply {patch.field}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="md"
                    onClick={() => aiSuggestResolve(`field:${patch.field}`)}
                  >
                    Keep mine
                  </Button>
                </div>
                {!dateApplicable && (
                  <p className="text-xs text-on-surface-variant">
                    That date needs a calendar date — pick it in the date field instead.
                  </p>
                )}
              </div>
            );
          })}
        {aiCatSuggestion && !aiSuggestResolved.categorySuggestion && (
          <div className="flex flex-col gap-1 rounded-m3-sm border border-outline-variant p-2">
            <p className="text-xs text-on-surface-variant">
              Suggested category · via {aiCatSuggestion.source}
            </p>
            <p className="text-sm">{aiCatSuggestion.suggestedCategory}</p>
            <div className="flex gap-2">
              <Button type="button" variant="primary" size="md" onClick={() => aiSuggestApplyCategory(aiCatSuggestion)}>
                Apply category
              </Button>
              <Button type="button" variant="outline" size="md" onClick={() => aiSuggestResolve("categorySuggestion")}>
                Keep mine
              </Button>
            </div>
          </div>
        )}
        {(aiFieldPatches.length > 0 || aiCatSuggestion) &&
          aiFieldPatches.every((patch) => aiSuggestResolved[`field:${patch.field}`]) &&
          (!aiCatSuggestion || aiSuggestResolved.categorySuggestion) && (
            <p role="status" className="text-xs text-on-surface-variant">
              All suggestions reviewed. Nothing was published automatically.
            </p>
          )}
      </section>

      <div className="block">
        <span id="report-event-date-label" className="mb-1 block text-sm font-medium">
          {type === "LOST" ? "Date lost" : "Date found"}
        </span>
        <ReportDatePicker
          value={eventDate}
          expected={type}
          aria-describedby="report-event-date-label"
          error={fieldErrors.eventDate}
          onChange={(next) => {
            setEventDate(next);
            if (fieldErrors.eventDate) setFieldErrors((f) => ({ ...f, eventDate: undefined }));
          }}
        />
        {!fieldErrors.eventDate && isFutureDate(eventDate) && (
          <span className="mt-1 block text-xs text-error">
            The date can't be in the future.
          </span>
        )}
      </div>

      <LocationPicker value={location} onChange={setLocation} maxLength={LOCATION_LABEL_MAX} />
      {fieldErrors.locationLabel && (
        <span className="mt-1 block text-xs text-error">{fieldErrors.locationLabel}</span>
      )}

      {/* Photo (optional) */}
      <section className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-3">
        <ReportMediaPicker
          photos={mediaPickerPhotos}
          disabled={submitting.current || uncertain || !photoRecoveryReady}
          onAddCamera={onAddCamera}
          onAddGallery={() => void onAddGallery()}
          onRemove={removePhoto}
          onMove={movePhotoById}
          onPreview={(id, origin) => {
            setPreviewOrigin(origin ?? null);
            setPreviewPhotoId(id);
          }}
        />
        <AnimatePresence mode="popLayout" initial={false}>
          {pickStatus && (
            <motion.div
              key={pickStatus.kind}
              role="status"
              aria-live="polite"
              data-testid="photo-pick-status"
              data-status={pickStatus.kind}
              className={`flex items-center gap-2 text-xs ${pickStatus.tone}`}
              variants={fadeVariants}
              initial="hidden"
              animate="visible"
              exit="hidden"
              transition={statusCrossfade}
            >
              <span>{pickStatus.text}</span>
              {pickStatus.kind === "processing" && (
                <Button type="button" variant="text" size="md" onClick={cancelPick}>
                  Cancel
                </Button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {photoFileErrors.length > 0 && (
          <div className="text-xs text-error" role="alert">
            <p>Some photos couldn&apos;t be added:</p>
            <ul className="list-disc pl-5">
              {photoFileErrors.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          </div>
        )}
        {failedPicks.length > 0 && (
          <ul className="flex flex-col gap-2" role="list" aria-label="Photos that couldn't be added">
            {failedPicks.map((failed) => (
              <li
                key={failed.key}
                className="flex items-start justify-between gap-3 rounded-m3-sm border border-error/40 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-error">Photo {failed.position} couldn&apos;t be added.</p>
                  <p className="text-xs text-on-surface-variant">{failed.reason}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="text" size="md" onClick={() => retryFailedPick(failed.key)}>
                    Retry
                  </Button>
                  <Button type="button" variant="text" size="md" onClick={() => dismissFailedPick(failed.key)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!isNativeCameraAvailable() && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            // FBX-003: the picker advertises EXACTLY the accepted set — one
            // source of truth, so the file dialog and the post-prepare gate
            // can never disagree about which containers are welcome.
            accept={ACCEPTED_IMAGE_TYPES.join(",")}
            className="sr-only"
            onChange={(e) => {
              onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
        )}
      </section>

      <PhotoLightbox
        photo={previewPhoto}
        index={previewIndex >= 0 ? previewIndex : undefined}
        total={photos.length}
        originRect={previewOrigin}
        onPrev={photos.length > 1 ? () => stepPreview(-1) : undefined}
        onNext={photos.length > 1 ? () => stepPreview(1) : undefined}
        onClose={() => setPreviewPhotoId(null)}
      />

      {/* Optional external YouTube media */}
      <label className="block">
        <span className="mb-1 block text-sm font-medium">YouTube link (optional)</span>
        <input
          type="url"
          value={youtubeUrl}
          onChange={(e) => {
            setYoutubeUrl(e.target.value);
            if (fieldErrors.youtubeUrl) setFieldErrors((f) => ({ ...f, youtubeUrl: undefined }));
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          className={inputCls}
        />
      </label>
      {youtubeUrl.trim() && !extractYouTubeId(youtubeUrl.trim()) && (
        <p className="text-xs text-error">
          {fieldErrors.youtubeUrl ?? "That doesn't look like a YouTube link. It won't be attached."}
        </p>
      )}
      {youtubeUrl.trim() && extractYouTubeId(youtubeUrl.trim()) && (
        <YouTubeEmbed url={youtubeUrl.trim()} />
      )}

      {uploadProgress && (
        <div className="flex flex-col gap-1" role="status" aria-live="polite" data-testid="upload-progress">
          <div className="flex items-center gap-2 text-sm">
            {uploadProgress.completed < uploadProgress.total ? (
              <>
                <span>
                  Uploading {Math.min(uploadProgress.completed + 1, uploadProgress.total)} of {uploadProgress.total}
                </span>
                <Button type="button" variant="text" size="md" onClick={cancelUpload}>
                  Cancel upload
                </Button>
              </>
            ) : (
              <span>Publishing…</span>
            )}
          </div>
          {/* Real observed progress only: the bar never runs ahead of the
              completed/total counts it is derived from. */}
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={uploadPercent}
            className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-surface-container"
          >
            <motion.div
              className="h-full w-full origin-left rounded-full bg-on-surface"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: uploadPercent / 100 }}
              transition={uploadBarTransition}
              data-upload-percent={uploadPercent}
            />
          </div>
        </div>
      )}
      <Button type="submit" size="lg" loading={busy} disabled={uncertain || !photoRecoveryReady}>
        Publish {type === "LOST" ? "lost" : "found"} report
      </Button>
      <Button type="button" variant="text" size="md" onClick={discardDraft}>
        Discard draft
      </Button>
    </form>
  );
}
