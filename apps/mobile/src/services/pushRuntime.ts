import { createCapacitorPushAdapter, createPushController, type PushController } from "./pushNotifications";

let controller: PushController | null = null;

/** Lazily built singleton. The Capacitor adapter is inert outside a native shell. */
export function pushController(): PushController {
  controller ??= createPushController({ adapter: createCapacitorPushAdapter() });
  return controller;
}

/** Best-effort start after sign-in; a denied permission or bridge error never blocks auth. */
export async function startPushNotifications(): Promise<void> {
  try {
    await pushController().start();
  } catch {
    /* push is an enhancement; the inbox still works without it */
  }
}

export async function stopPushNotifications(): Promise<void> {
  try {
    await pushController().stop();
  } catch {
    /* nothing to tear down */
  }
}
