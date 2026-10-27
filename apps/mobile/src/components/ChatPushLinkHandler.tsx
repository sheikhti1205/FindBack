import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../auth";
import { acknowledgeChatPushTap, CHAT_PUSH_BOUND_EVENT, listenForChatPushTap, takeChatPushTap } from "../services/pushRuntime";

/** A pending native tap is retained across a cold start, but never across a
 * guest/other-account login. Only a rehydrated canonical owner may consume it. */
export function ChatPushLinkHandler() {
  const { user, booting } = useAuth();
  const account = user?.id;
  const navigate = useNavigate();
  useEffect(() => {
    if (!account || booting) return;
    let stopped = false;
    let busy = false;
    let again = false;
    let remove: (() => void) | undefined;
    let opened: string | undefined;
    const drain = async () => {
      if (stopped) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const tap = await takeChatPushTap(account);
        if (!stopped && tap) {
          if (opened !== tap.notificationId) {
            opened = tap.notificationId;
            navigate(`/connections/${tap.conversationId}`);
          }
          await acknowledgeChatPushTap(account, tap.notificationId);
        }
      } catch { /* No private navigation when the native admission bridge fails. */ }
      finally {
        busy = false;
        if (again && !stopped) { again = false; void drain(); }
      }
    };
    const signal = () => { void drain(); };
    window.addEventListener(CHAT_PUSH_BOUND_EVENT, signal);
    window.addEventListener("focus", signal);
    // This component mounts for every route, so a native bridge that is absent
    // or throws synchronously must not take the shell down with it: the call is
    // guarded as well as the promise, because a missing export throws before
    // `.catch` exists.
    try {
      void listenForChatPushTap(signal).then((cleanup) => {
        if (stopped) cleanup(); else { remove = cleanup; signal(); }
      }).catch(() => {});
    } catch { /* no admission bridge: chat navigation stays closed */ }
    signal();
    return () => {
      stopped = true;
      remove?.();
      window.removeEventListener(CHAT_PUSH_BOUND_EVENT, signal);
      window.removeEventListener("focus", signal);
    };
  }, [account, booting, navigate]);
  return null;
}
