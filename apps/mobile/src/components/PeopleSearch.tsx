import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAuth } from "../auth";
import { normalizePeopleQuery, searchPeople, type PeopleSearchCursor, type PeopleSearchPage } from "../services/people";
import { UserAvatar } from "./UserAvatar";
import { useMessaging } from "../services/messaging/useMessaging";

/** One short-lived query per account, with no cross-account result cache. */
export function PeopleSearch({ query }: { query: string }) {
  const { user } = useAuth();
  const normalized = normalizePeopleQuery(query);
  if (!user) return null;
  return <PeopleQuery key={JSON.stringify([user.id, normalized])} accountId={user.id} query={normalized} />;
}

function PeopleQuery({ query, accountId }: { query: string; accountId: string }) {
  const chat = useMessaging();
  const projections = chat.accountId === accountId ? Object.values(chat.currentProjections ?? {}) : [];
  const [page, setPage] = useState<PeopleSearchPage>({ items: [], nextCursor: null });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const load = useCallback(async (cursor: PeopleSearchCursor | null) => {
    const owner = controller.current;
    if (!owner || owner.signal.aborted || pending.current) return;
    pending.current = true; setBusy(true); setFailed(false);
    try {
      const next = await searchPeople(query, { cursor, signal: owner.signal });
      if (owner.signal.aborted || controller.current !== owner) return;
      setPage(previous => ({ items: [...new Map((cursor ? [...previous.items, ...next.items] : next.items).map(person => [person.id, person])).values()], nextCursor: next.nextCursor }));
      setLoaded(true);
    } catch {
      if (!owner.signal.aborted && controller.current === owner) setFailed(true);
    } finally {
      if (!owner.signal.aborted && controller.current === owner) { pending.current = false; setBusy(false); }
    }
  }, [query]);
  useEffect(() => {
    const owner = new AbortController(); controller.current = owner; pending.current = false;
    const timer = query && query.length <= 80 ? setTimeout(() => { void load(null); }, 250) : null;
    return () => { if (timer !== null) clearTimeout(timer); owner.abort(); };
  }, [query, load]);

  if (!query) return <p role="status" className="px-4 py-6 text-sm text-on-surface-variant">Search by username or name.</p>;
  if (query.length > 80) return <p role="status" className="px-4 py-6 text-sm text-on-surface-variant">Try a shorter name or username.</p>;
  return <section aria-label="People results" className="min-w-0 px-3 pb-4">
    <p role="status" className="py-3 text-sm text-on-surface-variant">
      {busy || (!loaded && !failed) ? "Searching people…" : loaded && !page.items.length ? "No people found." : `${page.items.length} ${page.items.length === 1 ? "person" : "people"} shown`}
    </p>
    <ul className="divide-y divide-outline-variant">
      {page.items.map(person => {
        const view = projections.find(projection => projection.peerId === person.id);
        const relationship = view?.ownBlocked ? "Blocked by you" : view?.mode === "CONNECTED" ? "Connected"
          : view?.request === "INCOMING" ? "Message request" : view?.request === "OUTGOING" ? "Request sent" : null;
        return <li key={person.id}>
        <Link to={`/u/${encodeURIComponent(person.username)}`} className="flex min-h-[56px] min-w-0 items-center gap-3 rounded-m3-sm px-1 py-3 hover:bg-surface-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          <UserAvatar username={person.displayName?.trim() || person.username} avatarUrl={person.avatarUrl} size={36} />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><span className="block font-semibold">{person.displayName?.trim() || person.username}</span>{" "}<span className="block text-sm text-on-surface-variant">@{person.username}</span>
            {relationship && <span className="block text-xs text-on-surface-variant">{relationship}</span>}
          </span>
        </Link>
      </li>; })}
    </ul>
    {failed && <div className="py-3"><p role="alert" className="mb-2 text-sm text-error">Couldn't search people. Check your connection and try again.</p>
      <button type="button" className="fb-surface-button" onClick={() => { void load(page.nextCursor); }}>Try again</button></div>}
    {!failed && page.nextCursor && <button type="button" className="fb-surface-button mt-3" disabled={busy} onClick={() => { void load(page.nextCursor); }}>Load more people</button>}
  </section>;
}
