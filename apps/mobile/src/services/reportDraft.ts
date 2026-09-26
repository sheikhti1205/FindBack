import type { Category, PostType } from "@findback/shared";
import type { LocationValue } from "../components/LocationPicker";
import { storage } from "./storage";

/**
 * Durable per-photo ref for the report draft: the ordered photo ids plus the
 * rehydration refs for each slot. JSON-safe — the File bytes themselves live
 * in services/photoStore (persisted separately, small files only).
 */
export interface ReportPhotoRef {
  id: string;
  name?: string;
  type?: string;
  size?: number;
  nativeUri?: string | null;
  webPath?: string | null;
  format?: string | null;
}

/** In-app report draft: survives navigation (Help, map helper, model setup)
 *  AND process death (per-account localStorage layer, see below). */
export interface ReportDraft {
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

function readStoredDraft(accountId?: string | null): ReportDraft | null {
  // Account key first, then the legacy device-default key (drafts saved
  // before per-account scoping stay visible to this device's owner).
  const keys = [draftKey(accountId)];
  if ((accountId ?? DEFAULT_ACCOUNT) !== DEFAULT_ACCOUNT) keys.push(draftKey(null));
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Partial<ReportDraft>;
      if (!parsed || typeof parsed !== "object") continue;
      return {
        type: parsed.type ?? "LOST",
        title: typeof parsed.title === "string" ? parsed.title : "",
        description: typeof parsed.description === "string" ? parsed.description : "",
        category: (parsed.category ?? "") as ReportDraft["category"],
        eventDate: typeof parsed.eventDate === "string" ? parsed.eventDate : "",
        location: {
          label: "",
          latitude: null,
          longitude: null,
          ...((parsed.location ?? {}) as Partial<LocationValue>),
        },
        youtubeUrl: typeof parsed.youtubeUrl === "string" ? parsed.youtubeUrl : "",
        photoId: parsed.photoId ?? null,
        photoNativeUri: parsed.photoNativeUri ?? null,
        photoWebPath: parsed.photoWebPath ?? null,
        photoFormat: parsed.photoFormat ?? null,
        photoIds: Array.isArray(parsed.photoIds)
          ? parsed.photoIds.filter((v): v is string => typeof v === "string")
          : undefined,
        photoRefs: Array.isArray(parsed.photoRefs)
          ? (parsed.photoRefs.filter(
              (v): v is ReportPhotoRef => !!v && typeof (v as ReportPhotoRef).id === "string",
            ) as ReportPhotoRef[])
          : undefined,
      };
    } catch {
      continue;
    }
  }
  return null;
}

let draft: ReportDraft | null = null;

export function saveDraft(d: ReportDraft, accountId?: string | null): void {
  draft = cloneDraft(d);
  try {
    storage.setItem(draftKey(accountId), JSON.stringify(draft));
    trackAccount(accountId);
  } catch {
    /* storage full/blocked: the memory draft still works for this session */
  }
}

export function loadDraft(accountId?: string | null): ReportDraft | null {
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
  draft = null;
  try {
    storage.removeItem(draftKey(accountId));
    untrackAccount(accountId);
  } catch {
    /* best-effort */
  }
}

/** Drop every stored draft (sign-out path; coordinator wires the call). */
export function clearAllStoredDrafts(): void {
  draft = null;
  try {
    for (const key of readAccountIndex()) {
      storage.removeItem(`${DRAFT_KEY_PREFIX}${key}`);
    }
    storage.removeItem(DRAFT_ACCOUNT_INDEX_KEY);
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
