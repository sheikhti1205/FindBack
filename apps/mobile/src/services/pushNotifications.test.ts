import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    checkPermission: async () => "granted",
    register: vi.fn(async () => {}),
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
  it("never routes a chat-shaped payload as a public report", () => {
    expect(reportUrlFromPushData({ type: "CHAT_REQUEST", url: "https://findbackapp.social/r/abc" })).toBeNull();
    expect(reportUrlFromPushData({ type: "CHAT_UNKNOWN", postId: "abc" })).toBeNull();
  });
  it("prefers an explicit url and falls back to a postId report link", () => {
    expect(reportUrlFromPushData({ url: "https://findbackapp.social/r/abc" })).toBe(
      "https://findbackapp.social/r/abc",
    );
    expect(reportUrlFromPushData({ postId: "abc" })).toBe("https://findbackapp.social/r/abc");
    expect(reportUrlFromPushData({})).toBeNull();
  });
});

describe("createPushController", () => {
  it("admits current-account foreground chat wakes only, never report fallback or chat action extras", async () => {
    const { adapter, handles } = fakeAdapter();
    const account = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    const chat = { type: "CHAT_CONNECTED", recipientId: account, conversationId: other, notificationId: other };
    const chatWake = vi.fn();
    const emitReceived = vi.fn();
    const openReportUrl = vi.fn();
    const controller = createPushController({ adapter, chatAccount: () => account, chatWake, emitReceived, openReportUrl });
    await controller.start();
    handles.received[0]!(chat);
    handles.received[0]!({ ...chat, recipientId: other });
    handles.received[0]!({ ...chat, url: "https://findbackapp.social/r/abc" });
    handles.action[0]!(chat);
    expect(chatWake).toHaveBeenCalledExactlyOnceWith(account);
    expect(emitReceived).not.toHaveBeenCalled();
    expect(openReportUrl).not.toHaveBeenCalled();
    await controller.stop();
    handles.received[0]!(chat);
    expect(chatWake).toHaveBeenCalledOnce();
  });
  it("does not request permission or register after stop interrupts a permission check", async () => {
    let finish!: (permission: "prompt") => void;
    const requestPermission = vi.fn(async () => "granted" as const);
    const checkPermission = vi.fn(() => new Promise<"prompt">((done) => { finish = done; }));
    const { adapter } = fakeAdapter({ checkPermission, requestPermission });
    const controller = createPushController({ adapter });
    const start = controller.start({ requestPermission: true });
    await vi.waitFor(() => expect(checkPermission).toHaveBeenCalled());
    const stop = controller.stop();
    finish("prompt");
    await Promise.all([start, stop]);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(adapter.register).not.toHaveBeenCalled();
  });
  it("invalidates failed-start listeners before retrying", async () => {
    const registerToken = vi.fn(async () => {});
    const register = vi.fn().mockRejectedValueOnce(new Error("bridge failed")).mockResolvedValue(undefined);
    const { adapter, handles } = fakeAdapter({ register });
    const controller = createPushController({ adapter, registerToken });
    await expect(controller.start()).rejects.toThrow("bridge failed");
    await controller.start();
    handles.registration[0]!("stale");
    handles.registration[1]!("fresh");
    await vi.waitFor(() => expect(registerToken).toHaveBeenCalledOnce());
    expect(registerToken).toHaveBeenCalledWith("fresh", "android");
  });
  it("checks permission before the explicitly requested prompt", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    const { adapter } = fakeAdapter({ checkPermission: async () => "granted", requestPermission });
    const controller = createPushController({ adapter });
    await controller.start({ requestPermission: true });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(adapter.register).toHaveBeenCalledOnce();
  });

  it("only an explicit Enable action may request a prompt", async () => {
    const requestPermission = vi.fn(async () => "granted" as const);
    const { adapter } = fakeAdapter({ checkPermission: async () => "prompt", requestPermission });
    const controller = createPushController({ adapter });
    expect(await controller.start()).toBe("prompt");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(await controller.start({ requestPermission: true })).toBe("granted");
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent starts into one registration and listener set", async () => {
    const { adapter, handles } = fakeAdapter({ checkPermission: async () => "granted" });
    const controller = createPushController({ adapter });
    await Promise.all([controller.start(), controller.start()]);
    expect(adapter.register).toHaveBeenCalledOnce();
    expect(handles.registration).toHaveLength(1);
  });

  it("finishes old native register and deletion before a post-stop start", async () => {
    let finishRegister!: () => void;
    const order: string[] = [];
    let calls = 0;
    const { adapter } = fakeAdapter({
      checkPermission: async () => "granted",
      register: vi.fn(async () => {
        order.push(`register-${++calls}`);
        if (calls === 1) await new Promise<void>((done) => { finishRegister = done; });
      }),
      deleteToken: async () => { order.push("delete"); },
    });
    const controller = createPushController({ adapter });
    const oldStart = controller.start();
    await vi.waitFor(() => expect(adapter.register).toHaveBeenCalledOnce());
    const stop = controller.stop();
    const newStart = controller.start();
    await Promise.resolve();
    expect(adapter.register).toHaveBeenCalledOnce();
    finishRegister();
    await Promise.all([oldStart, stop, newStart]);
    expect(order).toEqual(["register-1", "delete", "register-2"]);
    expect(controller.isRunning()).toBe(true);
  });
  it("reports a native token deletion failure and retries the server token release", async () => {
    const unregisterToken = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const deleteToken = vi.fn().mockRejectedValueOnce(new Error("bridge failed")).mockResolvedValue(undefined);
    const { adapter, handles } = fakeAdapter({ deleteToken });
    const controller = createPushController({ adapter, unregisterToken, registerToken: async () => {} });
    await controller.start();
    await handles.registration[0]!("tok");
    expect((await controller.stop()).unregistered).toBe(false);
    expect((await controller.stop()).unregistered).toBe(true);
    expect(unregisterToken).toHaveBeenCalledTimes(2);
    expect(deleteToken).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-flight registration before unregistering and ignores late callbacks", async () => {
    let finish!: () => void;
    const registerToken = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const unregisterToken = vi.fn(async () => {});
    const { adapter, handles } = fakeAdapter();
    const controller = createPushController({ adapter, registerToken, unregisterToken });
    await controller.start();
    handles.registration[0]!("tok");
    await vi.waitFor(() => expect(registerToken).toHaveBeenCalled());
    const stopping = controller.stop();
    expect(unregisterToken).not.toHaveBeenCalled();
    handles.registration[0]!("late-token");
    finish();
    await stopping;
    expect(registerToken).toHaveBeenCalledTimes(1);
    expect(unregisterToken).toHaveBeenCalledWith("tok");
  });
  it("is a no-op on the web", async () => {
    const { adapter } = fakeAdapter({ isNative: () => false });
    const controller = createPushController({ adapter });
    expect(await controller.start()).toBe("unsupported");
    expect(adapter.register).not.toHaveBeenCalled();
  });

  it("registers the token after permission (channels are native-owned)", async () => {
    const registerToken = vi.fn(async () => {});
    const { adapter, handles } = fakeAdapter();
    const controller = createPushController({ adapter, registerToken });

    expect(await controller.start()).toBe("granted");
    expect(adapter.register).toHaveBeenCalledTimes(1);

    handles.registration[0]!("fcm-token-123");
    await vi.waitFor(() => expect(registerToken).toHaveBeenCalledWith("fcm-token-123", "android"));
  });

  it("stops short when permission is denied", async () => {
    const registerToken = vi.fn(async () => {});
    const { adapter } = fakeAdapter({ checkPermission: async () => "denied", requestPermission: async () => "denied" });
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

  it("reports an honest teardown: the device holds no registration", async () => {
    const unregisterToken = vi.fn(async () => {});
    const { adapter, handles } = fakeAdapter();
    const controller = createPushController({ adapter, unregisterToken });

    await controller.start();
    handles.registration[0]!("fcm-token-123");

    await expect(controller.stop()).resolves.toEqual({ unregistered: true, released: true });
  });

  it("reports a failed release instead of hiding it behind a success", async () => {
    const unregisterToken = vi.fn(async () => {
      throw new Error("server down");
    });
    const { adapter, handles } = fakeAdapter();
    const controller = createPushController({ adapter, unregisterToken });

    await controller.start();
    handles.registration[0]!("fcm-token-123");

    await expect(controller.stop()).resolves.toEqual({ unregistered: false, released: false });
  });

  it("reports that nothing was registered when the device never had a token", async () => {
    const { adapter } = fakeAdapter();
    const controller = createPushController({ adapter });

    await controller.start();

    await expect(controller.stop()).resolves.toEqual({ unregistered: true, released: false });
  });
});
