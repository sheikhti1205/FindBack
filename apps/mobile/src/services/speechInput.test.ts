import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * V1 — Android dictation facade contract.
 *
 * The facade is the only surface the composer will touch (H2 wires the text
 * later). These tests pin four product promises from the revised contract:
 *   1. platform/network disclosure is fail-closed (audio never leaves the
 *      device without an explicit opt-in),
 *   2. permission denial and other platform failures surface as a typed
 *      `SpeechInputError`, never a raw Capacitor/Android exception,
 *   3. recognition text is delivered as an editable result event with **no
 *      auto-send path** in the API surface,
 *   4. neither audio buffers nor transcript text are ever logged.
 */

type NativeListener = (payload: unknown) => void;

const { bridge, registerPluginMock, platform } = vi.hoisted(() => ({
  bridge: {
    isAvailable: vi.fn<() => Promise<unknown>>(),
    checkPermission: vi.fn<() => Promise<unknown>>(),
    requestPermission: vi.fn<() => Promise<unknown>>(),
    start: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(),
    stop: vi.fn<() => Promise<unknown>>(),
    cancel: vi.fn<() => Promise<unknown>>(),
    addListener: vi.fn<(event: string, listener: NativeListener) => Promise<unknown>>(),
  },
  registerPluginMock: vi.fn(),
  platform: { native: true, name: "android" },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
  registerPlugin: (name: string) => registerPluginMock(name),
}));

import { SpeechInputError, speechInput } from "./speechInput";

const BRIDGE_KEYS = [
  "addListener",
  "cancel",
  "checkPermission",
  "isAvailable",
  "requestPermission",
  "start",
  "stop",
] as const;

function captureConsole(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const spies = methods.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      calls.push(args);
    }),
  );
  return {
    calls,
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

/** The listener callback the facade handed to the platform bridge. */
function registeredCallback(): NativeListener {
  const call = bridge.addListener.mock.calls[0];
  if (!call) throw new Error("no listener was registered on the bridge");
  return call[1];
}

beforeEach(() => {
  for (const key of Object.keys(bridge) as (keyof typeof bridge)[]) {
    bridge[key].mockReset();
  }
  registerPluginMock.mockClear().mockImplementation(() => bridge);
  platform.native = true;
  platform.name = "android";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("speechInput.isAvailable", () => {
  it("registers the SpeechInput plugin and fails closed to network opt-in when on-device support is unknown", async () => {
    bridge.isAvailable.mockResolvedValue({
      available: true,
      onDevice: "unknown",
      networkOptInRequired: false,
      apiLevel: 33,
    });

    await expect(speechInput.isAvailable()).resolves.toEqual({
      available: true,
      onDevice: "unknown",
      networkOptInRequired: true,
      apiLevel: 33,
    });
    expect(registerPluginMock).toHaveBeenCalledWith("SpeechInput");
  });

  it("reports a confirmed on-device recogniser as not requiring a network opt-in", async () => {
    bridge.isAvailable.mockResolvedValue({
      available: true,
      onDevice: "available",
      networkOptInRequired: false,
      apiLevel: 36,
    });

    const state = await speechInput.isAvailable();
    expect(state.onDevice).toBe("available");
    expect(state.networkOptInRequired).toBe(false);
  });

  it("sanitises an unrecognised on-device field to unknown and a non-numeric api level to null", async () => {
    bridge.isAvailable.mockResolvedValue({
      available: "yes",
      onDevice: "AVAILABLE",
      networkOptInRequired: false,
      apiLevel: "36",
    });

    await expect(speechInput.isAvailable()).resolves.toEqual({
      available: false,
      onDevice: "unknown",
      networkOptInRequired: true,
      apiLevel: null,
    });
  });

  it("rejects with unsupported_platform outside the Android app and never touches the bridge", async () => {
    platform.native = false;

    const error = await speechInput.isAvailable().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SpeechInputError);
    expect(error).toMatchObject({
      name: "SpeechInputError",
      code: "unsupported_platform",
      message: "Dictation is only available in the Android app.",
    });
    expect(registerPluginMock).not.toHaveBeenCalled();
    expect(bridge.isAvailable).not.toHaveBeenCalled();
  });
});

describe("speechInput permission paths", () => {
  it("normalises every native permission state", async () => {
    const expected: Array<[unknown, string]> = [
      [{ state: "granted" }, "granted"],
      [{ state: "prompt" }, "prompt"],
      [{ state: "denied" }, "denied"],
      [{ state: "blocked" }, "blocked"],
      [{ state: "prompt-with-rationale" }, "denied"],
      [{ state: "unexpected" }, "denied"],
      [undefined, "denied"],
    ];

    for (const [native, state] of expected) {
      bridge.checkPermission.mockResolvedValue(native);
      await expect(speechInput.checkPermission()).resolves.toEqual({ state });
    }
    expect(bridge.checkPermission).toHaveBeenCalledTimes(expected.length);
  });

  it("forwards requestPermission and surfaces a blocked prompt as blocked", async () => {
    bridge.requestPermission.mockResolvedValue({ state: "blocked" });
    await expect(speechInput.requestPermission()).resolves.toEqual({ state: "blocked" });
    expect(bridge.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("maps a permission rejection to permission_denied without the raw platform text", async () => {
    bridge.requestPermission.mockRejectedValue({
      code: "permission_denied",
      message: "com.findback.app internal denial detail",
    });

    const error = await speechInput.requestPermission().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SpeechInputError);
    expect(error).toMatchObject({
      code: "permission_denied",
      message: "Microphone permission is required for dictation.",
    });
    expect(String((error as Error).message)).not.toContain("internal denial detail");
  });
});

describe("speechInput.start", () => {
  it("defaults to on-device preference with network audio opt-in switched off", async () => {
    bridge.start.mockResolvedValue({
      started: true,
      route: "on_device",
      networkAudioDisclosed: false,
    });

    await expect(speechInput.start()).resolves.toEqual({
      started: true,
      route: "on_device",
      networkAudioDisclosed: false,
    });
    expect(bridge.start).toHaveBeenCalledWith({
      preferOnDevice: true,
      allowNetworkAudio: false,
    });
  });

  it("forwards an explicit network opt-in together with the preferred language", async () => {
    bridge.start.mockResolvedValue({
      started: true,
      route: "network",
      networkAudioDisclosed: true,
    });

    const started = await speechInput.start({
      preferOnDevice: false,
      allowNetworkAudio: true,
      language: "en-US",
    });

    expect(bridge.start).toHaveBeenCalledWith({
      preferOnDevice: false,
      allowNetworkAudio: true,
      language: "en-US",
    });
    expect(started).toEqual({
      started: true,
      route: "network",
      networkAudioDisclosed: true,
    });
  });

  it("treats a missing route as a network route so audio can never be assumed local", async () => {
    bridge.start.mockResolvedValue({ started: true });

    await expect(speechInput.start()).resolves.toEqual({
      started: true,
      route: "network",
      networkAudioDisclosed: true,
    });
  });

  it("keeps a network disclosure even if the platform claims an on-device route", async () => {
    bridge.start.mockResolvedValue({
      started: true,
      route: "on_device",
      networkAudioDisclosed: true,
    });

    await expect(speechInput.start()).resolves.toMatchObject({
      route: "on_device",
      networkAudioDisclosed: true,
    });
  });

  it("surfaces the documented error taxonomy", async () => {
    const cases: Array<[unknown, string]> = [
      [{ code: "permission_denied" }, "permission_denied"],
      [{ code: "no_recognizer" }, "no_recognizer"],
      [{ code: "busy" }, "busy"],
      [{ code: "network_required" }, "network_required"],
      [{ code: "network_opt_in_required" }, "network_required"],
      [{ code: "timeout" }, "timeout"],
      [{ code: "no_match" }, "no_match"],
      [{ code: "brand_new_native_code" }, "unknown"],
      [{}, "unknown"],
    ];

    for (const [native, code] of cases) {
      bridge.start.mockRejectedValue(native);
      const error = await speechInput.start().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(SpeechInputError);
      expect(error).toMatchObject({ name: "SpeechInputError", code });
      expect(String((error as Error).message).length).toBeGreaterThan(0);
    }
  });

  it("never leaks a raw platform exception", async () => {
    bridge.start.mockRejectedValue(new Error("android.speech native stack boom"));

    const error = await speechInput.start().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SpeechInputError);
    expect(error).toMatchObject({ code: "unknown" });
    expect(String((error as Error).message)).not.toContain("native stack boom");
    expect((error as SpeechInputError).cause).toBeInstanceOf(Error);
  });

  it("rejects with unsupported_platform in the browser", async () => {
    platform.native = false;

    const error = await speechInput.start().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SpeechInputError);
    expect(error).toMatchObject({ code: "unsupported_platform" });
    expect(bridge.start).not.toHaveBeenCalled();
  });
});

describe("speechInput.stop and cancel", () => {
  it("forwards stop and cancel to the platform", async () => {
    bridge.stop.mockResolvedValue({ stopped: true });
    bridge.cancel.mockResolvedValue({ cancelled: true });

    await expect(speechInput.stop()).resolves.toBeUndefined();
    await expect(speechInput.cancel()).resolves.toBeUndefined();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
  });

  it("maps platform failures on stop to the same taxonomy", async () => {
    bridge.stop.mockRejectedValue({ code: "no_recognizer" });

    const error = await speechInput.stop().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SpeechInputError);
    expect(error).toMatchObject({ code: "no_recognizer" });
  });
});

describe("speechInput events", () => {
  const nativeHandle = { remove: vi.fn() };

  beforeEach(() => {
    nativeHandle.remove.mockReset().mockResolvedValue(undefined);
    bridge.addListener.mockResolvedValue(nativeHandle);
  });

  it("delivers recognition text as an editable result event and returns a removable handle", async () => {
    const listener = vi.fn();
    const handle = await speechInput.addListener("speechResult", listener);

    expect(bridge.addListener).toHaveBeenCalledWith("speechResult", expect.any(Function));
    const callback = registeredCallback();
    callback({ text: "black umbrella near the door", isFinal: true, route: "on_device" });

    expect(listener).toHaveBeenCalledWith({
      text: "black umbrella near the door",
      isFinal: true,
      route: "on_device",
    });

    await handle.remove();
    expect(nativeHandle.remove).toHaveBeenCalledTimes(1);
  });

  it("reports an unverifiable route as network in result events", async () => {
    const listener = vi.fn();
    await speechInput.addListener("speechResult", listener);

    const callback = registeredCallback();
    callback({ text: "partial", isFinal: false, route: "totally-local" });

    expect(listener).toHaveBeenCalledWith({
      text: "partial",
      isFinal: false,
      route: "network",
    });
  });

  it("ignores a result event whose text is not a string", async () => {
    const listener = vi.fn();
    await speechInput.addListener("speechResult", listener);

    const callback = registeredCallback();
    callback({ text: 42, isFinal: true, route: "on_device" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("normalises error events into the same taxonomy and messages", async () => {
    const listener = vi.fn();
    await speechInput.addListener("speechError", listener);

    const callback = registeredCallback();
    callback({ code: "network_required", message: "raw vendor text" });
    callback({ code: "something_unmapped", message: "raw vendor text" });

    expect(listener).toHaveBeenNthCalledWith(1, {
      code: "network_required",
      message: "This device would send audio over the network. Allow network audio to continue.",
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      code: "unknown",
      message: "Speech recognition failed.",
    });
  });

  it("drops a state event with an unrecognised value", async () => {
    const listener = vi.fn();
    await speechInput.addListener("speechState", listener);

    const callback = registeredCallback();
    callback({ state: "listening" });
    callback({ state: "not-a-state" });
    callback("nonsense");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ state: "listening" });
  });
});

describe("speechInput API surface and privacy", () => {
  it("exposes only the documented facade methods, so nothing can auto-send", () => {
    expect(Object.keys(speechInput).sort()).toEqual([...BRIDGE_KEYS].sort());
    expect(Object.keys(speechInput)).not.toContain("send");
    expect(Object.keys(speechInput)).not.toContain("submit");
  });

  it("never logs transcript text or audio payloads", async () => {
    const consoleSpy = captureConsole();
    const listener = vi.fn();
    bridge.isAvailable.mockResolvedValue({
      available: true,
      onDevice: "available",
      networkOptInRequired: false,
      apiLevel: 36,
    });
    bridge.start.mockResolvedValue({
      started: true,
      route: "on_device",
      networkAudioDisclosed: false,
    });
    bridge.addListener.mockResolvedValue({ remove: vi.fn() });

    try {
      await speechInput.isAvailable();
      await speechInput.start();
      await speechInput.addListener("speechResult", listener);
      const callback = registeredCallback();
      callback({ text: "SECRET TRANSCRIPT DETAIL", isFinal: true, route: "on_device" });

      expect(consoleSpy.calls).toEqual([]);
      expect(listener).toHaveBeenCalledWith({
        text: "SECRET TRANSCRIPT DETAIL",
        isFinal: true,
        route: "on_device",
      });
      // no audio bytes are ever handed to the platform bridge
      expect(bridge.start).toHaveBeenCalledWith({
        preferOnDevice: true,
        allowNetworkAudio: false,
      });
    } finally {
      consoleSpy.restore();
    }
  });
});
