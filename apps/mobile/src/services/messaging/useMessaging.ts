import { useSyncExternalStore } from "react";
import { useAuth } from "../../auth";
import { EMPTY_MESSAGING_SNAPSHOT, getMessagingRuntimeSnapshot, subscribeMessagingRuntime } from "./runtime";

/** Extra render-time scope fence: a newly rendered account must never observe
 * the previous account's snapshot while the auth effect is still pending. */
export function useMessaging() {
  const { user } = useAuth();
  const snapshot = useSyncExternalStore(subscribeMessagingRuntime, getMessagingRuntimeSnapshot,
    () => EMPTY_MESSAGING_SNAPSHOT);
  return snapshot.accountId === user?.id ? snapshot : EMPTY_MESSAGING_SNAPSHOT;
}
