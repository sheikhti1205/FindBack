import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FINDBACK_PUSH_CHANNEL,
  createPushController,
  reportUrlFromPushData,
  type PushAdapter,
} from "./pushNotifications";

function fakeAdapter(overrides: Partial<PushAdapter> = {}) {
  const handles = {
    registration: [] as Array<(token: string) => void>,
    registrationError: [] as Array<(message: string) => void>,
    received: [] as Array<(data: Record<string, string>) => void>,
    action: [] as Array<(data: Record<string, string>) => void>,
  };
  const removed: string[] = [];
  const registration = (cb: (token: string) => void) => {
    handles.registration.push(cb);
    return () => removed.push("registration");
  };
  const registrationError = (cb: (message: string) => void) => {
    handles.registrationError.push(cb);
    return () => removed.push("registrationError");
  };
  const received = (cb: (data: Record<string, string>) => void) => {
    handles.received.push(cb);
    return () => removed.push("received");
  };
  const action = (cb: (data: Record<string, string>) => void) => {
    handles.action.push(cb);
    return () => removed.push("action");
  };
  const adapter: PushAdapter = {
    isNative: () => true,
    platform: () => "android",
    requestPermission: async () => "granted",
    register: vi.fn(async () => {}),
    createChannel: vi.fn(async () => {}),
    onRegistration: async (cb) => registration(cb),
    onRegistrationError: async (cb) => registrationError(cb),
    onReceived: async (cb) => received(cb),
    onAction: async (cb) => action(cb),
    ...overrides,
  };
  return { adapter, handles, removed };
}

beforeEach(() => {
  vi.stubEnv("VITE_PUBLIC_SHARE_ORIGIN", "https://findbackapp.social");
});

describe("reportUrlFromPushData", () => {
  it("prefers an explicit url and falls back to a postId report link", () => {
    expect(reportUrlFromPushData({ url: "https://findbackapp.social/r/abc" })).toBe(
      "https://findbackapp.social/r/abc",
    );
    expect(reportUrlFromPushData({ postId: "abc" })).toBe("https://findbackapp.social/r/abc");
    expect(reportUrlFromPushData({})).toBeNull();
  });
});

describe("createPushController", () => {
  it("is a no-op on the web", async () => {
    const { adapter } = fakeAdapter({ isNative: () => false });
    const controller = createPushController({ adapter });
    expect(await controller.start()).toBe("unsupported");
    expect(adapter.register).not.toHaveBeenCalled();
  });

  it("creates the Android channel and registers the token after permission", async () => {
    const registerToken = vi.fn(async () => {});
    const { adapter, handles } = fakeAdapter();
    const controller = createPushController({ adapter, registerToken });

    expect(await controller.start()).toBe("granted");
    expect(adapter.createChannel).toHaveBeenCalledWith(FINDBACK_PUSH_CHANNEL);
    expect(adapter.register).toHaveBeenCalledTimes(1);

    handles.registration[0]!("fcm-token-123");
    await vi.waitFor(() => expect(registerToken).toHaveBeenCalledWith("fcm-token-123", "android"));
  });

  it("stops short when permission is denied", async () => {
    const registerToken = vi.fn(async () => {});
    const { adapter } = fakeAdapter({ requestPermission: async () => "denied" });
    const controller = createPushController({ adapter, registerToken });

    expect(await controller.start()).toBe("denied");
    expect(adapter.register).not.toHaveBeenCalled();
    expect(registerToken).not.toHaveBeenCalled();
  });

  it("routes a tapped notification into a report URL", async () => {
    const openReportUrl = vi.fn();
    const { adapter, handles } = fakeAdapter();
    const controller = createPushController({ adapter, openReportUrl });
    await controller.start();

    handles.action[0]!({ postId: "post-9" });
    expect(openReportUrl).toHaveBeenCalledWith("https://findbackapp.social/r/post-9");
  });

  it("signals a foreground receipt and tears listeners down on stop", async () => {
    const emitReceived = vi.fn();
    const { adapter, handles, removed } = fakeAdapter();
    const controller = createPushController({ adapter, emitReceived });
    await controller.start();

    handles.received[0]!({});
    expect(emitReceived).toHaveBeenCalledTimes(1);

    await controller.stop();
    expect(controller.isRunning()).toBe(false);
    expect(removed.sort()).toEqual(["action", "received", "registration", "registrationError"]);
  });

  it("surfaces token registration failures without throwing", async () => {
    const onRegistrationError = vi.fn();
    const { adapter, handles } = fakeAdapter();
    const controller = createPushController({
      adapter,
      onRegistrationError,
      registerToken: async () => {
        throw new Error("server down");
      },
    });
    await controller.start();

    handles.registration[0]!("tok");
    await vi.waitFor(() => expect(onRegistrationError).toHaveBeenCalledWith("server down"));
  });

  it("unregisters the device token and deletes it on stop", async () => {
    const unregisterToken = vi.fn(async () => {});
    const deleteToken = vi.fn(async () => {});
    const { adapter, handles } = fakeAdapter({ deleteToken });
    const controller = createPushController({ adapter, unregisterToken });

    await controller.start();
    handles.registration[0]!("fcm-token-123");
    await controller.stop();

    expect(unregisterToken).toHaveBeenCalledWith("fcm-token-123");
    expect(deleteToken).toHaveBeenCalledTimes(1);
  });

  it("does not unregister when no token was ever registered", async () => {
    const unregisterToken = vi.fn(async () => {});
    const { adapter } = fakeAdapter();
    const controller = createPushController({ adapter, unregisterToken });
    await controller.start();
    await controller.stop();
    expect(unregisterToken).not.toHaveBeenCalled();
  });
});
