// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
vi.mock("../auth", () => ({ useAuth: () => ({ user: { id: "moderator" } }) }));

const { mockFetchMyRole, mockFetchModerationQueue, mockFetchModerationTarget } = vi.hoisted(() => ({
  mockFetchMyRole: vi.fn(),
  mockFetchModerationQueue: vi.fn(),
  mockFetchModerationTarget: vi.fn(),
}));

vi.mock("../services/roles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/roles")>();
  return { ...actual, fetchMyRole: (...args: unknown[]) => mockFetchMyRole(...args) };
});

vi.mock("../services/moderation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/moderation")>();
  return {
    ...actual,
    fetchModerationQueue: (...args: unknown[]) => mockFetchModerationQueue(...args),
    fetchModerationTarget: (...args: unknown[]) => mockFetchModerationTarget(...args),
  };
});

import { ModerationQueue } from "./ModerationQueue";
import { ApiError } from "../services/session";

afterEach(cleanup);

const QUEUE_ENTRY = {
  targetType: "POST" as const,
  targetId: "post-1",
  reportCount: 2,
  reasons: ["HARASSMENT" as const],
  firstReportedAt: "2026-10-20T10:00:00.000Z",
  lastReportedAt: "2026-10-22T10:00:00.000Z",
  currentVisibility: "PUBLISHED" as const,
  targetExists: true,
  status: "OPEN" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchMyRole.mockResolvedValue({
    role: "MODERATOR",
    isAdmin: false,
    capabilities: ["reports_review", "content_hide"],
  });
  mockFetchModerationQueue.mockResolvedValue([QUEUE_ENTRY]);
  mockFetchModerationTarget.mockResolvedValue({
    targetType: "POST",
    targetId: "post-1",
    targetExists: true,
    target: { title: "Blue backpack" },
    reports: [],
    decisions: [],
  });
});

function renderScreen() {
  return render(
    <MemoryRouter>
      <ModerationQueue />
    </MemoryRouter>,
  );
}

describe("the moderation queue", () => {
  it("turns an ordinary reader away and never asks for the queue", async () => {
    mockFetchMyRole.mockResolvedValue({ role: null, isAdmin: false, capabilities: [] });
    renderScreen();
    expect(await screen.findByTestId("moderation-queue-denied")).toBeTruthy();
    expect(mockFetchModerationQueue).not.toHaveBeenCalled();
  });

  it("turns a moderator without the review permission away", async () => {
    mockFetchMyRole.mockResolvedValue({
      role: "MODERATOR",
      isAdmin: false,
      capabilities: ["content_hide"],
    });
    renderScreen();
    expect(await screen.findByTestId("moderation-queue-denied")).toBeTruthy();
    expect(mockFetchModerationQueue).not.toHaveBeenCalled();
  });

  it("lists the open cases for a moderator who may review them", async () => {
    renderScreen();
    expect(await screen.findByText(/2 reports about this report/i)).toBeTruthy();
    expect(screen.getByText(/Reasons: Harassment/)).toBeTruthy();
  });

  it("opens a case and shows the target", async () => {
    renderScreen();
    fireEvent.click(await screen.findByTestId("moderation-queue-row"));
    expect(await screen.findByText("Blue backpack")).toBeTruthy();
    expect(mockFetchModerationTarget).toHaveBeenCalledWith("POST", "post-1");
  });

  it("shows a refusal as a sentence", async () => {
    mockFetchModerationQueue.mockRejectedValue(new Error("boom"));
    renderScreen();
    await waitFor(() => expect(screen.getByTestId("moderation-queue-error")).toBeTruthy());
  });

  it("says there is nothing to review when the queue is empty", async () => {
    mockFetchModerationQueue.mockResolvedValue([]);
    renderScreen();
    expect(await screen.findByText(/nothing to review/i)).toBeTruthy();
  });

  it("says plainly that the queue is not in this build, and never calls it empty", async () => {
    mockFetchModerationQueue.mockRejectedValue(new ApiError("Could not find the function", 500, "PGRST202"));
    renderScreen();
    const unavailable = await screen.findByTestId("moderation-queue-unavailable");
    expect(unavailable.textContent).toMatch(/not available in this build/i);
    expect(screen.queryByText(/nothing to review/i)).toBeNull();
    expect(unavailable.textContent).not.toMatch(/PGRST202|schema/i);
  });
});
