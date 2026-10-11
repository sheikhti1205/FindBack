// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const fetchMock = vi.mocked(fetchNotificationPreferences);
const saveMock = vi.mocked(saveNotificationPreferences);

function allOn() {
  return { pushEnabled: true, likes: true, comments: true, mentions: true, status: true };
}

beforeEach(() => {
  fetchMock.mockReset();
  saveMock.mockReset();
});

afterEach(cleanup);

describe("NotificationSettings", () => {
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
