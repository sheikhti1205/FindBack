/**
 * Saved reports (bookmarks) — the ONE owner of what the reader saved.
 *
 * LOCAL FIRST, SERVER ADAPTED. The toggle has to work instantly and offline,
 * so the DEVICE list is the immediate truth: a save writes the account's local
 * record first and never waits for (or depends on) the server answering. The
 * account side (`post_saves` + three RPCs, migration
 * `20261021162726_post_saves.sql`) is an ADAPTER on top of that: when it
 * exists and answers, the record is marked `synced` and the surface can say
 * "Saved to your account"; when it is missing, offline or failing, the record
 * stays local-only and the surface says "Saved on this device". Neither state
 * is ever guessed: the UI reports which one it is actually in.
 *
 * NOTHING SENSITIVE IS STORED: a post id, the report title and the moment it
 * was saved. No email, no description, no photo, no token.
 *
 * Storage is per ACCOUNT (`findback.saved.v1.<account id>`), so a second
 * account on the same device never inherits the first one's list — the same
 * per-account key rule the cloud-model preferences use. What comes back out of
 * storage is validated: a payload that does not parse, or a record that is not
 * shaped like a record, is DISCARDED rather than trusted.
 *
 * A REMOVAL is stored as an INTENT next to the list (a tombstone): while the
 * account still holds the report — or while the account cannot be reached —
 * the intent keeps the report out of the reader's list and keeps the unsave
 * queued, so a save the reader took away never comes back on the next launch.
 * Saving the report again cancels the intent.
 *
 * THE ACCOUNT'S LIST arrives as an ENVELOPE: `{ items: [{ post_id, saved_at }],
 * complete }`, where `complete` says whether the list is the WHOLE list. Only
 * a complete list may be read as "the account does not hold this report" — a
 * truncated list would make a saved report look like one that was removed on
 * another device. A bare array (the older contract) is still read, but it is
 * never complete.
 */
import { getSupabase } from "./supabaseClient";

/** Storage key prefix; the account id is appended, URL-encoded. */
export const SAVED_REPORTS_STORAGE_PREFIX = "findback.saved.v1";

/**
 * Storage key prefix for the REMOVAL INTENTS (the tombstones).
 *
 * A removal that happens while the account is unreachable has to survive until
 * the account drops the report: without the intent the next launch would read
 * the account's list, find the report still there and bring it back — a save
 * the reader had explicitly taken away. The intent is what makes "removed"
 * durable; the account copy is only cleaned up later.
 */
export const SAVED_REPORTS_REMOVALS_STORAGE_PREFIX = "findback.saved.v1.removals";

export interface SavedReportEntry {
  /** The report's id (never anything else about the report). */
  postId: string;
  /** Title snapshot, so an offline list still says what was saved. */
  title: string;
  /**
   * ISO-8601 moment the report was saved on this device.
   *
   * THIS IS THE DEVICE'S FIRST SAVE, not the account's. The account's own
   * stamp (`saved_at`, read back from the list RPC) is the moment of the LAST
   * EXPLICIT save, because a re-save refreshes the server's clock. The two
   * stamps therefore answer different questions and must not be compared as if
   * they were the same moment: this one is when the device first saved the
   * report, the server one is when the account last confirmed a save.
   */
  savedAt: string;
  /** True when the ACCOUNT confirmed this save (the server RPC answered). */
  synced: boolean;
}

/**
 * A removal the reader asked for, kept until the ACCOUNT has dropped the
 * report. It is what stops a save from coming back on the next launch.
 */
export interface SavedReportRemoval {
  /** The report's id. */
  postId: string;
  /** ISO-8601 moment the reader removed it. */
  removedAt: string;
}

/** The three account-side RPCs (migration `20261021162726_post_saves.sql`). */
const SAVE_RPC = "findback_save_post_client";
const UNSAVE_RPC = "findback_unsave_post_client";
const LIST_SAVED_RPC = "findback_list_saved_posts_client";

/** A reader never keeps more than this; the oldest fall off the end. */
export const MAX_SAVED_REPORTS = 200;
const MAX_TITLE_LENGTH = 300;
const MAX_POST_ID_LENGTH = 128;

function storageKey(accountId: string): string {
  return `${SAVED_REPORTS_STORAGE_PREFIX}.${encodeURIComponent(accountId)}`;
}

function removalsKey(accountId: string): string {
  return `${SAVED_REPORTS_REMOVALS_STORAGE_PREFIX}:${encodeURIComponent(accountId)}`;
}

/**
 * A post id is a short opaque token. Rejecting control characters keeps a
 * hand-edited value from smuggling a line break into the surface.
 */
function isValidPostId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_POST_ID_LENGTH) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/** Titles are display text: trimmed, length-capped, never control characters. */
function normalizeTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  let out = "";
  for (const character of trimmed.slice(0, MAX_TITLE_LENGTH)) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : character;
  }
  return out;
}

/** A stored record is only trusted when every field is the shape we wrote. */
function toEntry(value: unknown): SavedReportEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<SavedReportEntry>;
  if (!isValidPostId(entry.postId)) return null;
  if (typeof entry.title !== "string") return null;
  if (typeof entry.savedAt !== "string" || Number.isNaN(Date.parse(entry.savedAt))) return null;
  if (typeof entry.synced !== "boolean") return null;
  return {
    postId: entry.postId.trim(),
    title: normalizeTitle(entry.title),
    savedAt: entry.savedAt,
    synced: entry.synced,
  };
}

function readRawAt(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Persisting is best effort, but it is NOT silent: the caller has to be able
 * to say "this change did not reach the disk" instead of pretending the save
 * is durable. `false` means the browser refused the write.
 */
function persistAt(key: string, value: string): boolean {
  try {
    globalThis.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readRaw(accountId: string): string | null {
  return readRawAt(storageKey(accountId));
}

/** Write the device list. Returns false when the browser refused the write. */
function persist(accountId: string, entries: readonly SavedReportEntry[]): boolean {
  return persistAt(storageKey(accountId), JSON.stringify(entries));
}

/**
 * The account's saved reports on THIS device, newest first.
 *
 * A payload that is not a list, or a record that is not shaped like a record,
 * is discarded rather than trusted: the reader sees an empty list, never a
 * half-parsed one. Never throws.
 */
export function readSavedReports(accountId: string): SavedReportEntry[] {
  const raw = readRaw(accountId);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: SavedReportEntry[] = [];
  for (const item of parsed) {
    const entry = toEntry(item);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return entries;
}

/** Whether this report is saved on this device for this account. */
export function isReportSaved(accountId: string, postId: string): boolean {
  if (!isValidPostId(postId)) return false;
  return readSavedReports(accountId).some((entry) => entry.postId === postId.trim());
}

/** A stored removal intent is only trusted when it is shaped like one. */
function toRemoval(value: unknown): SavedReportRemoval | null {
  if (!value || typeof value !== "object") return null;
  const removal = value as Partial<SavedReportRemoval>;
  if (!isValidPostId(removal.postId)) return null;
  if (typeof removal.removedAt !== "string" || Number.isNaN(Date.parse(removal.removedAt))) {
    return null;
  }
  return { postId: removal.postId.trim(), removedAt: removal.removedAt };
}

/**
 * The removal intents for this account, newest first.
 *
 * A payload that does not parse, or a record that is not shaped like one, is
 * discarded rather than trusted. Never throws.
 */
export function readSavedReportRemovals(accountId: string): SavedReportRemoval[] {
  const raw = readRawAt(removalsKey(accountId));
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const removals: SavedReportRemoval[] = [];
  for (const item of parsed) {
    const removal = toRemoval(item);
    if (removal) removals.push(removal);
  }
  removals.sort((a, b) => b.removedAt.localeCompare(a.removedAt));
  return removals;
}

/** Record (or refresh) a removal intent for this account. */
export function recordSavedReportRemoval(
  accountId: string,
  postId: string,
): SavedReportRemoval[] {
  if (!isValidPostId(postId)) return readSavedReportRemovals(accountId);
  const trimmed = postId.trim();
  const existing = readSavedReportRemovals(accountId);
  const next = [
    { postId: trimmed, removedAt: new Date().toISOString() },
    ...existing.filter((removal) => removal.postId !== trimmed),
  ].slice(0, MAX_SAVED_REPORTS);
  persistAt(removalsKey(accountId), JSON.stringify(next));
  return next;
}

/**
 * Drop a removal intent — the account no longer holds the report, or the
 * account saved it again after the removal, so there is nothing left to clean
 * up.
 *
 * `persisted` says whether the disk took the drop. When it did not (a blocked
 * store) the tombstone is still on the disk, and the caller has to remember
 * that the intent is settled — otherwise it keeps hiding the report and keeps
 * queueing an unsave for the rest of the session.
 */
export function clearSavedReportRemoval(
  accountId: string,
  postId: string,
): { removals: SavedReportRemoval[]; persisted: boolean } {
  if (!isValidPostId(postId)) {
    return { removals: readSavedReportRemovals(accountId), persisted: true };
  }
  const trimmed = postId.trim();
  const existing = readSavedReportRemovals(accountId);
  const next = existing.filter((removal) => removal.postId !== trimmed);
  if (next.length === existing.length) return { removals: next, persisted: true };
  return {
    removals: next,
    persisted: persistAt(removalsKey(accountId), JSON.stringify(next)),
  };
}

/**
 * The result of a device write.
 *
 * `persisted` is the honest answer to "did this reach the disk?": when the
 * browser refuses the write (a blocked store, a full quota) the change is
 * still true FOR THIS SESSION, and the surface has to say exactly that
 * instead of claiming a durable save.
 */
export interface SavedReportWriteResult {
  /** The device list after the write (the session truth either way). */
  entries: SavedReportEntry[];
  /** The removal intents after the write. */
  removals: SavedReportRemoval[];
  /** False when the browser refused the write: the change lasts this session only. */
  persisted: boolean;
}

/**
 * What the session currently believes: the list the reader sees and the
 * removals they asked for.
 *
 * The session is NEWER than the disk (a blocked store leaves the disk behind),
 * so it is what a write has to start from — never the other way round.
 */
export interface SavedReportSessionState {
  entries: readonly SavedReportEntry[];
  removed: readonly SavedReportRemoval[];
  /**
   * The removal intents the ACCOUNT has settled: the report was dropped on
   * another device, or the account saved it again after the removal.
   *
   * A settled intent must not hide the report and must not queue an unsave.
   * The override is needed because the disk may refuse the write that drops the
   * tombstone (a blocked store): the intent would otherwise keep hiding the
   * report for the rest of the session.
   */
  settled?: readonly string[];
}

/** The merged view of the disk and the session. */
export interface SavedReportState {
  entries: SavedReportEntry[];
  removals: SavedReportRemoval[];
}

/**
 * The list the reader should see: what the disk holds and what the session
 * holds, minus the reports that were removed.
 *
 * The session wins on a conflict (it is the newer truth), and a removal intent
 * removes the report from BOTH sides — so a save the reader took away is never
 * resurrected by a later write. A SETTLED intent removes nothing: the account
 * has already dealt with it, so it may not keep hiding the report.
 */
export function readSavedReportState(
  accountId: string,
  session?: SavedReportSessionState,
): SavedReportState {
  const settled = new Set(session?.settled ?? []);
  const removals = new Map<string, SavedReportRemoval>();
  for (const removal of readSavedReportRemovals(accountId)) {
    if (settled.has(removal.postId)) continue;
    removals.set(removal.postId, removal);
  }
  for (const removal of session?.removed ?? []) {
    if (settled.has(removal.postId)) continue;
    const known = removals.get(removal.postId);
    if (!known || removal.removedAt > known.removedAt) {
      removals.set(removal.postId, removal);
    }
  }
  const byId = new Map<string, SavedReportEntry>();
  for (const entry of readSavedReports(accountId)) byId.set(entry.postId, entry);
  for (const entry of session?.entries ?? []) byId.set(entry.postId, entry);
  const entries = [...byId.values()]
    .filter((entry) => !removals.has(entry.postId))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  return {
    entries,
    removals: [...removals.values()].sort((a, b) => b.removedAt.localeCompare(a.removedAt)),
  };
}

/**
 * Save a report on this device. The LOCAL write always succeeds and is the
 * immediate truth; the returned list is the new device list.
 *
 * A record that already exists keeps its original `savedAt` (this is still the
 * same save) and its `synced` flag unless the title changed (a changed title
 * is a new statement about the report, so it waits for the account to confirm
 * it again).
 */
export function writeSavedReport(
  accountId: string,
  entry: Omit<SavedReportEntry, "savedAt" | "synced">,
): SavedReportEntry[] {
  return saveReportToDevice(accountId, entry).entries;
}

/**
 * Remove a report from this device's list.
 *
 * The removal is an INTENT, not only a deletion: the intent is recorded next
 * to the list so the account copy can be cleaned up later. See
 * {@link removeReportFromDevice}.
 */
export function removeSavedReport(accountId: string, postId: string): SavedReportEntry[] {
  return removeReportFromDevice(accountId, postId).entries;
}

/**
 * Save a report on this device and report whether the write was durable.
 *
 * The write starts from the SESSION's list (passed in), not from the disk:
 * when the browser refused an earlier write the disk is behind, and a write
 * that started there would drop the saves the reader can still see. The full
 * intended list is what gets persisted, so a store that recovers later
 * receives the whole list instead of a fragment.
 *
 * Saving again cancels a pending removal intent: the reader wants this saved,
 * so an older "remove this" must not keep hiding it.
 */
export function saveReportToDevice(
  accountId: string,
  entry: Omit<SavedReportEntry, "savedAt" | "synced">,
  session?: SavedReportSessionState,
): SavedReportWriteResult {
  const state = readSavedReportState(accountId, session);
  if (!isValidPostId(entry.postId)) {
    return { entries: state.entries, removals: state.removals, persisted: false };
  }
  const postId = entry.postId.trim();
  const title = normalizeTitle(entry.title);
  const previous = state.entries.find((item) => item.postId === postId);
  const next: SavedReportEntry = {
    postId,
    title,
    savedAt: previous?.savedAt ?? new Date().toISOString(),
    synced: previous ? previous.synced && previous.title === title : false,
  };
  const merged = [next, ...state.entries.filter((item) => item.postId !== postId)].slice(
    0,
    MAX_SAVED_REPORTS,
  );
  const removals = state.removals.filter((removal) => removal.postId !== postId);
  const entriesPersisted = persist(accountId, merged);
  const removalsPersisted = persistAt(removalsKey(accountId), JSON.stringify(removals));
  return {
    entries: merged,
    removals,
    persisted: entriesPersisted && removalsPersisted,
  };
}

/**
 * Remove a report from this device AND record the removal intent.
 *
 * The intent is what makes the removal durable: while the account still holds
 * the report (or while the account cannot be reached), the intent keeps the
 * report out of the reader's list and keeps the unsave queued, so the next
 * launch finishes the job instead of resurrecting the save.
 *
 * Like the save, the write starts from the SESSION's list: the other saves the
 * reader can still see must survive this removal even when the disk refused to
 * take the earlier ones.
 */
export function removeReportFromDevice(
  accountId: string,
  postId: string,
  session?: SavedReportSessionState,
): SavedReportWriteResult {
  if (!isValidPostId(postId)) {
    const state = readSavedReportState(accountId, session);
    return {
      entries: state.entries,
      removals: state.removals,
      persisted: false,
    };
  }
  const trimmed = postId.trim();
  const state = readSavedReportState(accountId, session);
  const entries = state.entries.filter((entry) => entry.postId !== trimmed);
  const removals = [
    { postId: trimmed, removedAt: new Date().toISOString() },
    ...state.removals.filter((removal) => removal.postId !== trimmed),
  ].slice(0, MAX_SAVED_REPORTS);
  const entriesPersisted = persist(accountId, entries);
  const removalsPersisted = persistAt(removalsKey(accountId), JSON.stringify(removals));
  return {
    entries,
    removals,
    persisted: entriesPersisted && removalsPersisted,
  };
}

/**
 * Record whether the ACCOUNT confirmed a save. Used after the server RPC
 * answered (or failed); the device list stays the immediate truth either way.
 *
 * The write starts from the SESSION's list, not from the disk: a save the
 * account confirmed while the browser refused to store it must not be lost
 * when the flag is written down, and a store that recovers later has to
 * receive the WHOLE list — not a fragment of it.
 */
export function markSavedReportSynced(
  accountId: string,
  postId: string,
  synced: boolean,
  session?: SavedReportSessionState,
): SavedReportEntry[] {
  if (!isValidPostId(postId)) {
    return readSavedReportState(accountId, session).entries;
  }
  const trimmed = postId.trim();
  const state = readSavedReportState(accountId, session);
  const next = state.entries
    .map((entry) => (entry.postId === trimmed ? { ...entry, synced } : entry))
    .slice(0, MAX_SAVED_REPORTS);
  persist(accountId, next);
  return next;
}

/**
 * Drop device records WITHOUT recording a removal intent.
 *
 * Used when the account proves the saves are gone: it removed the reports on
 * another device, and the account's list is the WHOLE list, so the absence is
 * a fact. There is nothing left to unsave, so a tombstone would only hide
 * reports the account no longer has — and a deliberate removal must not be
 * resurrected by a save.
 */
export function forgetSavedReports(
  accountId: string,
  postIds: readonly string[],
  session?: SavedReportSessionState,
): SavedReportWriteResult {
  const state = readSavedReportState(accountId, session);
  const drop = new Set<string>();
  for (const postId of postIds) {
    if (isValidPostId(postId)) drop.add(postId.trim());
  }
  if (drop.size === 0) {
    return { entries: state.entries, removals: state.removals, persisted: true };
  }
  const entries = state.entries.filter((entry) => !drop.has(entry.postId));
  return {
    entries,
    removals: state.removals,
    persisted: persist(accountId, entries),
  };
}

/**
 * What the ACCOUNT holds, and whether the account answered at all.
 *
 * `ok` is the honest difference between "the account says you saved nothing"
 * and "the account could not be reached" — a surface that reports the second
 * as the first would be lying about where the saves live.
 */
export interface SavedReportServerSnapshot {
  ids: string[];
  /** When each report was saved, keyed by post id (only when the account answered). */
  savedAts: Record<string, string>;
  ok: boolean;
  /**
   * True when the account's list is the WHOLE list — nothing was truncated.
   *
   * Only a complete list may be used to conclude "the account does not hold
   * this report": a truncated list would make a report the reader saved look
   * like one that was removed on another device.
   */
  complete: boolean;
}

/** One row of the account's list, as the server sends it. */
interface ServerRow {
  postId: string;
  savedAt: string | null;
}

/**
 * Read the rows of the account's list.
 *
 * A row that carries no usable id is dropped — one broken row must not cost
 * the reader the rest of their saves — but the answer then says so: the list
 * is missing a report, so it is NOT the whole list and no absence may be read
 * as a removal.
 */
function parseServerRows(value: unknown): { rows: ServerRow[]; complete: boolean } | null {
  if (!Array.isArray(value)) return null;
  const rows: ServerRow[] = [];
  let complete = true;
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      complete = false;
      continue;
    }
    const row = raw as { post_id?: unknown; saved_at?: unknown; created_at?: unknown };
    if (!isValidPostId(row.post_id)) {
      complete = false;
      continue;
    }
    const at = row.saved_at ?? row.created_at;
    rows.push({
      postId: row.post_id.trim(),
      savedAt: typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null,
    });
  }
  return { rows, complete };
}

function savedAtsOf(rows: readonly ServerRow[]): Record<string, string> {
  const savedAts: Record<string, string> = {};
  for (const row of rows) {
    if (row.savedAt) savedAts[row.postId] = row.savedAt;
  }
  return savedAts;
}

/**
 * Parse the account's list.
 *
 * The contract is an envelope: `{ items: [{ post_id, saved_at }], complete }`.
 * `complete` has to be the boolean `true` for the list to count as the WHOLE
 * list — anything else (missing, a string, `false`) means the list may be
 * truncated, and no absence may be read as a removal. A list that had to drop a
 * row is never complete either.
 *
 * A bare array is still accepted — the envelope-returning migration
 * (20261021162726_post_saves.sql) is applied on the hosted project, but an
 * older deployment may still answer with the old shape — but it is NEVER
 * complete: the old list could truncate its rows.
 */
function parseServerSnapshot(
  data: unknown,
): { ids: string[]; savedAts: Record<string, string>; complete: boolean } | null {
  if (Array.isArray(data)) {
    const parsed = parseServerRows(data);
    if (!parsed) return null;
    return {
      ids: parsed.rows.map((row) => row.postId),
      savedAts: savedAtsOf(parsed.rows),
      complete: false,
    };
  }
  if (!data || typeof data !== "object") return null;
  const envelope = data as { items?: unknown; complete?: unknown };
  if (!("items" in envelope)) return null;
  const parsed = parseServerRows(envelope.items);
  if (!parsed) return null;
  return {
    ids: parsed.rows.map((row) => row.postId),
    savedAts: savedAtsOf(parsed.rows),
    complete: envelope.complete === true && parsed.complete,
  };
}

/** Read the account's saved report ids. Never throws. */
export async function fetchSavedReportSnapshot(): Promise<SavedReportServerSnapshot> {
  try {
    const { data, error } = await getSupabase().rpc(LIST_SAVED_RPC);
    if (error) return { ids: [], savedAts: {}, ok: false, complete: false };
    const parsed = parseServerSnapshot(data);
    // An answer that does not parse is a FAILURE, never an empty list: an
    // empty list that claimed to be complete would read as "the account holds
    // nothing" and would wipe the reader's saves.
    if (!parsed) return { ids: [], savedAts: {}, ok: false, complete: false };
    return { ...parsed, ok: true };
  } catch {
    return { ids: [], savedAts: {}, ok: false, complete: false };
  }
}

/**
 * Save one report on the ACCOUNT.
 *
 * Best effort: `true` only when the server confirmed the row. A missing RPC
 * (a deployment that has not applied 20261021162726_post_saves.sql yet), an
 * offline device or a rejected post all answer `false` — never an exception,
 * because a failed account sync must degrade to the local-only state, not
 * crash the tap.
 */
export async function saveReportOnServer(postId: string): Promise<boolean> {
  if (!isValidPostId(postId)) return false;
  try {
    const { error } = await getSupabase().rpc(SAVE_RPC, { p_post_id: postId.trim() });
    return !error;
  } catch {
    return false;
  }
}

/** Remove one report from the ACCOUNT. Best effort; never throws. */
export async function unsaveReportOnServer(postId: string): Promise<boolean> {
  if (!isValidPostId(postId)) return false;
  try {
    const { error } = await getSupabase().rpc(UNSAVE_RPC, { p_post_id: postId.trim() });
    return !error;
  } catch {
    return false;
  }
}

/**
 * The account's saved report ids. Best effort: an empty list means "the
 * account says you saved nothing" OR "the account could not be reached" —
 * use {@link fetchSavedReportSnapshot} when the difference matters.
 */
export async function listSavedReportIdsFromServer(): Promise<string[]> {
  return (await fetchSavedReportSnapshot()).ids;
}
