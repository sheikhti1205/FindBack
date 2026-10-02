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

    const push = (await screen.findByRole("switch", { name: "Push notifications" })) as HTMLInputElement;
    expect(push.checked).toBe(true);
    expect(screen.getAllByRole("switch")).toHaveLength(5);
  });

  it("persists a toggle and disables categories when push is off", async () => {
    fetchMock.mockResolvedValue({ ...allOn(), pushEnabled: false });
    saveMock.mockResolvedValue();
    render(<NotificationSettings />);

    const comments = (await screen.findByRole("switch", { name: "Comments" })) as HTMLInputElement;
    expect(comments.disabled).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Push notifications" }));

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(allOn()));
  });

  it("rolls back to the previous value when saving fails", async () => {
    fetchMock.mockResolvedValue(allOn());
    saveMock.mockRejectedValue(new Error("offline"));
    render(<NotificationSettings />);

    const likes = (await screen.findByRole("switch", { name: "Likes" })) as HTMLInputElement;
    fireEvent.click(likes);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(likes.checked).toBe(true);
  });
});
