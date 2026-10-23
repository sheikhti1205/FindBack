// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationSettings } from "./NotificationSettings";
import { fetchNotificationPreferences, saveNotificationPreferences } from "../services/notificationPreferences";

vi.mock("../services/notificationPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/notificationPreferences")>();
  return {
    ...actual,
    fetchNotificationPreferences: vi.fn(),
    saveNotificationPreferences: vi.fn(),
  };
});

const { pushControllerMock } = vi.hoisted(() => ({
  pushControllerMock: {
    start: vi.fn(),
    stop: vi.fn(),
    permission: vi.fn(),
    openSettings: vi.fn(),
    isRunning: vi.fn(),
  },
}));

const authOwner = vi.hoisted(() => ({ id: "A" as string | null }));
vi.mock("../auth", () => ({ useAuth: () => ({ user: authOwner.id ? { id: authOwner.id } : null }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

vi.mock("../services/pushRuntime", () => ({ pushController: () => pushControllerMock }));

const fetchMock = vi.mocked(fetchNotificationPreferences);
const saveMock = vi.mocked(saveNotificationPreferences);

function allOn() {
  return { pushEnabled: true, likes: true, comments: true, mentions: true, status: true };
}

beforeEach(() => {
  authOwner.id = "A";
  fetchMock.mockReset();
  saveMock.mockReset();
  pushControllerMock.start.mockReset();
  pushControllerMock.stop.mockReset();
  pushControllerMock.permission.mockReset();
  pushControllerMock.openSettings.mockReset();
  // The web default: no OS permission, nothing registered.
  pushControllerMock.permission.mockResolvedValue("unsupported");
  pushControllerMock.stop.mockResolvedValue({ unregistered: true, released: true });
  pushControllerMock.start.mockResolvedValue("granted");
});

afterEach(cleanup);

describe("NotificationSettings", () => {
  it.each(["start", "stop", "openSettings"] as const)("invalidates an issued %s action and its late rejection at account switch", async (action) => {
    const pending = deferred<unknown>();
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockResolvedValue();
    pushControllerMock.permission.mockResolvedValue(action === "stop" ? "granted" : action === "start" ? "prompt" : "denied");
    pushControllerMock[action].mockReturnValueOnce(pending.promise);
    const heard: string[] = [];
    const onAnnounce = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener("findback:announce", onAnnounce);
    try {
      const view = render(<NotificationSettings />);
      if (action === "stop") fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));
      else fireEvent.click(await screen.findByRole("button", { name: action === "start" ? "Enable device notifications" : "Open notification settings" }));
      await waitFor(() => expect(pushControllerMock[action]).toHaveBeenCalledOnce());
      const guard = action === "start" ? pushControllerMock.start.mock.calls[0]![0].isCurrent as () => boolean : null;
      expect(guard?.() ?? true).toBe(true);
      authOwner.id = "B";
      pushControllerMock.permission.mockResolvedValue("unsupported");
      view.rerender(<NotificationSettings />);
      expect(guard?.() ?? false).toBe(false);
      await act(async () => { pending.reject(new Error("A's late bridge failure")); });
      await screen.findByRole("switch", { name: "Push notifications" });
      expect(heard).toEqual([]);
      expect(screen.queryByRole("alert")).toBeNull();
      expect((screen.getByRole("switch", { name: "Push notifications" }) as HTMLButtonElement).disabled).toBe(false);
    } finally { window.removeEventListener("findback:announce", onAnnounce); }
  });

  it("does not announce A's issued stop success after B mounts", async () => {
    const pending = deferred<{ unregistered: boolean; released: boolean }>();
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockResolvedValue();
    pushControllerMock.stop.mockReturnValueOnce(pending.promise);
    const heard: string[] = [];
    const onAnnounce = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener("findback:announce", onAnnounce);
    try {
      const view = render(<NotificationSettings />);
      fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));
      await waitFor(() => expect(pushControllerMock.stop).toHaveBeenCalledOnce());
      authOwner.id = "B";
      view.rerender(<NotificationSettings />);
      await act(async () => { pending.resolve({ unregistered: true, released: true }); });
      expect(heard).toEqual([]);
    } finally { window.removeEventListener("findback:announce", onAnnounce); }
  });

  it("does not revive A's pending save when switching A to B and back to A", async () => {
    const pending = deferred<void>();
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockReturnValueOnce(pending.promise);
    const view = render(<NotificationSettings />);
    fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));
    authOwner.id = "B";
    view.rerender(<NotificationSettings />);
    await screen.findByRole("switch", { name: "Push notifications" });
    authOwner.id = "A";
    view.rerender(<NotificationSettings />);
    await screen.findByRole("switch", { name: "Push notifications" });
    await act(async () => { pending.resolve(); });
    expect(pushControllerMock.stop).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("unmounts account settings on sign-out and does not read guest preferences", async () => {
    fetchMock.mockResolvedValue(allOn());
    const view = render(<NotificationSettings />);
    await screen.findByRole("switch", { name: "Push notifications" });
    authOwner.id = null;
    view.rerender(<NotificationSettings />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("resets loaded preferences and permission immediately when A switches to B", async () => {
    fetchMock.mockResolvedValueOnce(allOn());
    pushControllerMock.permission.mockResolvedValueOnce("denied");
    const view = render(<NotificationSettings />);
    await screen.findByRole("button", { name: "Open notification settings" });
    const next = deferred<ReturnType<typeof allOn>>();
    fetchMock.mockReturnValueOnce(next.promise);
    pushControllerMock.permission.mockResolvedValueOnce("unsupported");
    authOwner.id = "B";
    view.rerender(<NotificationSettings />);
    expect(screen.queryByRole("switch", { name: "Push notifications" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open notification settings" })).toBeNull();
    await act(async () => { next.resolve({ ...allOn(), pushEnabled: false }); });
    expect((await screen.findByRole("switch", { name: "Push notifications" })).getAttribute("aria-checked")).toBe("false");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("does not invoke B's controller after A's late master save (%s)", async (initial) => {
    const save = deferred<void>();
    fetchMock.mockResolvedValueOnce({ ...allOn(), pushEnabled: initial }).mockResolvedValue(allOn());
    pushControllerMock.permission.mockResolvedValue("granted");
    saveMock.mockReturnValueOnce(save.promise);
    const heard: string[] = [];
    const onAnnounce = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener("findback:announce", onAnnounce);
    try {
      const view = render(<NotificationSettings />);
      fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));
      await waitFor(() => expect(saveMock).toHaveBeenCalledOnce());
      authOwner.id = "B";
      view.rerender(<NotificationSettings />);
      await screen.findByRole("switch", { name: "Push notifications" });
      await act(async () => { save.resolve(); });
      expect(pushControllerMock.stop).not.toHaveBeenCalled();
      expect(pushControllerMock.start).not.toHaveBeenCalled();
      expect(heard).toEqual([]);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("switch", { name: "Push notifications" }).getAttribute("aria-checked")).toBe("true");
    } finally { window.removeEventListener("findback:announce", onAnnounce); }
  });

  it("ignores A's rejected save after switching to B", async () => {
    const save = deferred<void>();
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockReturnValueOnce(save.promise);
    const view = render(<NotificationSettings />);
    fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));
    authOwner.id = "B";
    view.rerender(<NotificationSettings />);
    await screen.findByRole("switch", { name: "Push notifications" });
    await act(async () => { save.reject(new Error("A's late failure")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("switch", { name: "Push notifications" }).getAttribute("aria-checked")).toBe("true");
    expect(pushControllerMock.stop).not.toHaveBeenCalled();
  });

  it("ignores A's late load and permission when B is already loaded", async () => {
    const load = deferred<ReturnType<typeof allOn>>();
    const permission = deferred<string>();
    fetchMock.mockReturnValueOnce(load.promise).mockResolvedValue(allOn());
    pushControllerMock.permission.mockReturnValueOnce(permission.promise).mockResolvedValue("unsupported");
    const view = render(<NotificationSettings />);
    authOwner.id = "B";
    view.rerender(<NotificationSettings />);
    await act(async () => {
      load.resolve({ ...allOn(), pushEnabled: false });
      permission.resolve("denied");
    });
    expect((await screen.findByRole("switch", { name: "Push notifications" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("button", { name: "Open notification settings" })).toBeNull();
  });

  it("requests permission only from the explicit Enable button", async () => {
    fetchMock.mockResolvedValue(allOn());
    pushControllerMock.permission.mockResolvedValue("prompt");
    render(<NotificationSettings />);
    const enable = await screen.findByRole("button", { name: "Enable device notifications" });
    expect(pushControllerMock.start).not.toHaveBeenCalled();
    fireEvent.click(enable);
    await waitFor(() => expect(pushControllerMock.start).toHaveBeenCalledWith({ requestPermission: true, isCurrent: expect.any(Function) }));
  });

  it("re-enabling the master switch never requests permission", async () => {
    fetchMock.mockResolvedValue({ ...allOn(), pushEnabled: false });
    saveMock.mockResolvedValue();
    pushControllerMock.permission.mockResolvedValue("granted");
    render(<NotificationSettings />);
    fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));
    await waitFor(() => expect(pushControllerMock.start).toHaveBeenCalledWith({ requestPermission: false, isCurrent: expect.any(Function) }));
  });
  it("loads and renders every category switch", async () => {
    fetchMock.mockResolvedValue(allOn());
    render(<NotificationSettings />);

    const push = await screen.findByRole("switch", { name: "Push notifications" });
    expect(push.getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("switch")).toHaveLength(5);
  });

  it("persists a toggle and disables categories when push is off", async () => {
    fetchMock.mockResolvedValue({ ...allOn(), pushEnabled: false });
    saveMock.mockResolvedValue();
    render(<NotificationSettings />);

    const comments = await screen.findByRole("switch", { name: "Comments" });
    expect((comments as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Push notifications" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(allOn()));
  });

  it("rolls back to the previous value when saving fails", async () => {
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockRejectedValue(new Error("offline"));
    render(<NotificationSettings />);

    const likes = await screen.findByRole("switch", { name: "Reactions" });
    fireEvent.click(likes);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(likes.getAttribute("aria-checked")).toBe("true");
  });

  it("labels the report-activity toggle with reactions copy (FBX-035)", async () => {
    fetchMock.mockResolvedValue(allOn());
    render(<NotificationSettings />);

    expect(await screen.findByRole("switch", { name: "Reactions" })).toBeTruthy();
    expect(screen.getByText("Someone reacts to your report.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Likes" })).toBeNull();
  });

  it("groups switches under Comments & mentions, Report activity, and Report updates", async () => {
    fetchMock.mockResolvedValue(allOn());
    render(<NotificationSettings />);

    await screen.findByRole("switch", { name: "Push notifications" });
    for (const heading of ["Comments & mentions", "Report activity", "Report updates"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    }
    const group = (name: string) =>
      screen.getByRole("heading", { name }).closest("section") ?? document.body;
    expect(group("Comments & mentions").querySelectorAll('[role="switch"]')).toHaveLength(2);
    expect(group("Report activity").querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(group("Report updates").querySelectorAll('[role="switch"]')).toHaveLength(1);
  });
});

describe("NotificationSettings — the master push switch", () => {
  it("releases this device's push registration when push is turned off", async () => {
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockResolvedValue();
    pushControllerMock.permission.mockResolvedValue("granted");
    pushControllerMock.stop.mockResolvedValue({ unregistered: true, released: true });
    const heard: string[] = [];
    const handler = (event: Event) => heard.push((event as CustomEvent<string>).detail);
    window.addEventListener("findback:announce", handler);
    render(<NotificationSettings />);

    fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));

    await waitFor(() => expect(pushControllerMock.stop).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("This phone is no longer registered for alerts."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open notification settings" })).toBeTruthy();
    expect(heard).toContain("This phone is no longer registered for push notifications.");
    window.removeEventListener("findback:announce", handler);
  });

  it("never claims the device was released when the release failed", async () => {
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockResolvedValue();
    pushControllerMock.permission.mockResolvedValue("granted");
    pushControllerMock.stop.mockResolvedValue({ unregistered: false, released: false });
    render(<NotificationSettings />);

    fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/still registered/i);
    expect(screen.queryByText("This phone is no longer registered for alerts.")).toBeNull();
  });

  it("does not touch the device registration for a category switch", async () => {
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockResolvedValue();
    render(<NotificationSettings />);

    fireEvent.click(await screen.findByRole("switch", { name: "Comments" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(pushControllerMock.stop).not.toHaveBeenCalled();
  });

  it("keeps the device registration when the preference could not be saved", async () => {
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockRejectedValue(new Error("offline"));
    render(<NotificationSettings />);

    fireEvent.click(await screen.findByRole("switch", { name: "Push notifications" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(pushControllerMock.stop).not.toHaveBeenCalled();
  });
});
