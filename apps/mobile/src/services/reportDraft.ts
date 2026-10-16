import type { Category, PostType } from "@findback/shared";
import type { LocationValue } from "../components/LocationPicker";
import { storage } from "./storage";

/**
 * Durable per-photo ref for the report draft: the ordered photo ids plus the
 * rehydration refs for each slot. JSON-safe — the File bytes themselves live
 * in services/photoStore (persisted separately in IndexedDB).
 */
export interface ReportPhotoRef {
  id: string;
  name?: string;
  type?: string;
  size?: number;
  nativeUri?: string | null;
  webPath?: string | null;
  format?: string | null;
  motionPhoto?: boolean;
}

/** In-app report draft: survives navigation (Help, map helper, model setup)
 *  AND process death (per-account localStorage layer, see below). */
export interface ReportDraft {
  /** A create request may have committed; do not retry until reconciled. */
  publishOutcome?: "uncertain";
  type: PostType;
  title: string;
  description: string;
  category: Category | "";
  eventDate: string;
  location: LocationValue;
  youtubeUrl: string;
  /** In-session key for the picked File (see services/photoStore). */
  photoId?: string | null;
  photoNativeUri?: string | null;
  photoWebPath?: string | null;
  photoFormat?: string | null;
  /** Ordered photo ids 1..5 (durable, replaces the old session-only carry). */
  photoIds?: string[];
  /** Durable per-photo refs in display order (rehydration + orphan audit). */
  photoRefs?: ReportPhotoRef[];
}

const DRAFT_KEY_PREFIX = "findback:reportDraft:v1:";
const DRAFT_ACCOUNT_INDEX_KEY = "findback:reportDraftAccounts:v1";
const DEFAULT_ACCOUNT = "default";

function draftKey(accountId?: string | null): string {
  return `${DRAFT_KEY_PREFIX}${accountId ?? DEFAULT_ACCOUNT}`;
}

function cloneDraft(d: ReportDraft): ReportDraft {
  return {
    ...d,
    location: { ...d.location },
    photoIds: d.photoIds ? [...d.photoIds] : d.photoIds,
    photoRefs: d.photoRefs ? d.photoRefs.map((r) => ({ ...r })) : d.photoRefs,
  };
}

function readAccountIndex(): string[] {
  try {
    const raw = storage.getItem(DRAFT_ACCOUNT_INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function trackAccount(accountId?: string | null): void {
  try {
    const key = accountId ?? DEFAULT_ACCOUNT;
    const index = readAccountIndex();
    if (!index.includes(key)) {
      storage.setItem(DRAFT_ACCOUNT_INDEX_KEY, JSON.stringify([...index, key]));
    }
  } catch {
    /* index is best-effort; the draft itself is already written */
  }
}

function untrackAccount(accountId?: string | null): void {
  try {
    const key = accountId ?? DEFAULT_ACCOUNT;
    storage.setItem(
      DRAFT_ACCOUNT_INDEX_KEY,
      JSON.stringify(readAccountIndex().filter((v) => v !== key)),
    );
  } catch {
    /* best-effort */
  }
}

/** A string from an untrusted draft, or the empty default. */
function storedString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A string id/URI from an untrusted draft, or nothing. */
function storedStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * One stored photo ref, rebuilt field by field. The ref travelled through
 * localStorage from an older build, so its own fields are as untrusted as the
 * top-level ones: a numeric `nativeUri` used to survive this loader and then
 * throw inside `uri.startsWith(...)` on mount. A ref with no string id is not a
 * ref; a wrong-typed optional field is dropped, and the URIs are strings or
 * nothing.
 */
function readStoredPhotoRef(value: unknown): ReportPhotoRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as Partial<ReportPhotoRef>;
  if (typeof ref.id !== "string") return null;
  const next: ReportPhotoRef = { id: ref.id };
  if (typeof ref.name === "string") next.name = ref.name;
  if (typeof ref.type === "string") next.type = ref.type;
  if (typeof ref.size === "number" && Number.isFinite(ref.size)) next.size = ref.size;
  if (typeof ref.format === "string") next.format = ref.format;
  if (typeof ref.motionPhoto === "boolean") next.motionPhoto = ref.motionPhoto;
  const nativeUri = storedStringOrNull(ref.nativeUri);
  const webPath = storedStringOrNull(ref.webPath);
  if (nativeUri !== null) next.nativeUri = nativeUri;
  if (webPath !== null) next.webPath = webPath;
  return next;
}

/** A coordinate: a finite number, a numeric string, or nothing. */
function storedCoordinate(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * One stored draft, rebuilt into the current shape or rejected.
 *
 * Drafts outlive the app's own schema: a report started weeks ago is restored by
 * whatever build is running now, so this reads a payload it did not write. Every
 * field is therefore re-derived from an allow-list. Fields the current shape does
 * not know — the retired AI metadata, anything a build in between added, anything
 * hand-edited — are dropped rather than carried forward into state; a value of the
 * wrong type becomes the empty default instead of reaching the form, where one
 * `.trim()` on a number would turn "restore my draft" into a blank screen.
 *
 * Text and photos are what must survive a restore; every other field is
 * best-effort, and a payload that is not a draft at all is no draft.
 */
function readStoredDraft(accountId?: string | null): ReportDraft | null {
  // The legacy device-default draft has no owner: never expose it to an
  // authenticated account merely because that account was first to sign in.
  for (const key of [draftKey(accountId)]) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<ReportDraft> & { location?: unknown };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const location =
        parsed.location && typeof parsed.location === "object" && !Array.isArray(parsed.location)
          ? (parsed.location as Partial<LocationValue>)
          : {};
      return {
        publishOutcome: parsed.publishOutcome === "uncertain" ? "uncertain" : undefined,
        type: parsed.type === "FOUND" ? "FOUND" : "LOST",
        title: storedString(parsed.title),
        description: storedString(parsed.description),
        category: typeof parsed.category === "string" ? (parsed.category as Category) : "",
        eventDate: storedString(parsed.eventDate),
        location: {
          label: storedString(location.label),
          latitude: storedCoordinate(location.latitude),
          longitude: storedCoordinate(location.longitude),
        },
        youtubeUrl: storedString(parsed.youtubeUrl),
        photoId: storedStringOrNull(parsed.photoId),
        photoNativeUri: storedStringOrNull(parsed.photoNativeUri),
        photoWebPath: storedStringOrNull(parsed.photoWebPath),
        photoFormat: storedStringOrNull(parsed.photoFormat),
        photoIds: Array.isArray(parsed.photoIds)
          ? parsed.photoIds.filter((v): v is string => typeof v === "string")
          : undefined,
        photoRefs: Array.isArray(parsed.photoRefs)
          ? (parsed.photoRefs
              .map(readStoredPhotoRef)
              .filter((ref): ref is ReportPhotoRef => ref !== null))
          : undefined,
      };
    } catch {
      continue;
    }
  }
  return null;
}

const drafts = new Map<string, ReportDraft>();
const generations = new Map<string, number>();

/** A form captures this epoch; an old form cannot save after its publish clears. */
export function draftGeneration(accountId?: string | null): number {
  return generations.get(draftKey(accountId)) ?? 0;
}

export function saveDraft(d: ReportDraft, accountId?: string | null, generation?: number): void {
  if (generation !== undefined && generation !== draftGeneration(accountId)) return;
  const draft = cloneDraft(d);
  drafts.set(draftKey(accountId), draft);
  try {
    storage.setItem(draftKey(accountId), JSON.stringify(draft));
    trackAccount(accountId);
  } catch {
    /* storage full/blocked: the memory draft still works for this session */
  }
}

export function loadDraft(accountId?: string | null): ReportDraft | null {
  const draft = drafts.get(draftKey(accountId));
  if (draft) return cloneDraft(draft);
  const stored = readStoredDraft(accountId);
  return stored ? cloneDraft(stored) : null;
}

export function clearDraft(accountId?: string | null): void {
  // No-arg clears EVERYTHING (memory + all stored accounts): this preserves
  // the pre-durable single-global-draft semantics for sign-out paths and
  // test teardown. Pass an explicit account (or null) to clear one scope.
  if (accountId === undefined) {
    clearAllStoredDrafts();
    return;
  }
  drafts.delete(draftKey(accountId));
  generations.set(draftKey(accountId), draftGeneration(accountId) + 1);
  try {
    storage.removeItem(draftKey(accountId));
    untrackAccount(accountId);
  } catch {
    /* best-effort */
  }
}

/** Drop every stored draft (sign-out path; coordinator wires the call). */
export function clearAllStoredDrafts(): void {
  for (const key of new Set([...drafts.keys(), ...generations.keys()])) {
    generations.set(key, (generations.get(key) ?? 0) + 1);
  }
  drafts.clear();
  try {
    for (const key of readAccountIndex()) {
      generations.set(`${DRAFT_KEY_PREFIX}${key}`, draftGeneration(key) + 1);
      storage.removeItem(`${DRAFT_KEY_PREFIX}${key}`);
    }
    storage.removeItem(DRAFT_ACCOUNT_INDEX_KEY);
    generations.set(draftKey(null), draftGeneration(null) + 1);
    storage.removeItem(draftKey(null));
  } catch {
    /* best-effort */
  }
}

/** True when the draft holds anything worth confirming before discard. */
export function draftIsMeaningful(d: ReportDraft | null): boolean {
  if (!d) return false;
  return Boolean(
    d.title.trim() || d.description.trim() || d.category || d.location.label.trim() || d.youtubeUrl.trim(),
  );
}
