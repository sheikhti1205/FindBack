// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/notificationPreferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/notificationPreferences")>();
  return {
    ...actual,
    fetchNotificationPreferences: vi.fn(async () => ({
      pushEnabled: true,
      likes: true,
      comments: true,
      mentions: true,
      status: true,
    })),
    saveNotificationPreferences: vi.fn(async () => {}),
  };
});

vi.mock("../services/pushRuntime", () => ({
  pushController: () => ({
    permission: vi.fn(async () => "unsupported" as const),
    start: vi.fn(),
    openSettings: vi.fn(),
  }),
}));

import { NotificationPreferences } from "./NotificationPreferences";

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname}</p>;
}

afterEach(cleanup);

describe("NotificationPreferences", () => {
  it("renders one h1, backs to /settings, and shows the real preference groups", async () => {
    render(
      <MemoryRouter initialEntries={["/settings/notifications"]}>
        <Routes>
          <Route path="/settings/notifications" element={<NotificationPreferences />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Notifications" })).toBeTruthy();
    await screen.findByRole("switch", { name: "Push notifications" });
    expect(screen.getByRole("heading", { name: "Comments & mentions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Report activity" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Report updates" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /back to settings/i }));
    expect(screen.getByTestId("location").textContent).toBe("/settings");
  });
});
