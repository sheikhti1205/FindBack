import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushAdapter } from "./pushNotifications";

const fake = vi.hoisted(() => ({
  adapter: null as unknown as PushAdapter,
  preferences: vi.fn(),
  registerToken: vi.fn(),
  unregisterToken: vi.fn(),
}));
vi.mock("./notificationPreferences", () => ({ fetchNotificationPreferences: () => fake.preferences() }));
vi.mock("./deviceTokens", () => ({
  registerDeviceToken: (...args: unknown[]) => fake.registerToken(...args),
  unregisterDeviceToken: (...args: unknown[]) => fake.unregisterToken(...args),
}));
vi.mock("./pushNotifications", async (original) => ({
  ...await original<typeof import("./pushNotifications")>(),
  createCapacitorPushAdapter: () => fake.adapter,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let registration: ((token: string) => void) | null;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  registration = null;
  fake.preferences.mockResolvedValue({ pushEnabled: true });
  fake.registerToken.mockResolvedValue(undefined);
  fake.unregisterToken.mockResolvedValue(1);
  fake.adapter = {
    isNative: () => true, platform: () => "android",
    checkPermission: vi.fn(async () => "granted" as const),
    requestPermission: vi.fn(async () => "granted" as const),
    register: vi.fn(async () => {}), deleteToken: vi.fn(async () => {}),
    onRegistration: async (cb) => { registration = cb; return () => {}; },
    onRegistrationError: async () => () => {}, onReceived: async () => () => {}, onAction: async () => () => {},
  };
});

describe("sign-in push lifecycle", () => {
  it("coalesces duplicate same-account sign-in effects", async () => {
    const { startPushNotifications } = await import("./pushRuntime");
    await Promise.all([
      startPushNotifications({ accountId: "A", isCurrent: () => true }),
      startPushNotifications({ accountId: "A", isCurrent: () => true }),
    ]);
    expect(fake.adapter.register).toHaveBeenCalledOnce();
    registration!("token");
    await vi.waitFor(() => expect(fake.registerToken).toHaveBeenCalledOnce());
  });

  it("fails closed if preferences cannot be read", async () => {
    fake.preferences.mockRejectedValue(new Error("offline"));
    const { startPushNotifications } = await import("./pushRuntime");
    await startPushNotifications({ accountId: "A", isCurrent: () => true });
    expect(fake.adapter.register).not.toHaveBeenCalled();
    expect(fake.adapter.requestPermission).not.toHaveBeenCalled();
  });

  it("fences settings-start callbacks too when the auth owner's account changes", async () => {
    let current = true;
    fake.adapter.checkPermission = vi.fn(async () => "prompt" as const);
    const { startPushNotifications, pushController } = await import("./pushRuntime");
    await startPushNotifications({ accountId: "A", isCurrent: () => current });
    fake.adapter.checkPermission = vi.fn(async () => "granted" as const);
    await pushController().start({ requestPermission: true });
    current = false;
    registration!("late-settings-token");
    await Promise.resolve();
    expect(fake.registerToken).not.toHaveBeenCalled();
  });

  it("honours a saved master OFF after process restart", async () => {
    fake.preferences.mockResolvedValue({ pushEnabled: false });
    const { startPushNotifications } = await import("./pushRuntime");
    await startPushNotifications({ accountId: "A", isCurrent: () => true });
    expect(fake.preferences).toHaveBeenCalledOnce();
    expect(fake.adapter.register).not.toHaveBeenCalled();
    expect(fake.adapter.requestPermission).not.toHaveBeenCalled();
  });

  it.each(["prompt", "denied"] as const)("never prompts on sign-in when OS permission is %s", async (permission) => {
    fake.adapter.checkPermission = vi.fn(async () => permission);
    const { startPushNotifications } = await import("./pushRuntime");
    await startPushNotifications({ accountId: "A", isCurrent: () => true });
    expect(fake.adapter.requestPermission).not.toHaveBeenCalled();
    expect(fake.adapter.register).not.toHaveBeenCalled();
  });

  it("registers on granted permission without asking again", async () => {
    const { startPushNotifications } = await import("./pushRuntime");
    await startPushNotifications({ accountId: "A", isCurrent: () => true });
    expect(fake.adapter.register).toHaveBeenCalledOnce();
    expect(fake.adapter.requestPermission).not.toHaveBeenCalled();
  });

  it("does not start after a late preference read crosses sign-out", async () => {
    const pending = deferred<{ pushEnabled: boolean }>();
    fake.preferences.mockReturnValue(pending.promise);
    const { startPushNotifications, stopPushNotifications } = await import("./pushRuntime");
    const start = startPushNotifications({ accountId: "A", isCurrent: () => true });
    await vi.waitFor(() => expect(fake.preferences).toHaveBeenCalled());
    await stopPushNotifications();
    pending.resolve({ pushEnabled: true });
    await start;
    expect(fake.adapter.register).not.toHaveBeenCalled();
  });

  it("does not start after master OFF stops the controller during a preference read", async () => {
    const pending = deferred<{ pushEnabled: boolean }>();
    fake.preferences.mockReturnValue(pending.promise);
    const { startPushNotifications, pushController } = await import("./pushRuntime");
    const start = startPushNotifications({ accountId: "A", isCurrent: () => true });
    await vi.waitFor(() => expect(fake.preferences).toHaveBeenCalled());
    await pushController().stop();
    pending.resolve({ pushEnabled: true });
    await start;
    expect(fake.adapter.register).not.toHaveBeenCalled();
  });

  it("rejects A's late preference read and token callback after switching to B", async () => {
    const pending = deferred<{ pushEnabled: boolean }>();
    fake.preferences.mockReturnValueOnce(pending.promise).mockResolvedValue({ pushEnabled: true });
    let account = "A";
    const { startPushNotifications } = await import("./pushRuntime");
    const first = startPushNotifications({ accountId: "A", isCurrent: () => account === "A" });
    await vi.waitFor(() => expect(fake.preferences).toHaveBeenCalledOnce());
    account = "B";
    await startPushNotifications({ accountId: "B", isCurrent: () => account === "B" });
    pending.resolve({ pushEnabled: true });
    await first;
    expect(fake.adapter.register).toHaveBeenCalledOnce();
    registration!("B-token");
    await vi.waitFor(() => expect(fake.registerToken).toHaveBeenCalledWith("B-token", "android"));
  });

  it("checks the auth owner's account guard again inside the token callback", async () => {
    let current = true;
    const { startPushNotifications } = await import("./pushRuntime");
    await startPushNotifications({ accountId: "A", isCurrent: () => current });
    const oldCallback = registration!;
    current = false; // auth SDK invalidates synchronously, before effects run
    oldCallback("A-late-token");
    await Promise.resolve();
    expect(fake.registerToken).not.toHaveBeenCalled();
  });
});
