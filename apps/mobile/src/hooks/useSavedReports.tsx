import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "../auth";
import {
  clearSavedReportRemoval,
  fetchSavedReportSnapshot,
  forgetSavedReports,
  markSavedReportSynced,
  readSavedReportState,
  removeReportFromDevice,
  saveReportToDevice,
  saveReportOnServer,
  unsaveReportOnServer,
  type SavedReportEntry,
  type SavedReportRemoval,
  type SavedReportSessionState,
} from "../services/savedReports";

/**
 * Saved reports — the ONE provider of saved state.
 *
 * Mirrors the shape of the feed's Love provider (a context, a memoised value,
 * an imperative API, an optimistic local update), with one difference the house
 * rules force: the DEVICE list is the immediate truth and the account is an
 * adapter on top of it. A tap never waits for the network and never rolls back
 * because the network was down — it says what is true instead.
 *
 * ONE OWNER, THREE RULES:
 *   1. The INTENT is explicit. `save`, `remove` and `toggle` never guess what
 *      the reader meant from the current state: a "remove" is a remove, even
 *      when only the ACCOUNT holds the report and this device knows nothing
 *      about it.
 *   2. The ACCOUNT is a scope, not a setting. Every list, every write and
 *      every continuation belongs to the account it started under: a reader who
 *      signs in as somebody else never sees the previous account's reports,
 *      and a call that answers late never writes into the new account.
 *   3. Nothing is claimed that did not happen. A save that did not reach the
 *      account says so, a save the browser refused to store says THAT too, and
 *      a removal the account has not confirmed yet stays removed on the device
 *      while the reader is told the account still has it.
 *
 * The API is described on {@link SavedReportsApi}; the surfaces render `rows`
 * and nothing else, so the button on a report and the row on the Saved
 * reports screen can never disagree about what is saved.
 *
 * OUTSIDE THE PROVIDER the hook is INERT, never broken: `isSaved` is false,
 * `save`/`remove`/`toggle` do nothing, and nothing throws. A control rendered
 * on its own (a preview, a test, an embed) must not take the app down with it.
 */

/** What is still wrong with one report's account state. */
export interface SavedReportIssue {
  /**
   * What the reader asked for.
   *
   * `conflict` is not a request: it says the account's answer could not settle
   * the report either way (the account's list was incomplete, so it neither
   * confirms nor denies the save).
   */
  intent: "save" | "unsave" | "conflict";
  /** The account did not do what was asked (it could not be reached, or it still has the report). */
  accountFailed: boolean;
  /** The device could not store the change: it lasts this session only. */
  storageFailed: boolean;
}

/** One saved report, as the surfaces render it. */
export interface SavedReportRow {
  /** The report's id. */
  id: string;
  /** The title snapshot taken when it was saved (empty for an account-only save). */
  title: string;
  /** When it was saved (the device moment, else the account's). */
  savedAt: string | null;
  /** This device holds a record for it. */
  onDevice: boolean;
  /** The ACCOUNT holds it. */
  onAccount: boolean;
  /** The account confirmed this save. */
  synced: boolean;
  /** What is still wrong with it, if anything. */
  issue: SavedReportIssue | null;
}

export interface SavedReportsApi {
  /** The saved reports, newest first. */
  rows: readonly SavedReportRow[];
  /** Reports saved for this account (device list ∪ account list). */
  savedIds: readonly string[];
  /** Whether this report is saved. */
  isSaved: (postId: string) => boolean;
  /** Save. Never throws; the device write always happens first. */
  save: (postId: string, title?: string) => Promise<boolean>;
  /** Remove. Never throws; the device write always happens first. */
  remove: (postId: string) => Promise<boolean>;
  /** Save/unsave. Never throws; the device write always happens first. */
  toggle: (postId: string, title?: string) => Promise<boolean>;
  /** An account write is in flight. */
  pending: boolean;
  /** Plain-language reason something did not land, if anything. */
  error: string | null;
  /** The same, per report: one failure is not erased by an unrelated success. */
  errorByPostId: Readonly<Record<string, SavedReportIssue>>;
  /** True when the ACCOUNT confirmed every saved report. */
  syncedToAccount: boolean;
  /** The account list is being fetched. */
  loading: boolean;
  /** The account could not be reached and this device holds nothing. */
  loadError: string | null;
  /** The account answered. */
  accountAnswered: boolean;
  /** The device can store the list (false when the browser refused a write). */
  storageHealthy: boolean;
  /** There is an account to save for. */
  hasAccount: boolean;
  /** Ask the account again. */
  retry: () => void;
}

/** The plain-language reason for each unresolved issue. */
const ISSUE_MESSAGES: Record<string, string> = {
  "save:account": "Saved on this device — your account did not confirm it.",
  "save:storage": "Saved for this session only — this browser is blocking storage.",
  "unsave:account": "Removed on this device — your account still has it.",
  "unsave:storage": "Removed for this session only — this browser is blocking storage.",
  "conflict:account": "Saved on this device — your account did not list it.",
  "conflict:storage": "Saved for this session only — this browser is blocking storage.",
};

/**
 * The plain-language reason for one report's issue.
 *
 * Where the save LIVES depends on what the account holds: a save the account
 * confirmed is on the account even when the browser refused to store a copy on
 * this device. Saying "for this session only" about such a save would be a lie
 * about where the reader's save lives.
 */
function issueMessage(
  issue: SavedReportIssue,
  postId: string,
  accountIds: readonly string[],
): string {
  if (issue.intent === "save" && issue.storageFailed) {
    return accountIds.includes(postId)
      ? "Saved to your account — this browser is blocking storage."
      : "Saved for this session only — this browser is blocking storage.";
  }
  return (
    ISSUE_MESSAGES[`${issue.intent}:${issue.storageFailed ? "storage" : "account"}`] ??
    "Something did not reach your account."
  );
}

/**
 * Fold one report's issue forward.
 *
 * The account half and the device half are tracked separately: an account
 * write that succeeds does NOT clear a storage failure, and a storage write
 * that succeeds does NOT clear an account failure. An issue disappears only
 * when both halves are resolved.
 */
function withIssue(
  issues: Record<string, SavedReportIssue>,
  postId: string,
  intent: "save" | "unsave" | "conflict",
  patch: { accountFailed?: boolean; storageFailed?: boolean },
): Record<string, SavedReportIssue> {
  const existing = issues[postId];
  const next: SavedReportIssue = {
    intent,
    accountFailed: patch.accountFailed ?? existing?.accountFailed ?? false,
    storageFailed: patch.storageFailed ?? existing?.storageFailed ?? false,
  };
  const out = { ...issues };
  if (!next.accountFailed && !next.storageFailed) delete out[postId];
  else out[postId] = next;
  return out;
}

/**
 * Mark the reports the account's answer could not settle.
 *
 * A conflict is not a failure of the reader's save: the account's list was
 * incomplete, so it neither confirms nor denies the save. The reader is told
 * so on the row, and nothing is saved again behind their back.
 */
function withConflicts(
  issues: Record<string, SavedReportIssue>,
  postIds: readonly string[],
): Record<string, SavedReportIssue> {
  let out = issues;
  for (const postId of postIds) {
    out = withIssue(out, postId, "conflict", { accountFailed: true });
  }
  return out;
}

/**
 * Drop the issues of reports that are no longer on the list.
 *
 * A report the account dropped on another device is gone: its issue must not
 * keep claiming that something is wrong with a report that is not there.
 */
function withoutIssues(
  issues: Record<string, SavedReportIssue>,
  postIds: readonly string[],
): Record<string, SavedReportIssue> {
  if (postIds.length === 0) return issues;
  const out = { ...issues };
  for (const postId of postIds) delete out[postId];
  return out;
}

/** The inert value used outside a provider. Stable, so it never re-renders. */
const INERT: SavedReportsApi = {
  rows: [],
  savedIds: [],
  isSaved: () => false,
  save: async () => false,
  remove: async () => false,
  toggle: async () => false,
  pending: false,
  error: null,
  errorByPostId: {},
  syncedToAccount: false,
  loading: false,
  loadError: null,
  accountAnswered: false,
  storageHealthy: true,
  hasAccount: false,
  retry: () => {},
};

const SavedReportsContext = createContext<SavedReportsApi | null>(null);

/** The state the provider owns, for ONE account. */
interface Snapshot {
  /** The account this state belongs to. */
  accountId: string | null;
  /** The device list. */
  entries: SavedReportEntry[];
  /** What the account holds (only when it answered). */
  accountIds: string[];
  /** When the account saved each report. */
  accountSavedAts: Record<string, string>;
  /** The account answered. */
  accountAnswered: boolean;
  /** Reports the reader removed: they stay out of the list until the account drops them. */
  removed: SavedReportRemoval[];
  /**
   * The removal intents the account has settled and the disk refused to drop.
   *
   * A settled intent must not hide the report and must not queue an unsave,
   * even when the tombstone is still on the disk because the store refused the
   * write.
   */
  settledRemovals: string[];
  /** What is still wrong, per report. */
  issues: Record<string, SavedReportIssue>;
  /** The account list is being fetched. */
  loading: boolean;
  /** The account could not be reached and this device holds nothing. */
  loadError: string | null;
  /** An account write is in flight. */
  pending: boolean;
  /** The device can store the list. */
  storageHealthy: boolean;
}

const EMPTY: Snapshot = {
  accountId: null,
  entries: [],
  accountIds: [],
  accountSavedAts: {},
  accountAnswered: false,
  removed: [],
  settledRemovals: [],
  issues: {},
  loading: false,
  loadError: null,
  pending: false,
  storageHealthy: true,
};

/**
 * The signed-in account id, or null when there is no account (or no auth
 * provider mounted). `useAuth` throws outside an `AuthProvider`; the throw
 * happens after its `useContext` call, so catching it here keeps the hook
 * order stable and turns "no provider" into "no account" instead of a crash.
 */
function useAccountId(): string | null {
  try {
    return useAuth().user?.id ?? null;
  } catch {
    return null;
  }
}

export function SavedReportsProvider({ children }: { children: ReactNode }) {
  const accountId = useAccountId();
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  /**
   * The state of the CURRENT account — the only state that may be read or
   * written. A state that belongs to another account is masked out, so an
   * account switch can never show (or act on) the previous reader's reports.
   */
  const currentRef = useRef<Snapshot>(EMPTY);
  /**
   * Bumped on every account change and on every retry. An async continuation
   * that belongs to an older generation is dropped instead of publishing into
   * the new account.
   */
  const generationRef = useRef(0);
  /**
   * The state the reader MEANT, per report, and the queue of reports whose
   * account state still has to catch up. The device list is written at once;
   * the account is reconciled afterwards, and a tap that lands while a call
   * is in flight is never swallowed — it changes the desired state and the
   * running call corrects itself afterwards.
   */
  const desiredRef = useRef(new Map<string, boolean>());
  const queueRef = useRef<string[]>([]);
  /**
   * The revision of the reader's last action, per report.
   *
   * An account answer that predates the action cannot decide the report's
   * fate: a save or a removal made while the answer was in flight is NEWER
   * than the answer and must survive it.
   *
   * The revision is a COUNTER, not a clock: two actions in the same
   * millisecond are still ordered, which a timestamp cannot promise.
   */
  const localActionRevision = useRef(new Map<string, number>());
  /** The next action revision. Monotonic, so a revision never goes back. */
  const actionRevision = useRef(0);
  /** The generation of the worker that is running, or null when none is. */
  const workerRef = useRef<number | null>(null);
  /** Lets a finished worker hand the queue back to a fresh one. */
  const syncRef = useRef<() => void>(() => {});

  const apply = useCallback((fn: (state: Snapshot) => Snapshot) => {
    const next = fn(currentRef.current);
    currentRef.current = next;
    setSnapshot(next);
  }, []);

  /**
   * What the session currently believes, as the service sees it.
   *
   * The session is NEWER than the disk (a blocked store leaves the disk
   * behind), so every write starts from it — never from the disk — and it
   * carries the settled intents, which the disk may still hold.
   */
  const sessionState = useCallback(
    (): SavedReportSessionState => ({
      entries: currentRef.current.entries,
      removed: currentRef.current.removed,
      settled: currentRef.current.settledRemovals,
    }),
    [],
  );

  /**
   * Ask the account what it holds and reconcile the device list with it.
   *
   * The account answer is authoritative ONLY when it arrived: a list the
   * account confirmed marks the matching device records as synced (and that
   * marking is persisted, so every surface reads the same truth) and adds the
   * reports saved elsewhere; a list that could not be fetched leaves every
   * device record exactly as it was, because "could not ask" is not "the
   * account says no".
   *
   * FOUR things are reconciled here, and all four are re-read at the moment
   * the answer arrives, so a save or a removal that happened WHILE the account
   * was answering always wins over the older answer:
   *   * a removal intent the account still honours → the unsave is queued;
   *   * a removal intent the account has settled (it dropped the report, or it
   *     saved it again AFTER the removal) → the intent goes, in the disk AND
   *     in the session, and no unsave is queued;
   *   * a device record the account does not hold → the save is queued, so a
   *     save made offline reaches the account on a later launch;
   *   * a device record the account holds → it is marked synced.
   *
   * A record the account confirmed BEFORE and does not list any more is a
   * record that was removed on another device: it goes with the account's list
   * and nothing is saved again. That conclusion needs a COMPLETE list — an
   * incomplete one may simply have been truncated, and a truncated list must
   * never be read as a removal.
   */
  const hydrate = useCallback(
    async (account: string, generation: number) => {
      const requestedAt = Date.now();
      // The revision of the world when this answer was asked for: an action
      // made after this moment is NEWER than the answer.
      const requestRevision = actionRevision.current;
      const answer = await fetchSavedReportSnapshot();
      if (generationRef.current !== generation) return;
      if (!answer.ok) {
        apply((state) => ({
          ...state,
          loading: false,
          accountAnswered: false,
          loadError: state.entries.length === 0 ? "Couldn't load your saved reports." : null,
        }));
        return;
      }
      const confirmed = new Set(answer.ids);
      // The removal intents this session knows about — the disk's AND the
      // session's. A tombstone the browser refused to store exists ONLY in the
      // session, and it has to take part in the settlement decision like any
      // other: otherwise a stale intent keeps hiding the report and keeps
      // queueing the unsave for a report the account saved again.
      const raw = readSavedReportState(account, {
        entries: currentRef.current.entries,
        removed: currentRef.current.removed,
      });
      // The local actions the reader made. One that is NEWER than this answer
      // must survive it: an answer that predates the action cannot decide the
      // report's fate.
      const localActions = new Map(localActionRevision.current);
      // The removal intents this answer settles.
      const settledNow = new Set<string>();
      // The settled intents the disk refused to drop. They may not hide the
      // report and may not queue an unsave, even though the tombstone is still
      // on the disk.
      const settledOverride = new Set(currentRef.current.settledRemovals);
      for (const postId of [...settledOverride]) {
        // A settled intent whose tombstone is gone from the disk AND the
        // session needs no override any more.
        if (!raw.removals.some((removal) => removal.postId === postId)) {
          settledOverride.delete(postId);
        }
      }
      // The intents this answer may settle: the union, minus the ones that
      // are already settled.
      const openRemovals = raw.removals.filter(
        (removal) => !settledOverride.has(removal.postId),
      );
      const settleRemoval = (postId: string) => {
        settledNow.add(postId);
        const cleared = clearSavedReportRemoval(account, postId);
        if (!cleared.persisted) {
          // The disk refused the write: the tombstone is still there, and it
          // would keep hiding the report and keep queueing the unsave.
          settledOverride.add(postId);
        }
      };
      for (const removal of openRemovals) {
        // A local action made while this answer was in flight is NEWER than
        // the answer: the answer cannot decide its fate. The revision is a
        // counter, not a clock, so two actions in the same millisecond are
        // still ordered.
        const revision = localActions.get(removal.postId);
        if (revision !== undefined && revision > requestRevision) continue;
        // An intent NEWER than this answer is not settled: that answer
        // predates the removal and must not undo it.
        if (Date.parse(removal.removedAt) > requestedAt) continue;
        if (!confirmed.has(removal.postId)) {
          // The account does not hold the report any more. That proves the
          // removal landed ONLY when the list is the WHOLE list: a partial
          // list may simply have left the report out, so the intent stays and
          // nothing is invented in the account's name.
          if (answer.complete) settleRemoval(removal.postId);
          continue;
        }
        // The account still holds the report. Its stamp says when the account
        // saved it: a stamp NEWER than the removal means the report was saved
        // again after the removal (on another device), so the removal is stale
        // and the account's save is the newer intent. An older stamp — or none
        // at all — means the removal is the newer intent and it stands.
        const accountSavedAt = answer.savedAts[removal.postId];
        const savedAt = accountSavedAt ? Date.parse(accountSavedAt) : Number.NaN;
        if (!Number.isNaN(savedAt) && savedAt > Date.parse(removal.removedAt)) {
          settleRemoval(removal.postId);
        }
      }
      // The merged view: what the disk holds and what the session holds,
      // minus the removals and the settled intents. The session may hold a
      // save the disk refused to store — it stays visible (and labelled)
      // instead of vanishing here.
      const mergeSession: SavedReportSessionState = {
        entries: currentRef.current.entries,
        removed: currentRef.current.removed.filter(
          (removal) => !settledNow.has(removal.postId),
        ),
        settled: [...settledOverride],
      };
      const merged = readSavedReportState(account, mergeSession);
      const removedIds = new Set<string>(merged.removals.map((removal) => removal.postId));
      for (const postId of removedIds) {
        // The account still holds it: the removal has to reach the account.
        if (!confirmed.has(postId)) continue;
        desiredRef.current.set(postId, false);
        queueRef.current.push(postId);
      }
      const entries: SavedReportEntry[] = [];
      /** The records the account dropped on another device: they go with it. */
      const forgotten: string[] = [];
      /** The records the account has never confirmed: the save never landed. */
      const neverSynced: string[] = [];
      /** The records the account's answer could not settle either way. */
      const conflicts: string[] = [];
      for (const entry of merged.entries) {
        if (confirmed.has(entry.postId)) {
          // The account holds it: the record is confirmed.
          if (entry.synced) {
            entries.push(entry);
            continue;
          }
          markSavedReportSynced(account, entry.postId, true, mergeSession);
          entries.push({ ...entry, synced: true });
          continue;
        }
        if (entry.synced) {
          // The account confirmed this save once and does not list it now.
          const revision = localActions.get(entry.postId);
          if (revision !== undefined && revision > requestRevision) {
            // A local action made while this answer was in flight is newer than
            // the answer: the answer cannot decide this record.
            entries.push(entry);
            continue;
          }
          if (!answer.complete) {
            // The account's list may be truncated, so it does NOT prove the
            // report was removed. The record stays, it is not saved again
            // behind the reader's back, and the reader is told that the
            // account did not list it.
            entries.push(entry);
            conflicts.push(entry.postId);
            continue;
          }
          // The account's list is the whole list and it does not hold the
          // report: it was removed on another device. The local record goes
          // with it, and nothing is saved again — a deliberate removal must
          // not be resurrected.
          forgotten.push(entry.postId);
          continue;
        }
        // The account never confirmed this save: it never landed.
        entries.push(entry);
        neverSynced.push(entry.postId);
      }
      if (forgotten.length > 0) {
        // The records the account dropped are dropped here too — WITHOUT a
        // removal intent: there is nothing left to unsave.
        forgetSavedReports(account, forgotten, mergeSession);
      }
      for (const postId of neverSynced) {
        desiredRef.current.set(postId, true);
        queueRef.current.push(postId);
      }
      apply((state) => {
        // A settled removal intent is done: the account has dealt with it, so
        // it may not keep claiming that the report is out of sync.
        let issues = withoutIssues(withoutIssues(state.issues, forgotten), [...settledNow]);
        // A report the account lists again settles the conflict: it is not a
        // conflict any more.
        for (const entry of entries) {
          if (!confirmed.has(entry.postId)) continue;
          const issue = issues[entry.postId];
          if (!issue?.accountFailed) continue;
          // The ACCOUNT half of a save is settled for EVERY record the
          // account confirms, whatever the intent was. A save that timed out
          // AFTER the server had already taken it leaves a stale "account
          // failed" note behind, and the row would then claim "on this device
          // only" for a report the account holds — contradicting the footer.
          //
          // An unsave intent is NOT settled by the account holding the report:
          // that is precisely the failure ("removed here, still on your
          // account"). Such records are not listed at all, so the two cases
          // cannot collide in practice.
          if (issue.intent === "unsave") continue;
          issues = withIssue(issues, entry.postId, issue.intent === "conflict" ? "save" : issue.intent, {
            accountFailed: false,
          });
        }
        if (conflicts.length > 0) issues = withConflicts(issues, conflicts);
        return {
          ...state,
          entries,
          accountIds: answer.ids,
          accountSavedAts: answer.savedAts,
          accountAnswered: true,
          removed: merged.removals,
          settledRemovals: [...settledOverride],
          issues,
          loading: false,
          loadError: null,
        };
      });
      void syncRef.current();
    },
    [apply],
  );

  /**
   * Load the device list, then ask the account what it holds.
   *
   * A new account starts from a clean slate: no intent, no queue, no worker.
   * The previous account's in-flight call keeps running (it was issued under
   * the previous credentials) but its answer is dropped.
   */
  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    desiredRef.current = new Map();
    queueRef.current = [];
    localActionRevision.current = new Map();
    actionRevision.current = 0;
    workerRef.current = null;

    const account = accountId;
    if (!account) {
      apply(() => ({ ...EMPTY, accountId: null }));
      return;
    }
    const previous = currentRef.current;
    const sameAccount = previous.accountId === account;
    const stored = readSavedReportState(account);
    apply(() => ({
      ...EMPTY,
      accountId: account,
      entries: stored.entries,
      removed: stored.removals,
      loading: true,
      issues: sameAccount ? previous.issues : {},
    }));
    void hydrate(account, generation);
  }, [accountId, apply, hydrate]);

  /**
   * Bring the ACCOUNT in line with what the reader wants, one report at a
   * time.
   *
   * The queue holds the reports whose account state is behind; the desired
   * state says what it should be. A call that answers after the reader changed
   * their mind does not win: the report goes back on the queue and the next
   * call corrects it. A call that FAILS is reported against THAT report and
   * leaves the device list exactly as it is — the device is the truth.
   */
  const syncAccount = useCallback(async () => {
    const account = accountId;
    if (!account) return;
    const generation = generationRef.current;
    if (workerRef.current === generation) return;
    workerRef.current = generation;
    apply((state) => ({ ...state, pending: true }));
    try {
      while (queueRef.current.length > 0) {
        const postId = queueRef.current.shift()!;
        const want = desiredRef.current.get(postId);
        if (want === undefined) continue;
        const ok = want
          ? await saveReportOnServer(postId)
          : await unsaveReportOnServer(postId);
        // The account changed while the call was in flight: the answer belongs
        // to the previous account and must not touch the current one.
        if (generationRef.current !== generation) return;
        if (!ok) {
          apply((state) => ({
            ...state,
            issues: withIssue(state.issues, postId, want ? "save" : "unsave", {
              accountFailed: true,
            }),
          }));
          continue;
        }
        // The reader may have changed their mind while the call was in flight.
        const now = desiredRef.current.get(postId);
        const stillWanted = now === want;
        // This report's own ACCOUNT operation is resolved. A storage failure is
        // a different half of the story and stays until the device can store it.
        apply((state) => ({
          ...state,
          issues: withIssue(state.issues, postId, want ? "save" : "unsave", {
            accountFailed: false,
          }),
        }));
        // The account acknowledged the operation: the acknowledged account
        // snapshot follows it, so the surfaces can say "saved to your
        // account" without asking the account again.
        //
        // The snapshot is a FACT about the account, so it is recorded even
        // when the reader has already changed their mind — the account
        // really does hold (or not hold) the report. What follows the
        // reader's CURRENT intent is the saved state: a superseded
        // acknowledgement never marks a report as saved, and the correction
        // that is already queued stays queued.
        const at = new Date().toISOString();
        // The flag is written down from the SESSION's list, so a store that
        // refused an earlier write still receives the whole list when it
        // recovers — not just the report this acknowledgement is about.
        if (want) markSavedReportSynced(account, postId, true, sessionState());
        apply((state) => {
          const savedAts = { ...state.accountSavedAts };
          if (!want) delete savedAts[postId];
          return {
            ...state,
            accountAnswered: true,
            entries:
              want && stillWanted
                ? state.entries.map((entry) =>
                    entry.postId === postId ? { ...entry, synced: true } : entry,
                  )
                : state.entries,
            accountIds: want
              ? state.accountIds.includes(postId)
                ? state.accountIds
                : [...state.accountIds, postId]
              : state.accountIds.filter((id) => id !== postId),
            accountSavedAts: want ? { ...savedAts, [postId]: at } : savedAts,
          };
        });
        if (now !== undefined && now !== want) queueRef.current.push(postId);
      }
    } finally {
      if (generationRef.current === generation) {
        workerRef.current = null;
        apply((state) => ({ ...state, pending: false }));
        // A tap that arrived in the last moment must not be stranded.
        if (queueRef.current.length > 0) void syncRef.current();
      }
    }
  }, [accountId, apply, sessionState]);
  syncRef.current = () => {
    void syncAccount();
  };

  /**
   * Save one report.
   *
   * The DEVICE write happens first and is never rolled back: the tap shows
   * its result immediately and offline. The ACCOUNT write follows in the
   * background; when it answers, the record is marked synced, and when it does
   * not, the surface says so in plain language instead of pretending the save
   * reached the account.
   */
  const save = useCallback(
    async (postId: string, title?: string): Promise<boolean> => {
      const account = accountId;
      if (!account || !postId) return false;
      const session = sessionState();
      const known = session.entries.find((entry) => entry.postId === postId);
      // The write starts from the SESSION's list, so a store that refused an
      // earlier write cannot make this save drop the other saves the reader
      // can still see.
      const result = saveReportToDevice(
        account,
        { postId, title: title ?? known?.title ?? "" },
        session,
      );
      desiredRef.current.set(postId, true);
      // The reader acted now: an account answer that predates this moment
      // cannot decide this report's fate.
      actionRevision.current += 1;
      localActionRevision.current.set(postId, actionRevision.current);
      apply((state) => ({
        ...state,
        entries: result.entries,
        // Saving again cancels a removal intent: the reader wants this saved.
        removed: result.removals,
        storageHealthy: result.persisted,
        issues: withIssue(state.issues, postId, "save", { storageFailed: !result.persisted }),
      }));
      queueRef.current.push(postId);
      void syncRef.current();
      return true;
    },
    [accountId, apply, sessionState],
  );

  /**
   * Remove one report — an EXPLICIT removal, never a toggle.
   *
   * The report leaves the device list and a removal intent is recorded, so the
   * account copy is cleaned up later instead of bringing the save back. The
   * account is asked to drop it right away; when it cannot be reached, the
   * reader is told the account still has it.
   */
  const remove = useCallback(
    async (postId: string): Promise<boolean> => {
      const account = accountId;
      if (!account || !postId) return false;
      // Like the save, the removal starts from the SESSION's list: the other
      // saves the reader can still see must survive it.
      const result = removeReportFromDevice(account, postId, sessionState());
      desiredRef.current.set(postId, false);
      // The reader acted now: an account answer that predates this moment
      // cannot settle this removal.
      actionRevision.current += 1;
      localActionRevision.current.set(postId, actionRevision.current);
      apply((state) => ({
        ...state,
        entries: result.entries,
        accountIds: state.accountIds.filter((id) => id !== postId),
        removed: result.removals,
        storageHealthy: result.persisted,
        issues: withIssue(state.issues, postId, "unsave", { storageFailed: !result.persisted }),
      }));
      queueRef.current.push(postId);
      void syncRef.current();
      return true;
    },
    [accountId, apply],
  );

  const isSaved = useCallback((postId: string): boolean => {
    if (!postId) return false;
    const state = currentRef.current;
    if (state.removed.some((removal) => removal.postId === postId)) return false;
    return (
      state.entries.some((entry) => entry.postId === postId) ||
      state.accountIds.includes(postId)
    );
  }, []);

  /**
   * Save/unsave one report, for a control that only offers one affordance.
   *
   * The direction comes from the CURRENT state — device list ∪ account list,
   * minus the reports the reader removed — so a report the account holds but
   * this device does not still reads as saved.
   */
  const toggle = useCallback(
    async (postId: string, title?: string): Promise<boolean> => {
      if (!accountId || !postId) return false;
      return isSaved(postId) ? remove(postId) : save(postId, title);
    },
    [accountId, isSaved, remove, save],
  );

  /**
   * Ask the account again — the reader's way out of an unreachable account.
   *
   * The session's list is kept as it is: a retry must not drop the saves the
   * reader can see, whether they reached the disk or not.
   */
  const retry = useCallback(() => {
    const account = accountId;
    if (!account) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    desiredRef.current = new Map();
    queueRef.current = [];
    workerRef.current = null;
    apply((state) => ({
      ...state,
      accountId: account,
      loading: true,
      loadError: null,
    }));
    void hydrate(account, generation);
  }, [accountId, apply, hydrate]);

  /**
   * The state of the CURRENT account. A state that belongs to another account
   * is masked out, so the previous reader's reports are never shown, never
   * read and never counted. The masked state keeps the account it came from,
   * so the effect can still tell "same account" from "account changed".
   */
  const visible = useMemo<Snapshot>(
    () =>
      snapshot.accountId === accountId
        ? snapshot
        : { ...EMPTY, accountId: snapshot.accountId, loading: Boolean(accountId) },
    [snapshot, accountId],
  );
  currentRef.current = visible;

  /** The rows the surfaces render: one per saved report, newest first. */
  const rows = useMemo<SavedReportRow[]>(() => {
    const byId = new Map<string, SavedReportEntry>(
      visible.entries.map((entry) => [entry.postId, entry]),
    );
    const removed = new Set(visible.removed.map((removal) => removal.postId));
    const ids = [
      ...new Set([...visible.entries.map((entry) => entry.postId), ...visible.accountIds]),
    ].filter((id) => !removed.has(id));
    return ids
      .map((id) => {
        const entry = byId.get(id);
        const onAccount = visible.accountIds.includes(id);
        return {
          id,
          title: entry?.title ?? "",
          savedAt: entry?.savedAt ?? visible.accountSavedAts[id] ?? null,
          onDevice: Boolean(entry),
          onAccount,
          synced: entry ? entry.synced : onAccount,
          issue: visible.issues[id] ?? null,
        };
      })
      .sort((a, b) => (b.savedAt ?? "").localeCompare(a.savedAt ?? ""));
  }, [visible]);

  const savedIds = useMemo(() => rows.map((row) => row.id), [rows]);

  const syncedToAccount = useMemo(
    () => rows.length > 0 && rows.every((row) => row.synced),
    [rows],
  );

  /**
   * The plain-language reason something did not land.
   *
   * The reasons are per REPORT, so a failed save is not erased by the next
   * unrelated success: it stays until THAT report is resolved.
   */
  const error = useMemo(() => {
    const issues = Object.entries(visible.issues);
    if (issues.length === 0) return null;
    if (issues.length === 1) {
      const [postId, issue] = issues[0]!;
      return issueMessage(issue, postId, visible.accountIds);
    }
    return "Some of your saved reports could not be updated on your account.";
  }, [visible.issues, visible.accountIds]);

  const value = useMemo<SavedReportsApi>(
    () => ({
      rows,
      savedIds,
      isSaved,
      save,
      remove,
      toggle,
      pending: visible.pending,
      error,
      errorByPostId: visible.issues,
      syncedToAccount,
      loading: visible.loading,
      loadError: visible.loadError,
      accountAnswered: visible.accountAnswered,
      storageHealthy: visible.storageHealthy,
      hasAccount: Boolean(accountId),
      retry,
    }),
    [
      rows,
      savedIds,
      isSaved,
      save,
      remove,
      toggle,
      visible.pending,
      visible.issues,
      error,
      syncedToAccount,
      visible.loading,
      visible.loadError,
      visible.accountAnswered,
      visible.storageHealthy,
      accountId,
      retry,
    ],
  );

  return (
    <SavedReportsContext.Provider value={value}>{children}</SavedReportsContext.Provider>
  );
}

/**
 * The provider's API, or null when no provider is mounted.
 *
 * Use this when a surface needs to know whether it may act on the account
 * (a surface that owns nothing of its own).
 */
export function useSavedReportsState(): SavedReportsApi | null {
  return useContext(SavedReportsContext);
}

/** The saved-reports API. Inert (never throwing) outside a provider. */
export function useSavedReports(): SavedReportsApi {
  return useContext(SavedReportsContext) ?? INERT;
}
