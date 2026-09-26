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
import { isNativeCameraAvailable, takePhoto, chooseReportPhotos, photoToFile, type PickedPhoto } from "../services/photo";
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
      const web = ref?.webPath;
      const nativeUri = ref?.nativeUri;
restored.push({
        id,
        file: stashed,
        previewUrl:
          web && !web.startsWith("blob:")
            ? web
            : canCreateObjectUrl()
            ? URL.createObjectURL(stashed)
            : "",
        picked:
          nativeUri && !nativeUri.startsWith("blob:")
            ? {
                nativeUri,
                webPath: web && !web.startsWith("blob:") ? web : nativeUri,
                format: ref?.format ?? "jpg",
                id: crypto.randomUUID(),
              }
            : (getStashedPhotoMeta(id)?.picked ?? null),
      });
    }
    return restored;
  }
  const [photos, setPhotos] = useState<ReportPhoto[]>(() => initialPhotos(initialDraft));
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
  const [photoLimitNotice, setPhotoLimitNotice] = useState<string | null>(null);
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

  // Durable mount restore: rehydrate persisted photo bytes (small files),
  // then revive native-capture refs (all 5 slots) via photoToFile, then merge
  // everything into state in draft order. Never touches the editor instance.
  useEffect(() => {
    let cancelled = false;
    const generation = renderGeneration;
    void (async () => {
      try {
        await restoreStashedPhotos(accountId);
      } catch {
        /* session memory still works */
      }
      if (cancelled || generation !== draftGeneration(accountId)) return;
      const fresh = loadDraft(accountId);
      const pendings = findPendingNativeRestores(fresh ?? initialDraft);
      const converted = new Map<string, { file: File; picked: PickedPhoto }>();
      for (const pending of pendings) {
        try {
          const file = await photoToFile(pending.picked);
          if (cancelled || generation !== draftGeneration(accountId)) return;
          converted.set(pending.id, { file, picked: pending.picked });
        } catch {
          /* that slot stays unrestored; the draft text is unaffected */
        }
      }
      if (cancelled || generation !== draftGeneration(accountId)) return;
      setPhotos((prev) => {
        if (generation !== draftGeneration(accountId)) return prev;
        const next = [...prev];
        for (const id of draftPhotoIds(fresh ?? initialDraft).slice(0, MAX_REPORT_PHOTOS)) {
          if (next.some((p) => p.id === id)) continue;
          const conv = converted.get(id);
          const file = conv?.file ?? getStashedPhoto(id);
          if (!file) continue;
          const ref = draftPhotoRef(fresh ?? initialDraft, id);
          const picked = conv?.picked ?? refToPicked(ref) ?? getStashedPhotoMeta(id)?.picked ?? null;
          const web = picked?.webPath;
          next.push({
            id,
            file,
            previewUrl:
              web && !web.startsWith("blob:")
                ? web
                : canCreateObjectUrl()
                  ? URL.createObjectURL(file)
                  : "",
            picked,
          });
        }
        return next.length === prev.length ? prev : next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only: accountId is fixed for the signed-in session mount.
  }, []);

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
        })),
      },
      accountId,
      renderGeneration,
    );
  }, [type, title, description, category, eventDate, location, youtubeUrl, photos, accountId, renderGeneration, uncertain]);

  // Photo bytes follow the photo set only (not every keystroke): the registry
  // mirrors memory authoritatively, so removals are pruned on write.
  useEffect(() => {
    void persistStashedPhotos(accountId).catch(() => undefined);
  }, [photos, accountId]);

  // Blob lifecycle (W6 #16): revoke preview URLs on unmount but KEEP stashed Files.
  // Remount recreates object URLs from the stashed Files (all 5 slots via the
  // durable draft + photo registry).
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const mediaPickerPhotos = useMemo(
    () =>
      photos.map((p) => ({
        id: p.id,
        webPath: p.previewUrl,
        format: p.picked?.format,
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
    if (!draftIsMeaningful(current) && photos.length === 0) return;
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
    setAssistantHandoff(null);
    setUncertain(false);
    setHandoffConflicts([]);
    setHandoffAdded([]);
    announce("Report draft discarded.");
  }

  function onPickImage(file: File | undefined, photo?: PickedPhoto) {
    if (!file) return;
    // The accept attribute is advisory; reject doomed uploads with a clear
    // reason instead of failing at publish time.
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError("That file isn't an image. Choose a PNG, JPEG, WebP, or GIF photo.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("That photo is too large. Choose an image under 8 MB.");
      return;
    }
    if (photosRef.current.length >= MAX_REPORT_PHOTOS) {
      setPhotoLimitNotice(
        `Reports hold up to ${MAX_REPORT_PHOTOS} photos in a fixed order. ` +
          "This photo was not added — remove one first.",
      );
      return;
    }
    acceptPickedPhoto(file, photo ?? null);
    setError(null);
    setPhotoLimitNotice(null);
    // Diag: picker result
    diag("report.picker.result", {
      mime: file.type,
      bytes: file.size,
      source: photo?.nativeUri ? "native" : "web",
      hasNativeUri: !!photo?.nativeUri,
      photoCount: photosRef.current.length,
    }, { traceId: traceIdRef.current ?? undefined });
  }

  function acceptPickedPhoto(file: File, photo: PickedPhoto | null, hash?: string): string {
    const id = stashPhotoFile(file, { picked: photo ?? null, accountId });
    const preview =
      photo?.nativeUri && !photo.nativeUri.startsWith("blob:")
        ? photo.webPath
        : canCreateObjectUrl()
          ? URL.createObjectURL(file)
          : "";
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
    enqueuePick(async () => {
      const remaining = MAX_REPORT_PHOTOS - photosRef.current.length;
      if (remaining <= 0) {
        setPhotoLimitNotice(
          `Reports hold up to ${MAX_REPORT_PHOTOS} photos in a fixed order. Remove one first.`,
        );
        return;
      }
      // Capacity is recomputed when the queued task actually runs, so a second
      // overlapping action can never race past the 5-photo cap (R-073).
      const result = await processReportBatch(
        picked,
        photosRef.current.length,
        hashRegistryRef.current,
        (photo, file, hash) => acceptPickedPhoto(file, photo, hash),
      );
      setPhotoLimitNotice(result.notice || null);
      diag("report.picker.batch", {
        picked: picked.length,
        accepted: result.accepted.length,
        duplicates: result.duplicates.length,
        unreadable: result.unreadable.length,
        overflow: result.overflow.length,
      }, { traceId: traceIdRef.current ?? undefined });
    });
  }

  /** Web file-input path: same duplicate/limit semantics as the native batch. */
  function onPickFiles(files: FileList | null): void {
    if (!files || files.length === 0) return;
    const remaining = MAX_REPORT_PHOTOS - photosRef.current.length;
    const list = Array.from(files);
    const overflow = list.length > remaining;
    const accepted = list.slice(0, Math.max(0, remaining));
    if (accepted.length === 0) {
      setPhotoLimitNotice(
        `Reports hold up to ${MAX_REPORT_PHOTOS} photos in a fixed order. Remove one first.`,
      );
      return;
    }
    setError(null);
    let unreadable = 0;
    const pending: Array<{ id: string; file: File }> = [];
    for (const file of accepted) {
      if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
        setError("That file isn't an image. Choose a PNG, JPEG, WebP, or GIF photo.");
        unreadable += 1;
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError("That photo is too large. Choose an image under 8 MB.");
        unreadable += 1;
        continue;
      }
      // Add optimistically so a fast "pick then publish" never drops the
      // photo; the digest check below removes exact duplicates afterwards.
      const id = acceptPickedPhoto(file, null);
      pending.push({ id, file });
    }
    if (unreadable > 0 || overflow) {
      setPhotoLimitNotice(
        formatBatchNotice(0, 0, unreadable, overflow ? list.length - accepted.length : 0) || null,
      );
    }
    enqueuePick(async () => {
      let duplicates = 0;
      for (const { id, file } of pending) {
        let digest: string;
        try {
          digest = await computeSha256Hex(file);
        } catch {
          continue;
        }
        // The photo may have been removed while the digest was computing; a
        // removed photo must not claim its bytes in the registry, or a later
        // reselect of the same file would be wrongly rejected (R-072).
        if (!photosRef.current.some((p) => p.id === id)) continue;
        if (hashRegistryRef.current.has(digest)) {
          duplicates += 1;
          removePhoto(id);
          continue;
        }
        hashRegistryRef.current.add(digest);
        photosRef.current = photosRef.current.map((p) => (p.id === id ? { ...p, hash: digest } : p));
        setPhotos(photosRef.current);
      }
      if (duplicates > 0) {
        setPhotoLimitNotice(formatBatchNotice(0, duplicates, 0, 0));
      }
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
  }

  // Native capture/conversion rejects on real failures (cancellation returns
  // null). Never leave the button dead with an unhandled rejection.
  async function capturePhoto(pick: () => Promise<PickedPhoto | null>) {
    try {
      const picked = await pick();
      if (!picked) return;
      const file = await photoToFile(picked);
      onPickImage(file, picked);
    } catch (err) {
      setError(friendlyError(err).message);
    }
  }

  function applyVlmSuggestion(patch: Partial<VlmAnalysis>) {
    const replacesExisting =
      (!!title.trim() && !!patch.suggestedTitle && patch.suggestedTitle !== title) ||
      (!!description.trim() && !!patch.suggestedDescription && patch.suggestedDescription !== description) ||
      (!!category && !!patch.suggestedCategory && patch.suggestedCategory !== category);
    if (replacesExisting && !window.confirm("Replace the existing title, description or category with these reviewed AI suggestions?")) return;
    if (patch.suggestedTitle !== undefined) setTitle(patch.suggestedTitle ?? "");
    if (patch.suggestedDescription !== undefined) {
      descriptionLiveRef.current = patch.suggestedDescription ?? "";
      setDescription(patch.suggestedDescription ?? "");
    }
    if (patch.suggestedCategory && isReleasedCategory(patch.suggestedCategory)) {
      setCategory(patch.suggestedCategory as Category);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting.current || uncertain) return;
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
          disabled={submitting.current || uncertain}
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

      {photos.length > 0 && <VlmSuggestions file={photos[0]!.file} onApply={applyVlmSuggestion} />}

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

      <Button type="submit" size="lg" loading={busy} disabled={uncertain}>
        Publish {type === "LOST" ? "lost" : "found"} report
      </Button>
      <Button type="button" variant="text" size="md" onClick={discardDraft}>
        Discard draft
      </Button>
    </form>
  );
}
