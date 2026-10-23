import { createCapacitorPushAdapter, createPushController, type PushController } from "./pushNotifications";
import { fetchNotificationPreferences } from "./notificationPreferences";

let controller: PushController | null = null;
let accountId: string | null = null;
let generation = 0;
let ownerCurrent: (() => boolean) | null = null;

/** Lazily built singleton. The Capacitor adapter is inert outside a native shell. */
export function pushController(): PushController {
  controller ??= createPushController({ adapter: createCapacitorPushAdapter(), isCurrent: () => ownerCurrent?.() ?? false });
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
  try {
    const push = pushController();
    if (previous !== null && previous !== owner.accountId) await push.stop();
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
  try {
    await pushController().stop();
  } catch {
    /* nothing to tear down */
  }
}
