// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopNotificationPermission,
  desktopNotificationsEnabled,
  desktopNotificationsSupported,
  requestDesktopNotifications,
  resetDesktopNotificationsForTest,
  setDesktopNotificationsEnabled,
  showDesktopNotification,
} from "./desktopNotifications";

interface FakeNotification {
  title: string;
  options: NotificationOptions;
  onclick: (() => void) | null;
  close: () => void;
}

let created: FakeNotification[] = [];

function installNotification(permission: NotificationPermission, grant?: NotificationPermission) {
  class Fake {
    static permission: NotificationPermission = permission;
    static requestPermission = vi.fn(async () => {
      Fake.permission = grant ?? permission;
      return Fake.permission;
    });
    title: string;
    options: NotificationOptions;
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(title: string, options: NotificationOptions = {}) {
      this.title = title;
      this.options = options;
      created.push(this as unknown as FakeNotification);
    }
  }
  vi.stubGlobal("Notification", Fake);
  return Fake;
}

beforeEach(() => {
  created = [];
  resetDesktopNotificationsForTest();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("desktop notifications", () => {
  it("reports an unsupported browser instead of pretending", () => {
    vi.stubGlobal("Notification", undefined);
    expect(desktopNotificationsSupported()).toBe(false);
    expect(desktopNotificationPermission()).toBe("unsupported");
    expect(desktopNotificationsEnabled("account")).toBe(false);
  });

  it("never counts as enabled without both the opt-in and the OS permission", () => {
    const Fake = installNotification("granted");
    expect(desktopNotificationsEnabled("account")).toBe(false);
    setDesktopNotificationsEnabled("account", true);
    expect(desktopNotificationsEnabled("account")).toBe(true);
    Fake.permission = "denied";
    expect(desktopNotificationsEnabled("account")).toBe(false);
  });

  it("keeps the opt-in per account", () => {
    installNotification("granted");
    setDesktopNotificationsEnabled("a", true);
    expect(desktopNotificationsEnabled("a")).toBe(true);
    expect(desktopNotificationsEnabled("b")).toBe(false);
  });

  it("requests the browser permission and reports the real result", async () => {
    const Fake = installNotification("default", "granted");
    expect(desktopNotificationPermission()).toBe("prompt");
    expect(await requestDesktopNotifications()).toBe("granted");
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("stays quiet once the browser has denied notifications", async () => {
    const Fake = installNotification("denied");
    expect(desktopNotificationPermission()).toBe("denied");
    expect(await requestDesktopNotifications()).toBe("denied");
    expect(Fake.requestPermission).not.toHaveBeenCalled();
  });

  it("shows one system alert per activity and focuses the app on click", () => {
    installNotification("granted");
    setDesktopNotificationsEnabled("account", true);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const onClick = vi.fn();
    showDesktopNotification("account", { title: "@ana commented on your report", body: "Is this still lost?", tag: "row-1", onClick });
    showDesktopNotification("account", { title: "duplicate", body: "duplicate", tag: "row-1" });
    expect(created).toHaveLength(1);
    const alert = created[0]!;
    expect(alert.title).toBe("@ana commented on your report");
    expect(alert.options.tag).toBe("account:row-1");
    alert.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the reader has not opted in", () => {
    installNotification("granted");
    showDesktopNotification("account", { title: "no", body: "no" });
    expect(created).toHaveLength(0);
  });

  it("never throws when the browser refuses to construct an alert", () => {
    installNotification("granted");
    setDesktopNotificationsEnabled("account", true);
    vi.stubGlobal("Notification", class {
      static permission: NotificationPermission = "granted";
      constructor() { throw new Error("only from a service worker"); }
    });
    expect(() => showDesktopNotification("account", { title: "x", body: "y" })).not.toThrow();
  });
});
