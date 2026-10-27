import { createCapacitorPushAdapter, createPushController, type PushController } from "./pushNotifications";
import { fetchNotificationPreferences } from "./notificationPreferences";
import { createChatAccountBinding, parseChatPush } from "./chatPush";

let controller: PushController | null = null;
let accountId: string | null = null;
let generation = 0;
let ownerCurrent: (() => boolean) | null = null;
const adapter = createCapacitorPushAdapter();
const binding = createChatAccountBinding(async (account) => { await adapter.setChatAccount?.(account); });

export const CHAT_PUSH_BOUND_EVENT = "findback:chat-push-bound";

function chatWake(account: string): void {
  if (account !== accountId || !ownerCurrent?.() || !binding.isReady(account)) return;
  void import("./messaging/runtime").then(({ invalidateMessaging }) => {
    if (account === accountId && ownerCurrent?.() && binding.isReady(account)) invalidateMessaging(account);
  }).catch(() => {});
}

/** Taps use this bridge, never FCM action extras. Auth and bind generation are
 * checked both sides of the await; cold cached admission cannot navigate. */
export async function takeChatPushTap(account: string) {
  const epoch = generation;
  if (accountId !== account || !await binding.ready(account)) return null;
  const result = parseChatPush(await adapter.takeChatTap?.(account));
  if (epoch !== generation || accountId !== account || !ownerCurrent?.() || !binding.isReady(account)) return null;
  if (!result || result.recipientId !== account) return null;
  chatWake(account);
  return result;
}

export async function listenForChatPushTap(callback: () => void): Promise<() => void> {
  return await adapter.onChatTap?.(callback) ?? (() => {});
}

export async function acknowledgeChatPushTap(account: string, notificationId: string): Promise<void> {
  if (account !== accountId || !ownerCurrent?.() || !binding.isReady(account)) return;
  await adapter.acknowledgeChatTap?.(account, notificationId);
}

/** Lazily built singleton. The Capacitor adapter is inert outside a native shell. */
export function pushController(): PushController {
  controller ??= createPushController({ adapter,
    isCurrent: () => accountId !== null && binding.isReady(accountId) && (ownerCurrent?.() ?? false),
    chatAccount: () => accountId, chatWake });
  return controller;
}

/** Best-effort start after sign-in; a denied permission or bridge error never blocks auth. */
export async function startPushNotifications(owner: { accountId: string; isCurrent: () => boolean }): Promise<void> {
  const previous = accountId;
  if (previous !== owner.accountId) ++generation;
  const epoch = generation;
  accountId = owner.accountId;
  ownerCurrent = owner.isCurrent;
  const active = () => generation === epoch && accountId === owner.accountId && owner.isCurrent();
  // Fence old controller callbacks synchronously. Native binding has its own
  // serialized lane so a slow token/preferences operation cannot delay clear.
  const push = pushController();
  const stopping = previous !== null && previous !== owner.accountId ? push.stop() : Promise.resolve();
  void stopping.catch(() => {}); // bound may reject first; still observe stop.
  const bound = binding.set(owner.accountId, active);
  try {
    await bound;
    if (active() && typeof window !== "undefined") window.dispatchEvent(new Event(CHAT_PUSH_BOUND_EVENT));
    await stopping;
    if (!active()) return;
    await push.start({
      requestPermission: false,
      isCurrent: active,
      prepare: async () => (await fetchNotificationPreferences()).pushEnabled,
    });
  } catch {
    /* push is an enhancement; the inbox still works without it */
  }
}

export async function stopPushNotifications(): Promise<void> {
  ++generation;
  accountId = null;
  ownerCurrent = () => false;
  const cleared = binding.set(null, () => true);
  const stopped = pushController().stop();
  try {
    await Promise.all([cleared, stopped]);
  } catch {
    /* nothing to tear down */
  }
}
