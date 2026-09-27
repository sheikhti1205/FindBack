import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { VlmSuggestions } from "../components/VlmSuggestions";
import { announce } from "../components/LiveRegion";
import { MAX_REPORT_PHOTOS, publishReport, publishReportWithPhotos } from "../services/posts";
import { clearDraft, draftGeneration, draftIsMeaningful, loadDraft, saveDraft } from "../services/reportDraft";
import type { ReportDraft, ReportPhotoRef } from "../services/reportDraft";
import { friendlyError } from "../utils/friendlyErrors";
import { isNativeCameraAvailable, takePhoto, chooseReportPhotos, normalizeForUpload, photoToFile, type PickedPhoto } from "../services/photo";
import { ReportDatePicker } from "../components/ReportDatePicker";
import { ReportMediaPicker } from "../components/ReportMediaPicker";
import { PhotoLightbox } from "../components/PhotoLightbox";
import { createHashRegistry, formatBatchNotice, processReportBatch } from "../services/media/reportBatch";
import { computeSha256Hex } from "../services/media/dedupe";
import {
  dropStashedPhoto,
  clearPhotoStore,
  getStashedPhoto,
  getStashedPhotoMeta,
  persistStashedPhotos,
  restashPhotoFile,
  restoreStashedPhotos,
  stashPhotoFile,
} from "../services/photoStore";
import type { VlmAnalysis } from "../services/vlmParser";
import { todayInputValue, isFutureDate } from "../utils/dates";
import { diag, startActionTrace, clearAmbientTrace } from "../services/diag";
import { PublishOutcomeUncertainError } from "../services/publishOutcome";
import { isAssistantReportHandoff, type AssistantReportHandoff } from "../services/assistant/assistantHandoff";
import {
  subscribeStagedAssistantReportHandoff,
  takeStagedAssistantReportHandoff,
} from "../services/assistant/assistantReportNavigation";

const inputCls =
  "w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none";

/** Server bucket policy mirrored client-side so doomed uploads fail fast. */
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Client-side validation mirrors server (W6 #17). */
const TITLE_MIN = 3;
const TITLE_MAX = 120;
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 3000;
const LOCATION_LABEL_MAX = 200;

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
 * HEIC file mislabeled as JPG converts fine in photoToFile but would preview
 * as a broken original), while the File bytes are exactly what was validated,
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

/** Draft photos with a native ref but no stashed File (revivable via photoToFile). */
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
  const hashRegistryRef = useRef(createHashRegistry());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Serializes overlapping picker work (R-073): a second action queues behind
  // the first instead of racing the shared hash registry or the 5-photo cap.
  const pickQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueuePick = (task: () => Promise<void>): void => {
    pickQueueRef.current = pickQueueRef.current.then(task, task).catch(() => {});
  };
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
  const [assistantHandoff, setAssistantHandoff] = useState<AssistantReportHandoff | null>(null);
  const [handoffConflicts, setHandoffConflicts] = useState<
    Array<{ field: "type" | "title" | "description" | "category" | "eventDate" | "location"; label: string; incoming: string }>
  >([]);
  const [handoffAdded, setHandoffAdded] = useState<string[]>([]);
  const formSnapshotRef = useRef({ type, title, description, category, eventDate, location });
  // Post-commit snapshot of the latest committed form; layout timing closes
  // the commit-to-passive-effect gap for synchronous external handoffs.
  useLayoutEffect(() => {
    formSnapshotRef.current = { type, title, description, category, eventDate, location };
  });

  // Durable mount restore: rehydrate persisted photo bytes,
  // then revive native-capture refs (all 5 slots) via photoToFile, then merge
  // everything into state in draft order. Never touches the editor instance.
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
      const converted = new Map<string, { file: File; picked: PickedPhoto }>();
      for (const pending of pendings) {
        try {
          const file = await photoToFile(pending.picked);
          if (isCancelled() || generation !== draftGeneration(accountId)) return;
          converted.set(pending.id, { file, picked: pending.picked });
        } catch {
          // Native revive failed: named below; the draft text is unaffected.
          missing.add(pending.id);
        }
      }
      if (isCancelled() || generation !== draftGeneration(accountId)) return;
      for (const id of draftIds) {
        if (photosRef.current.some((p) => p.id === id)) continue;
        if (converted.has(id)) continue;
        if (getStashedPhoto(id)) continue;
        missing.add(id);
      }
      // Mixed-success contract: every recovered slot is merged into state
      // FIRST (converted Files are restashed under their ORIGINAL ids so
      // draft references, ordering and persistence stay coherent), and only
      // then are the failed slots reported. Removing an unavailable photo can
      // therefore never drop a successfully converted sibling.
      const next = [...photosRef.current];
      for (const id of draftIds) {
        if (next.some((p) => p.id === id)) continue;
        const conv = converted.get(id);
        const file = conv?.file ?? getStashedPhoto(id);
        if (!file) continue;
        if (conv) restashPhotoFile(id, conv.file, { picked: conv.picked, accountId });
        const ref = draftPhotoRef(initialDraft, id);
        const picked = conv?.picked ?? refToPicked(ref) ?? getStashedPhotoMeta(id)?.picked ?? null;
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

  function applyAssistantHandoff(handoff: AssistantReportHandoff): void {
    if (!isAssistantReportHandoff(handoff)) return;
    const current = formSnapshotRef.current;
    const added: string[] = [];
    const conflicts: Array<{ field: "type" | "title" | "description" | "category" | "eventDate" | "location"; label: string; incoming: string }> = [];
    if (handoff.patch.type !== undefined && handoff.patch.type !== current.type) {
      const isDefaultType = initialDraft?.type === undefined && current.type === "LOST";
      if (current.type.trim() === "" || isDefaultType) {
        setType(handoff.patch.type);
        added.push("Type");
      } else {
        conflicts.push({ field: "type", label: "Type", incoming: handoff.patch.type });
      }
    }
    if (handoff.patch.title !== undefined && handoff.patch.title !== current.title) {
      if (current.title.trim() === "") {
        setTitle(handoff.patch.title);
        added.push("Title");
      } else {
        conflicts.push({ field: "title", label: "Title", incoming: handoff.patch.title });
      }
    }
    if (handoff.patch.description !== undefined && handoff.patch.description !== current.description) {
      if (current.description.trim() === "") {
        descriptionLiveRef.current = handoff.patch.description;
        setDescription(handoff.patch.description);
        added.push("Description");
      } else {
        conflicts.push({ field: "description", label: "Description", incoming: handoff.patch.description });
      }
    }
    const incomingCategory = releasedCategoryOrEmpty(handoff.patch.category);
    if (handoff.patch.category !== undefined && incomingCategory && incomingCategory !== current.category) {
      if (current.category === "") {
        setCategory(incomingCategory);
        added.push("Category");
      } else {
        conflicts.push({ field: "category", label: "Category", incoming: incomingCategory });
      }
    } else if (handoff.patch.category !== undefined && !incomingCategory) {
      announce("That category isn't available yet, so it was left out. Choose one manually.");
    }
    if (handoff.patch.eventDate !== undefined && handoff.patch.eventDate !== current.eventDate) {
      const isDefaultDate = initialDraft?.eventDate === undefined && current.eventDate === todayInputValue();
      if (current.eventDate.trim() === "" || isDefaultDate) {
        setEventDate(handoff.patch.eventDate);
        added.push("Date");
      } else {
        conflicts.push({ field: "eventDate", label: "Date", incoming: handoff.patch.eventDate });
      }
    }
    if (handoff.patch.locationNote !== undefined && handoff.patch.locationNote !== current.location.label) {
      if (current.location.label.trim() === "") {
        setLocation({ ...current.location, label: handoff.patch.locationNote });
        added.push("Location");
      } else {
        conflicts.push({ field: "location", label: "Location", incoming: handoff.patch.locationNote });
      }
    }
    setAssistantHandoff(handoff);
    setHandoffAdded(added);
    setHandoffConflicts(conflicts);
    if (added.length > 0 && conflicts.length === 0) {
      announce("Assistant suggestions added to empty fields. Review before publishing.");
    } else if (conflicts.length > 0 && added.length === 0) {
      announce("Assistant suggestions kept aside. Your details were kept. Confirm to use the assistant values.");
    } else if (added.length > 0 && conflicts.length > 0) {
      announce("Assistant suggestions added to empty fields. Some fields already have your details and were kept.");
    } else {
      announce("Assistant suggestions ready for review. Nothing was published automatically.");
    }
    if (added.length > 0) {
      setFieldErrors((previous) => {
        const next = { ...previous };
        if (added.includes("Title")) next.title = undefined;
        if (added.includes("Description")) next.description = undefined;
        if (added.includes("Category")) next.category = undefined;
        if (added.includes("Date")) next.eventDate = undefined;
        return next;
      });
    }
  }

  function applyConflictingHandoffValues(): void {
    if (!assistantHandoff) return;
    for (const conflict of handoffConflicts) {
      if (conflict.field === "type") setType(conflict.incoming as PostType);
      else if (conflict.field === "title") setTitle(conflict.incoming);
      else if (conflict.field === "description") {
        descriptionLiveRef.current = conflict.incoming;
        setDescription(conflict.incoming);
      } else if (conflict.field === "category") setCategory(releasedCategoryOrEmpty(conflict.incoming));
      else if (conflict.field === "eventDate") setEventDate(conflict.incoming);
      else if (conflict.field === "location") {
        const current = formSnapshotRef.current.location;
        setLocation({ ...current, label: conflict.incoming });
      }
    }
    setHandoffAdded((previous) => [...previous, ...handoffConflicts.map((conflict) => conflict.label)]);
    setHandoffConflicts([]);
    announce("Assistant suggestions applied. Review before publishing.");
  }

  // Assistant handoff intake: versioned staged draft consumed once on mount,
  // plus live subscription while mounted. Fill-only-empty; conflicts need an
  // explicit confirmation. Photo/location choices stay user-reviewed.
  useEffect(() => {
    const pending = takeStagedAssistantReportHandoff();
    if (pending && isAssistantReportHandoff(pending)) applyAssistantHandoff(pending);
  }, []);

  useEffect(() => {
    return subscribeStagedAssistantReportHandoff((handoff) => {
      takeStagedAssistantReportHandoff();
      applyAssistantHandoff(handoff);
    });
  }, []);

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
    setAssistantHandoff(null);
    setUncertain(false);
    setHandoffConflicts([]);
    setHandoffAdded([]);
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
  function onPickBatch(picked: PickedPhoto[]): void {
    setError(null);
    setPhotoFileErrors([]);
    enqueuePick(async () => {
      await restorePromiseRef.current;
      const remaining = MAX_REPORT_PHOTOS - photosRef.current.length;
      if (remaining <= 0) {
        setPhotoLimitNotice(
          `Reports hold up to ${MAX_REPORT_PHOTOS} photos in a fixed order. Remove one first.`,
        );
        return;
      }
      // Validate after native conversion (including motion-still extraction).
      // Run each item at current capacity: an invalid item must not consume a
      // slot or prevent later valid items in the same selection from arriving.
      // Failures are labeled by selection position ("Photo 2") — never by
      // native URIs, which must not leak into the interface.
      let accepted = 0;
      let duplicates = 0;
      let unreadable = 0;
      let overflow = 0;
      const failures: string[] = [];
      for (const [selectionIndex, photo] of picked.entries()) {
        const position = selectionIndex + 1;
        const result = await processReportBatch(
          [photo],
          photosRef.current.length,
          hashRegistryRef.current,
          (item, file, hash) => {
            if (!ACCEPTED_IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES) {
              hashRegistryRef.current.delete(hash);
              unreadable += 1;
              failures.push(`Photo ${position}: ${file.size > MAX_IMAGE_BYTES
                ? "that photo is too large. Choose an image under 8 MB."
                : "that file isn't an image. Choose a PNG, JPEG, WebP, or GIF photo."}`);
              return;
            }
            acceptPickedPhoto(file, item, hash);
            accepted += 1;
          },
          selectionIndex,
        );
        duplicates += result.duplicates.length;
        unreadable += result.unreadable.length;
        overflow += result.overflow.length;
        for (const failed of result.unreadable) {
          failures.push(`Photo ${failed.index + 1}: ${failed.reason}`);
        }
      }
      setPhotoFileErrors(failures);
      setPhotoLimitNotice(formatBatchNotice(accepted, duplicates, unreadable, overflow) || null);
      diag("report.picker.batch", {
        picked: picked.length,
        accepted,
        duplicates,
        unreadable,
        overflow,
      }, { traceId: traceIdRef.current ?? undefined });
    });
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
    enqueuePick(async () => {
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
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
          failures.push(`${file.name}: that file isn't an image. Choose a PNG, JPEG, WebP, or GIF photo.`);
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
    });
  }

  async function onAddGallery(): Promise<void> {
    const remaining = MAX_REPORT_PHOTOS - photosRef.current.length;
    if (remaining <= 0) return;
    if (!isNativeCameraAvailable()) {
      fileInputRef.current?.click();
      return;
    }
    try {
      const picked = await chooseReportPhotos(remaining);
      if (picked.length === 0) return;
      onPickBatch(picked);
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }

  function onAddCamera(): void {
    if (!isNativeCameraAvailable()) {
      fileInputRef.current?.click();
      return;
    }
    void capturePhoto(takePhoto);
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
  }

  // Native capture/conversion rejects on real failures (cancellation returns
  // null). Never leave the button dead with an unhandled rejection.
  async function capturePhoto(pick: () => Promise<PickedPhoto | null>) {
    try {
      const picked = await pick();
      if (!picked) return;
      onPickBatch([picked]);
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }

  /**
   * Applies one reviewed AI field. Returns true only when the patch actually
   * landed: a declined replacement confirm leaves the suggestion visible
   * instead of resolving it away (the child resolves per the outcome).
   */
  function applyVlmSuggestion(patch: Partial<VlmAnalysis>): boolean {
    const replacesExisting =
      (!!title.trim() && !!patch.suggestedTitle && patch.suggestedTitle !== title) ||
      (!!description.trim() && !!patch.suggestedDescription && patch.suggestedDescription !== description) ||
      (!!category && !!patch.suggestedCategory && patch.suggestedCategory !== category);
    if (replacesExisting && !window.confirm("Replace the existing title, description or category with these reviewed AI suggestions?")) return false;
    if (patch.suggestedTitle !== undefined) setTitle(patch.suggestedTitle ?? "");
    if (patch.suggestedDescription !== undefined) {
      descriptionLiveRef.current = patch.suggestedDescription ?? "";
      setDescription(patch.suggestedDescription ?? "");
    }
    if (patch.suggestedCategory && isReleasedCategory(patch.suggestedCategory)) {
      setCategory(patch.suggestedCategory as Category);
    }
    return true;
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
      const postId =
        reportFiles.length <= 1
          ? await publishReport(reportInput, reportFiles[0] ?? null, traceIdRef.current ?? undefined)
          : await publishReportWithPhotos(reportInput, reportFiles, {
              traceId: traceIdRef.current ?? undefined,
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
      setAssistantHandoff(null);
      setUncertain(false);
      setHandoffConflicts([]);
      setHandoffAdded([]);
      setEditorResetKey((key) => key + 1);
      announce("Report published.");
      navigate(`/posts/${postId}`, { replace: true });
    } catch (err) {
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
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

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

      {assistantHandoff && (
        <section
          data-testid="assistant-handoff-notice"
          role="status"
          aria-label="Assistant suggestions"
          className="flex flex-col gap-2 rounded-m3-md border border-outline-variant p-3"
        >
          <p className="text-sm font-medium">Assistant suggestions</p>
          <p className="text-sm text-on-surface-variant">
            Review these details before publishing. Nothing was published automatically.
          </p>
          {handoffAdded.length > 0 && (
            <p className="text-xs text-on-surface-variant">Added to empty fields: {handoffAdded.join(", ")}.</p>
          )}
          {assistantHandoff.photoChoice !== undefined && (
            <p className="text-xs text-on-surface-variant">
              Photo suggestion:{" "}
              {assistantHandoff.photoChoice === "take"
                ? "Take a photo"
                : assistantHandoff.photoChoice === "choose"
                  ? "Choose a photo"
                  : "No photo"}
              . Review the photo section below.
            </p>
          )}
          {assistantHandoff.locationChoice !== undefined && (
            <p className="text-xs text-on-surface-variant">
              Location suggestion:{" "}
              {assistantHandoff.locationChoice === "map"
                ? "Pick on a map"
                : assistantHandoff.locationChoice === "current"
                  ? "Use current location"
                  : assistantHandoff.locationChoice === "typed"
                    ? "Typed place name"
                    : "Skipped location"}
              . Review the location section below.
            </p>
          )}
          {handoffConflicts.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-on-surface-variant">
                Kept your details for: {handoffConflicts.map((conflict) => conflict.label).join(", ")}. Confirm to
                replace them with the assistant values.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="md" onClick={() => setHandoffConflicts([])}>
                  Keep my details
                </Button>
                <Button type="button" variant="outline" size="md" onClick={applyConflictingHandoffValues}>
                  Use assistant suggestions
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

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
          onPreview={setPreviewPhotoId}
        />
        {photoLimitNotice && (
          <p className="text-xs text-error" role="status">
            {photoLimitNotice}
          </p>
        )}
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
        {!isNativeCameraAvailable() && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            onChange={(e) => {
              onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
        )}
      </section>

      {previewPhotoId && (
        <PhotoLightbox
          photo={photos.find((p) => p.id === previewPhotoId) ?? null}
          index={photos.findIndex((p) => p.id === previewPhotoId)}
          total={photos.length}
          onClose={() => setPreviewPhotoId(null)}
        />
      )}

      {photos.length > 0 && (
        <VlmSuggestions
          file={photos[0]!.file}
          currentTitle={title}
          currentDescription={description}
          currentCategory={category}
          onApply={applyVlmSuggestion}
        />
      )}

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

      <Button type="submit" size="lg" loading={busy} disabled={uncertain || !photoRecoveryReady}>
        Publish {type === "LOST" ? "lost" : "found"} report
      </Button>
      <Button type="button" variant="text" size="md" onClick={discardDraft}>
        Discard draft
      </Button>
    </form>
  );
}
