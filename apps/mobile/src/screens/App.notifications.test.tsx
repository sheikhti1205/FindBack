// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { auth, native, fetchNotificationsMock, markReadMock } = vi.hoisted(() => ({
  auth: { user: { id: "member-1" } as { id: string } | null },
  native: { back: null as (() => void) | null },
  fetchNotificationsMock: vi.fn(async () => []),
  markReadMock: vi.fn(async () => 0),
}));
vi.mock("../auth", () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => children, useAuth: () => ({ user: auth.user, booting: false, bootError: null }) }));
vi.mock("../theme", () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: (_event: string, listener: () => void) => {
  native.back = listener;
  return Promise.resolve({ remove: () => { native.back = null; } });
} } }));
vi.mock("./Splash", () => ({ Splash: () => <p>Splash screen</p> }));
vi.mock("./SignIn", () => ({ SignIn: () => <p>Sign in screen</p> }));
vi.mock("./Register", () => ({ Register: () => null }));
vi.mock("./Verify", () => ({ Verify: () => null }));
vi.mock("./Home", () => ({ Home: () => <p>Home screen</p> }));
vi.mock("./SearchScreen", () => ({ SearchScreen: () => null }));
vi.mock("./CreateReport", () => ({ CreateReport: () => null }));
vi.mock("./PostDetail", () => ({ PostDetail: () => null }));
vi.mock("./Profile", () => ({ Profile: () => null }));
vi.mock("./About", () => ({ About: () => null }));
vi.mock("./MyPosts", () => ({ MyPosts: () => null }));
vi.mock("./Help", () => ({ Help: () => null }));
vi.mock("./AiConnection", () => ({ AiConnection: () => null }));

vi.mock("../services/notifications", () => ({
  fetchNotifications: fetchNotificationsMock,
  fetchUnreadCount: () => Promise.resolve(0),
  markNotificationsRead: markReadMock,
}));

import { App } from "../App";

afterEach(() => {
  cleanup();
  native.back = null;
  auth.user = { id: "member-1" };
  fetchNotificationsMock.mockReset();
  fetchNotificationsMock.mockResolvedValue([]);
  markReadMock.mockReset();
  markReadMock.mockResolvedValue(0);
  window.history.replaceState(null, "", "/");
});

describe("/notifications", () => {
  it("renders a truthful empty state inside the authenticated shell on a deep link", async () => {
    window.history.replaceState(null, "", "/#/notifications");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(await screen.findByText(/no notifications/i)).toBeTruthy();
    expect(screen.getByText(/all caught up/i)).toBeTruthy();
    expect(screen.queryByText(/not available yet/i)).toBeNull();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeTruthy();
    expect(screen.queryByText(/minutes ago|yesterday/i)).toBeNull();
  });

  it("requires authentication on a direct deep link", async () => {
    auth.user = null;
    window.history.replaceState(null, "", "/#/notifications");
    render(<App />);

    await waitFor(() => expect(screen.getByText("Sign in screen")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Notifications" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("backs out of a cold deep link to Home", async () => {
    window.history.replaceState(null, "", "/#/notifications");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Back to home" }));
    await waitFor(() => expect(screen.getByText("Home screen")).toBeTruthy());
    expect(window.location.hash).toBe("#/");
  });

  it("handles Android Back on a cold deep link without exiting", async () => {
    window.history.replaceState(null, "", "/#/notifications");
    render(<App />);

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(native.back).not.toBeNull();
    act(() => native.back?.());
    await waitFor(() => expect(screen.getByText("Home screen")).toBeTruthy());
    expect(window.location.hash).toBe("#/");
  });
});
