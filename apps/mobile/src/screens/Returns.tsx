import { useCallback, useEffect, useState } from "react";
import { SettingsGroup, SettingsPage, StatusPill } from "../components/settings";
import { announce } from "../components/LiveRegion";
import { useAuth } from "../auth";
import { fetchPost } from "../services/posts";
import { fetchAccountLabels } from "../services/accountLabels";
import {
  canRateReturn,
  fetchReputationTier,
  fetchStanding,
  isTrustUnavailable,
  listMyRecoveries,
  rateReturn,
  type MyRecovery,
  type ReputationTier,
  type Standing,
} from "../services/trust";
import { ApiError } from "../services/session";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";
import { isMissingServerFunction } from "../utils/safetyService";
import { friendlyError } from "../utils/friendlyErrors";
import {
  RATING_REFUSAL_SENTENCES,
  REPUTATION_TIER_SENTENCES,
  STANDING_SENTENCES,
  formatSafetyDate,
} from "../utils/safetyCopy";

/** What a reader can say about one recovery. */
interface RecoveryView {
  row: MyRecovery;
  /** The recovered report's title, when it can still be read. */
  title: string | null;
  /** The other participant's name, when the account still has one. */
  counterpartName: string | null;
  /** True when the reader is the person who lost the item. */
  readerIsOwner: boolean | null;
}

/**
 * What the server refused, in words.
 *
 * The server owns the reason; the client owns the sentence. A refusal the
 * rating call already knows how to phrase is phrased here (looked up by
 * code), so no raw database text can ever reach the screen. Anything else
 * falls back to the shared error taxonomy, which is deliberately vague.
 */
function refusalSentence(err: unknown): string {
  if (err instanceof ApiError && err.code) {
    const known = RATING_REFUSAL_SENTENCES[err.code];
    if (known) return known;
  }
  return friendlyError(err).message;
}

/**
 * Recovered items, thanks and standing.
 *
 * THREE THINGS, IN ONE PLACE.
 *
 *   * THE SUMMARY. A recovery is a durable ROW, not a status: the report
 *     leaving the open search says the report closed, while this row says
 *     who returned it (MC D25). The reader sees the report, the date, and
 *     whether they were the one who got their item back or the one who
 *     helped.
 *
 *   * THE RATING, ELIGIBILITY-BACKED. A rating is written only by a
 *     participant in the recovery relationship, once per direction, and
 *     never about yourself (MC D26). The client never decides who may be
 *     rated — the server derives the other participant (the function has no
 *     rated-user parameter) and refuses a non-participant, a second rating
 *     in the same direction and a self rating. The control is offered only
 *     when the server's own row says there is a counterpart and the reader
 *     has not rated yet; the server still has the last word, and its refusal
 *     is shown as a sentence.
 *
 *   * THE REPUTATION AND THE STANDING. Reputation is DERIVED — a label
 *     computed at call time from the ratings a member received and their
 *     active sanction, never a stored score and never a number (MC D28).
 *     Standing is shown to its subject only; the server refuses to describe
 *     anybody else, so this screen only ever asks about the reader.
 *
 * THE SERVICE IS THE CANONICAL ONE. `services/trust.ts` is owned by the
 * trust-client lane; this screen reads it and adds no second trust service
 * of its own.
 */
export function Returns() {
  const { user } = useAuth();
  return user ? <ScopedReturns key={user.id} userId={user.id} /> : null;
}

function ScopedReturns({ userId }: { userId: string }) {
  const alive = useSafetyLifetime();
  const [views, setViews] = useState<RecoveryView[] | null>(null);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [tier, setTier] = useState<ReputationTier | null>(null);
  const [trustUnavailable, setTrustUnavailable] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [standingError, setStandingError] = useState<string | null>(null);
  const [tierError, setTierError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListError(null);
    setTrustUnavailable(null);
    setViews(null);
    let rows: MyRecovery[];
    try {
      rows = await listMyRecoveries();
    } catch (err) {
      if (!alive.current) return;
      if (isTrustUnavailable(err) || isMissingServerFunction(err)) {
        setTrustUnavailable(
          "Recovered items are not available in this build yet — the server does not have the recovery records yet.",
        );
        return;
      }
      setListError(friendlyError(err).message);
      return;
    }

    if (!alive.current) return;
    const names = await fetchAccountLabels(
      rows.map((row) => row.counterpartUserId).filter((id): id is string => id !== null),
    ).catch(() => new Map<string, string>());
    if (!alive.current) return;

    const loaded = await Promise.all(
      rows.map(async (row): Promise<RecoveryView> => {
        let title: string | null = null;
        let readerIsOwner: boolean | null = null;
        try {
          const post = await fetchPost(row.lostPostId);
          title = post.title;
          readerIsOwner = userId ? post.userId === userId : null;
        } catch {
          // The report may be gone. The recovery still happened, so the row
          // stays — it just has no title to show.
          title = null;
        }
        return {
          row,
          title,
          counterpartName: row.counterpartUserId ? (names.get(row.counterpartUserId) ?? null) : null,
          readerIsOwner,
        };
      }),
    );
    if (alive.current) setViews(loaded);
  }, [userId, alive]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadStanding = useCallback(async () => {
    setStandingError(null); setStanding(null);
    try {
      const value = await fetchStanding();
      if (alive.current) setStanding(value);
    } catch (err) {
      if (alive.current) setStandingError(isMissingServerFunction(err)
        ? "Your standing is not available in this build yet." : friendlyError(err).message);
    }
  }, [alive]);
  const loadTier = useCallback(async () => {
    setTierError(null); setTier(null);
    try {
      const value = await fetchReputationTier(userId);
      if (alive.current) setTier(value);
    } catch (err) {
      if (alive.current) setTierError(isMissingServerFunction(err)
        ? "Your reputation is not available in this build yet." : friendlyError(err).message);
    }
  }, [alive, userId]);
  useEffect(() => { void loadStanding(); void loadTier(); }, [loadStanding, loadTier]);

  const rate = async (view: RecoveryView, value: number): Promise<void> => {
    if (busy) return;
    setBusy(view.row.returnId);
    setError(null);
    setNotice(null);
    try {
      await rateReturn({
        returnId: view.row.returnId,
        score: value,
        recovery: view.row,
        selfUserId: userId,
      });
      if (!alive.current) return;
      const outcome = "Thanks — your rating was saved.";
      setNotice(outcome);
      announce(outcome);
      await load();
    } catch (err) {
      if (!alive.current) return;
      const sentence = isMissingServerFunction(err)
        ? "Rating recovered items is not available in this build yet." : refusalSentence(err);
      setError(sentence);
      announce(sentence);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  return (
    <SettingsPage
      title="Recovered items"
      backTo="/settings"
      description="The items that came back, and what happened next."
    >
      <SettingsGroup
        title="Your standing"
        description="Your standing and reputation are worked out from your activity — they are not a score you can raise directly."
      >
        {standingError && <div role="alert" data-testid="standing-error"><p>{standingError}</p>
          <button type="button" className="min-h-[44px] px-3" onClick={() => void loadStanding()}>Retry standing</button></div>}
        {!standing && !standingError && <p role="status">Loading your standing…</p>}
        {standing ? (
          <p data-testid="returns-standing" className="fb-settings-row-description">
            {STANDING_SENTENCES[standing]}
          </p>
        ) : null}
        {tierError && <div role="alert" data-testid="reputation-error"><p>{tierError}</p>
          <button type="button" className="min-h-[44px] px-3" onClick={() => void loadTier()}>Retry reputation</button></div>}
        {!tier && !tierError && <p role="status">Loading your reputation…</p>}
        {tier ? (
          <p data-testid="returns-tier" className="fb-settings-row-description">
            {REPUTATION_TIER_SENTENCES[tier]}
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Recovered items">
        {trustUnavailable && <p role="status" data-testid="returns-unavailable">{trustUnavailable}</p>}
        {listError && <p role="alert" data-testid="returns-list-error">{listError}</p>}
        {(listError || trustUnavailable) && <button type="button" className="min-h-[44px] px-3" onClick={() => void load()}>Retry recovered items</button>}
        {notice ? (
          <p role="status" data-testid="returns-notice" className="px-3 py-2 text-sm text-on-surface-variant">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" data-testid="returns-error" className="px-3 py-2 text-sm text-error">
            {error}
          </p>
        ) : null}

        {!listError && !trustUnavailable && views === null ? (
          <p role="status" className="fb-settings-row-description">
            Loading your recovered items…
          </p>
        ) : null}
        {views !== null && views.length === 0 ? (
          <p className="fb-settings-row-description">Nothing has been recovered yet.</p>
        ) : null}

        {views?.map((view) => {
          const { row } = view;
          const counterpart = view.counterpartName ?? (row.externalHelper ? "someone outside FindBack" : "another member");
          const canRate = canRateReturn(row);
          return (
            <div key={row.returnId} className="fb-settings-row" data-testid="returns-row">
              <span className="fb-settings-row-copy">
                <span className="fb-settings-row-title">{view.title ?? "A report you took part in recovering"}</span>
                <span className="fb-settings-row-description">
                  {view.readerIsOwner === true
                    ? "Your item came back"
                    : view.readerIsOwner === false
                      ? "You helped an item come back"
                      : "You took part in a recovery"}{" "}
                  · recovered {formatSafetyDate(row.recoveredAt)} · with {counterpart}
                </span>
              </span>
              <span className="fb-settings-row-value">
                {row.myRating !== null ? (
                  <StatusPill tone="success">You rated {row.myRating} of 5</StatusPill>
                ) : canRate ? (
                  <RatingButtons
                    name={view.counterpartName ?? "this member"}
                    busy={busy !== null}
                    onRate={(value) => void rate(view, value)}
                  />
                ) : (
                  <StatusPill tone="neutral">Nothing to rate</StatusPill>
                )}
              </span>
              {row.counterpartRating !== null ? (
                <span className="fb-settings-row-description">They rated you {row.counterpartRating} of 5.</span>
              ) : null}
            </div>
          );
        })}
      </SettingsGroup>
    </SettingsPage>
  );
}

/**
 * The five-point rating control.
 *
 * Five real buttons, each with its own accessible name ("Rate Sam 4 out of
 * 5"), so a screen reader is not told "button 3" — and each at least 44dp.
 * The stars are decoration; the number is the label.
 */
function RatingButtons({
  name,
  busy,
  onRate,
}: {
  name: string;
  busy: boolean;
  onRate: (value: number) => void;
}) {
  return (
    <span className="flex items-center gap-1" role="group" aria-label={`Rate ${name}`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <button
          key={value}
          type="button"
          disabled={busy}
          onClick={() => onRate(value)}
          aria-label={`Rate ${name} ${value} out of 5`}
          data-testid={`rate-${value}`}
          className="min-h-[44px] min-w-[44px] rounded-m3-sm border border-outline text-sm font-semibold text-on-surface hover:bg-surface-container disabled:opacity-50"
        >
          {value}
        </button>
      ))}
    </span>
  );
}
