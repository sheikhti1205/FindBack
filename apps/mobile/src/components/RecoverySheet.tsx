import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { PostItem, SearchedProfile } from "@findback/shared";
import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";
import { TextField } from "./Fields";
import { UserAvatar } from "./UserAvatar";
import { PreferenceRadioRow } from "./settings";
import { announce } from "./LiveRegion";
import { useAuth } from "../auth";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { friendlyError } from "../utils/friendlyErrors";
import { searchProfilesByPrefix } from "../services/profile";
import { invalidateFeedCaches } from "../hooks/feedCache";
import {
  RECOVERY_HELPER_KINDS,
  RECOVERY_HELPER_KIND_LABELS,
  markRecovered,
  type RecoveryHelperKind,
} from "../services/trust";

/** The shortest prefix the canonical profile search accepts. */
const MIN_HELPER_QUERY = 2;
const SEARCH_DEBOUNCE_MS = 250;

export interface RecoverySheetProps {
  open: boolean;
  onClose: () => void;
  /** The lost report being marked recovered. Null while the sheet is closed. */
  post: PostItem | null;
  /**
   * The parent's viewed route/account boundary. A change invalidates every
   * in-flight search and confirmation even when the report id is reused for
   * in-place navigation.
   */
  scopeKey?: string;
  /** Called once the server confirmed the recovery row. */
  onRecovered?: (returnId: string, post: PostItem) => void;
  /** Route to the canonical returns surface (rating when eligible). */
  onRate?: () => void;
}

/**
 * ONE recovery sheet for a lost report.
 *
 * The recovery relationship is the durable fact (MC D25), so the owner is
 * asked who returned the item before anything is written: another FindBack
 * account, somebody outside the app, or the owner themselves. The server owns
 * the rules — only the report owner, only a LOST report, one recovery per
 * report — and the client mirrors only the choices that need no round trip.
 *
 * The status change is NOT sent separately. `findback_mark_recovered` writes
 * the recovery row and moves the report to RECOVERED in one transaction, so a
 * success here is the only moment the caller may patch the row. A refusal
 * keeps the form and the answer on screen.
 */
export function RecoverySheet({
  open,
  onClose,
  post,
  scopeKey,
  onRecovered,
  onRate,
}: RecoverySheetProps) {
  const { user } = useAuth();
  const alive = useSafetyLifetime();
  const generation = useRef(0);
  const searchSeq = useRef(0);
  const groupName = useId();

  const [helperKind, setHelperKind] = useState<RecoveryHelperKind | "">("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchedProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** The query whose completed response produced the current result list. */
  const [completedQuery, setCompletedQuery] = useState<string | null>(null);
  const [helper, setHelper] = useState<SearchedProfile | null>(null);
  const [sending, setSending] = useState(false);
  /** The immutable choice this request submitted, not later draft state. */
  const [submittedKind, setSubmittedKind] = useState<RecoveryHelperKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  // A committed account/report/open boundary invalidates every in-flight
  // search and confirmation before paint. The sheet stays mounted so its exit
  // motion is preserved; only stale answers are discarded. The scope key is
  // what the parent actually views, so an in-place route replacement or a
  // same-id type/owner replacement is a real boundary here too.
  useLayoutEffect(() => {
    generation.current += 1;
    if (open) {
      setHelperKind("");
      setQuery("");
      setResults([]);
      setSearching(false);
      setSearchError(null);
      setCompletedQuery(null);
      setHelper(null);
      setSending(false);
      setSubmittedKind(null);
      setError(null);
      setReceipt(null);
    }
    return () => {
      generation.current += 1;
    };
  }, [open, scopeKey, post?.id, post?.type, post?.userId, user?.id]);

  // Search only for the one helper kind that names an account. Each run owns
  // its own latest-request token: an older query (or a cleared query, or a
  // helper-kind switch) can never publish results, errors or a loading state
  // over the current search.
  useEffect(() => {
    const seq = ++searchSeq.current;
    if (!open || helperKind !== "FINDBACK_USER" || receipt) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      setCompletedQuery(null);
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < MIN_HELPER_QUERY) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      setCompletedQuery(null);
      return;
    }
    // A valid prefix is already a pending search during the debounce. Saying
    // "No matching accounts" before the request exists would be a false
    // negative.
    setSearching(true);
    setSearchError(null);
    setCompletedQuery(null);
    const timer = window.setTimeout(() => {
      if (!alive.current || searchSeq.current !== seq) return;
      void searchProfilesByPrefix(trimmed)
        .then((profiles) => {
          if (!alive.current || searchSeq.current !== seq) return;
          // Never offer the owner's own account as a FindBack helper: that is
          // a self-recovery, and the server refuses it.
          setResults(profiles.filter((profile) => profile.id !== user?.id));
          setCompletedQuery(trimmed);
        })
        .catch((err: unknown) => {
          if (!alive.current || searchSeq.current !== seq) return;
          setResults([]);
          setCompletedQuery(null);
          setSearchError(friendlyError(err).message);
        })
        .finally(() => {
          if (!alive.current || searchSeq.current !== seq) return;
          setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      if (searchSeq.current === seq) searchSeq.current += 1;
    };
  }, [open, helperKind, query, receipt, user?.id, alive]);

  if (!post) return null;
  const targetPost = post;
  const isLost = targetPost.type === "LOST";
  const isOwner = targetPost.userId === user?.id;
  const eligibilityRefusal = !isLost
    ? "Only a lost-item report can be marked recovered."
    : !isOwner
      ? "Only the owner of a report can mark it recovered."
      : null;

  if (eligibilityRefusal) {
    return (
      <BottomSheet
        open={open}
        onClose={onClose}
        title="Mark recovered"
        height="medium"
      >
        <div className="flex flex-col gap-3 py-2">
          <p role="alert" data-testid="recovery-error" className="text-sm text-error">
            {eligibilityRefusal}
          </p>
          <Button variant="outline" onClick={onClose} className="self-start">
            Close
          </Button>
        </div>
      </BottomSheet>
    );
  }

  const needsHelper = helperKind === "FINDBACK_USER";
  const canSend =
    helperKind !== "" && (!needsHelper || helper !== null) && !sending && receipt === null;
  // The receipt describes the submitted relationship. Later radio edits must
  // never turn an outside/private return into a promise to rate.
  const canRate = submittedKind === "FINDBACK_USER";

  async function send(): Promise<void> {
    if (sending || receipt) return;
    if (helperKind === "") {
      setError("Choose who returned the item.");
      announce("Choose who returned the item.");
      return;
    }
    if (needsHelper && !helper) {
      setError("Choose the FindBack account that returned it.");
      announce("Choose the FindBack account that returned it.");
      return;
    }
    const requestGeneration = generation.current;
    const isCurrent = () => alive.current && generation.current === requestGeneration;
    setSubmittedKind(helperKind);
    setSending(true);
    setError(null);
    try {
      const returnId = await markRecovered({
        postId: targetPost.id,
        helperKind,
        helperUserId: needsHelper ? helper?.id ?? null : null,
      });
      // A confirmed write is a fact even if this dialog was dismissed while it
      // was in flight. Reconcile the cache unconditionally; the UI callbacks
      // and announcement stay scoped to the still-current sheet.
      invalidateFeedCaches();
      if (!isCurrent()) return;
      setReceipt(returnId);
      announce("Recovery saved.");
      onRecovered?.(returnId, targetPost);
    } catch (err) {
      if (!isCurrent()) return;
      const message = recoveryFailure(err);
      setError(message);
      announce(message);
    } finally {
      if (isCurrent()) setSending(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Mark recovered"
      description={`Tell us who returned “${targetPost.title}”.`}
      height="large"
    >
      {receipt ? (
        <div className="flex flex-col gap-3 py-2" data-testid="recovery-receipt">
          <p role="status" className="text-base font-semibold text-on-surface">
            Recovery saved.
          </p>
          <p className="text-sm text-on-surface-variant">
            The report has left the open search. The recovery is kept in Settings → Returns
            {canRate ? ", where you can rate the return." : "."}
          </p>
          <div className="flex flex-wrap gap-2">
            {onRate ? (
              <Button variant="outline" onClick={onRate}>
                {canRate ? "Rate the return" : "View returns"}
              </Button>
            ) : null}
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 py-2">
          <fieldset className="fb-choice-fieldset flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-on-surface">Who returned it?</legend>
            <div className="fb-choice-list flex flex-col">
              {RECOVERY_HELPER_KINDS.map((value) => (
                <PreferenceRadioRow
                  key={value}
                  name={groupName}
                  value={value}
                  title={RECOVERY_HELPER_KIND_LABELS[value]}
                  description={
                    value === "FINDBACK_USER"
                      ? "Name the account that returned it."
                      : value === "OUTSIDE"
                        ? "They do not need a FindBack account."
                        : "No other person is named."
                  }
                  checked={helperKind === value}
                  disabled={sending}
                  onChange={() => {
                    setHelperKind(value);
                    setHelper(null);
                    setQuery("");
                    setResults([]);
                    setSearchError(null);
                    setCompletedQuery(null);
                    setError(null);
                  }}
                />
              ))}
            </div>
          </fieldset>

          {needsHelper ? (
            <div className="flex flex-col gap-2">
              <TextField
                label="Find the account"
                hint="Search by username or name."
                value={query}
                autoComplete="off"
                disabled={sending}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHelper(null);
                  setResults([]);
                  setSearchError(null);
                  setCompletedQuery(null);
                }}
              />
              {helper ? (
                <div
                  className="flex min-h-[44px] items-center gap-2 rounded-m3-sm bg-surface-variant px-3 py-2"
                  data-testid="recovery-helper-selected"
                >
                  <UserAvatar avatarUrl={helper.avatarUrl} username={helper.username} size={28} />
                  <span className="min-w-0 flex-1 break-all text-sm text-on-surface">
                    {helper.displayName || helper.username}
                    <span className="text-on-surface-variant"> @{helper.username}</span>
                  </span>
                </div>
              ) : null}
              {searchError ? (
                <p role="alert" className="text-sm text-error">
                  {searchError}
                </p>
              ) : null}
              {!helper && results.length > 0 ? (
                <ul className="flex max-h-56 flex-col overflow-y-auto" aria-label="Matching accounts">
                  {results.map((profile) => (
                    <li key={profile.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setHelper(profile);
                          setError(null);
                        }}
                        className="flex min-h-[44px] w-full items-center gap-2 rounded-m3-sm px-2 text-left hover:bg-surface-variant"
                      >
                        <UserAvatar avatarUrl={profile.avatarUrl} username={profile.username} size={28} />
                        <span className="min-w-0 flex-1 break-all text-sm text-on-surface">
                          {profile.displayName || profile.username}
                          <span className="text-on-surface-variant"> @{profile.username}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {!helper &&
              !searching &&
              !searchError &&
              completedQuery === query.trim() &&
              query.trim().length >= MIN_HELPER_QUERY &&
              results.length === 0 ? (
                <p className="text-sm text-on-surface-variant" role="status">
                  No matching accounts.
                </p>
              ) : null}
              {!helper && searching ? (
                <p className="text-sm text-on-surface-variant" role="status">
                  Searching…
                </p>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p role="alert" data-testid="recovery-error" className="text-sm text-error">
              {error}
            </p>
          ) : null}

          <Button onClick={() => void send()} loading={sending} disabled={!canSend}>
            Mark recovered
          </Button>
        </div>
      )}
    </BottomSheet>
  );
}

/**
 * The server's refusal, in a sentence a reader can act on. The server owns the
 * rule; the client only phrases the known answers and falls back to the shared
 * taxonomy for everything else.
 */
function recoveryFailure(err: unknown): string {
  const code = err instanceof Error && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const raw = err instanceof Error ? err.message : "";
  if (code === "23505") return "This report has already been marked recovered.";
  if (code === "42501") return "Only the owner of a report can mark it recovered.";
  if (code === "22023") {
    if (/unknown helper kind/i.test(raw)) return "Choose who returned the item again.";
    if (/lost-item/i.test(raw)) return "Only a lost-item report can be marked recovered.";
    if (/another account|self-recovery/i.test(raw)) return "Choose another account, or mark it as found yourself.";
    if (/helper/i.test(raw)) return "Choose the FindBack account that returned it.";
    return "That recovery could not be saved. Check the details and try again.";
  }
  if (code === "P0002") {
    if (/helper/i.test(raw)) return "That account is no longer available. Choose another account.";
    if (/report/i.test(raw)) return "That report is no longer available.";
    return "That recovery is no longer available.";
  }
  return friendlyError(err).message;
}
