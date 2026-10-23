import { useCallback, useEffect, useState } from "react";
import { SettingsGroup, SettingsPage, SettingsRow } from "../components/settings";
import { announce } from "../components/LiveRegion";
import { listMyBlocks, unblockUser, type BlockedUser } from "../services/blocks";
import { fetchAccountLabels } from "../services/accountLabels";
import { friendlyError } from "../utils/friendlyErrors";
import { UNAVAILABLE_SENTENCES, formatSafetyDate } from "../utils/safetyCopy";
import { isMissingServerFunction } from "../utils/safetyService";
import { useAuth } from "../auth";
import { useSafetyLifetime } from "../utils/useSafetyLifetime";

/**
 * The accounts you have blocked.
 *
 * A block is a private act: the other person is not told, and no screen —
 * this one included — ever says who blocked whom or in which direction. What
 * this screen shows is the caller's OWN outgoing blocks, which is the only
 * direction the server can read at all (MC D18).
 *
 * THE EFFECT IS MUTUAL, and the unblock copy says so exactly. Unblocking
 * clears the caller's own direction only; if the other person has blocked
 * them, the pair stays hidden, and the screen says that in words instead of
 * pretending the pair is back (MC D22).
 */
export function BlockedUsers() {
  const { user } = useAuth();
  return user ? <ScopedBlockedUsers key={user.id} /> : null;
}

function ScopedBlockedUsers() {
  const alive = useSafetyLifetime();
  const [rows, setRows] = useState<BlockedUser[] | null>(null);
  const [labels, setLabels] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setUnavailable(null);
    try {
      const blocks = await listMyBlocks();
      if (!alive.current) return;
      setRows(blocks);
      try {
        const names = await fetchAccountLabels(blocks.map((row) => row.userId));
        if (alive.current) setLabels(names);
      } catch {
        // The names are a convenience, not the fact. A list that cannot be
        // named is still a true list, so the screen carries on without them.
        if (alive.current) setLabels(new Map());
      }
    } catch (err) {
      if (!alive.current) return;
      if (isMissingServerFunction(err)) {
        // Not an empty list and not a failure: the feature is not in this
        // build, and the reader is told so.
        setUnavailable(UNAVAILABLE_SENTENCES.blockedList);
        setRows(null);
        return;
      }
      setError(friendlyError(err).message);
    }
  }, [alive]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameFor = (userId: string): string => labels.get(userId) ?? "this account";

  const unblock = async (row: BlockedUser): Promise<void> => {
    if (busyId) return;
    setBusyId(row.userId);
    setError(null);
    setNotice(null);
    const name = nameFor(row.userId);
    try {
      await unblockUser(row.userId);
      if (!alive.current) return;
      setRows((current) => (current ?? []).filter((item) => item.userId !== row.userId));
      const outcome = `You've unblocked ${name}. You still won't see each other if they've blocked you.`;
      setNotice(outcome);
      announce(outcome);
    } catch (err) {
      if (!alive.current) return;
      const sentence = isMissingServerFunction(err) ? UNAVAILABLE_SENTENCES.block : friendlyError(err).message;
      setError(sentence);
      announce(sentence);
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  return (
    <SettingsPage
      title="Blocked accounts"
      backTo="/settings/privacy"
      description="People you have blocked. They are not told that you blocked them."
    >
      <SettingsGroup
        title="Blocked"
        description="Blocking hides each of you from the other. Unblocking lets you see each other again — unless they have blocked you."
      >
        {notice ? (
          <p role="status" data-testid="blocked-users-notice" className="px-3 py-2 text-sm text-on-surface-variant">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" data-testid="blocked-users-error" className="px-3 py-2 text-sm text-error">
            {error}
          </p>
        ) : null}
        {unavailable ? (
          <p role="status" data-testid="blocked-users-unavailable" className="px-3 py-2 text-sm text-on-surface-variant">
            {unavailable}
          </p>
        ) : null}
        {(error || unavailable) && <button type="button" className="min-h-[44px] px-3" onClick={() => void load()}>Retry blocked accounts</button>}

        {!error && !unavailable && rows === null ? (
          <p role="status" className="fb-settings-row-description">
            Loading your blocked accounts…
          </p>
        ) : null}

        {!error && !unavailable && rows !== null && rows.length === 0 ? (
          <p className="fb-settings-row-description">You haven’t blocked anyone.</p>
        ) : null}

        {rows?.map((row) => (
          <SettingsRow
            key={row.userId}
            title={`Unblock ${nameFor(row.userId)}`}
            description={`Blocked on ${formatSafetyDate(row.blockedAt)}. You’ll see each other again unless they’ve blocked you.`}
            destructive
            disabled={busyId !== null}
            onClick={() => void unblock(row)}
          />
        ))}
      </SettingsGroup>
    </SettingsPage>
  );
}
