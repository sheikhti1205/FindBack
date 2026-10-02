/**
 * Cross-component signal for local inbox mutations.
 *
 * Realtime covers a new notification arriving from another client, but read,
 * unread, delete, restore and mark-all actions happen on this device and must
 * also refresh the bell badge. Components emit this after a successful
 * mutation; the shell refetches the unread count.
 */
export const INBOX_CHANGED_EVENT = "findback:inbox-changed";

/** Notify listeners that the signed-in user's inbox changed locally. */
export function signalInboxChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
}
