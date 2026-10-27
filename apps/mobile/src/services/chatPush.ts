/** Chat wakes carry no content and cannot supply an arbitrary route. */
export interface ChatPush {
  type: "CHAT_REQUEST" | "CHAT_CONNECTED";
  recipientId: string;
  conversationId: string;
  notificationId: string;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseChatPush(value: unknown): ChatPush | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 4 || (data.type !== "CHAT_REQUEST" && data.type !== "CHAT_CONNECTED")) return null;
  if (![data.recipientId, data.conversationId, data.notificationId].every((id) => typeof id === "string" && uuid.test(id))) return null;
  return { type: data.type, recipientId: data.recipientId as string,
    conversationId: data.conversationId as string, notificationId: data.notificationId as string };
}

/** Single bridge-write lane, independent of slow preference/token operations.
 * A queued clear always runs before a later bind. Never issue a compensating
 * clear from an old completion: it could erase the new account. */
export function createChatAccountBinding(write: (accountId: string | null) => Promise<void>) {
  let queue: Promise<void> = Promise.resolve();
  let revision = 0;
  let admitted: string | null = null;
  let current: () => boolean = () => false;
  return {
    set(accountId: string | null, isCurrent: () => boolean): Promise<void> {
      const ticket = ++revision;
      admitted = null; // JS admission is revoked synchronously, before native IO.
      current = isCurrent;
      const work = queue.then(async () => {
        // Clears are never skipped; stale binds need not be sent to native.
        if (accountId !== null && (ticket !== revision || !isCurrent())) return;
        await write(accountId);
        if (ticket === revision && isCurrent()) admitted = accountId;
      });
      queue = work.catch(() => {});
      return work;
    },
    async ready(accountId: string): Promise<boolean> {
      const ticket = revision;
      await queue;
      return ticket === revision && admitted === accountId && current();
    },
    isReady(accountId: string): boolean { return admitted === accountId && current(); },
  };
}
