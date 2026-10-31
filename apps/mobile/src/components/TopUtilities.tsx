import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Bell, Search } from "lucide-react";
import { fetchUnreadCount } from "../services/notifications";
import { INBOX_CHANGED_EVENT } from "../services/notificationSignals";
import { onRealtime } from "../services/realtime";
import { PUSH_RECEIVED_EVENT } from "../services/pushNotifications";
import "./adaptiveFoundation.css";

/** The single notification utility owner, shared by Shell and Home's chrome.
 * Preview integration belongs here, not in the primary destination list. */
export function TopUtilities({ showSearch = true, liveBadge = true, unreadCount, account }: {
  showSearch?: boolean;
  liveBadge?: boolean;
  unreadCount?: number;
  account?: ReactNode;
}) {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    if (!liveBadge) return;
    let cancelled = false;
    let request = 0;
    const pull = () => {
      const current = ++request;
      fetchUnreadCount().then(
        (count) => { if (!cancelled && current === request) setUnread(count); },
        () => { if (!cancelled && current === request) setUnread(null); },
      );
    };
    pull();
    const onFocus = () => pull();
    const onVisibility = () => { if (document.visibilityState === "visible") pull(); };
    const offInbox = onRealtime("notification:added", pull);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(PUSH_RECEIVED_EVENT, pull);
    window.addEventListener(INBOX_CHANGED_EVENT, pull);
    return () => {
      cancelled = true;
      offInbox();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(PUSH_RECEIVED_EVENT, pull);
      window.removeEventListener(INBOX_CHANGED_EVENT, pull);
    };
  }, [liveBadge]);
  const count = unreadCount ?? unread;
  return <nav aria-label="App utilities" className="fb-top-utilities">
    {showSearch && <Link to="/search" aria-label="Search" className="fb-icon-control"><Search size={20} aria-hidden="true" /></Link>}
    <Link to="/notifications" aria-label="Notifications" className="fb-icon-control relative">
      <Bell size={20} aria-hidden="true" />
      {count !== null && count > 0 && <span aria-hidden="true" data-testid="notifications-unread-badge" className="fb-notification-badge bg-error text-on-error">{count > 99 ? "99+" : count}</span>}
    </Link>
    {account}
  </nav>;
}
